#!/usr/bin/env node
/**
 * dsh-rewind 客户端半区静态回归守护（零依赖，只读 client.js，不改源码）。
 *
 * 覆盖两类 P0 级回归：
 *   1) 「用了没 inject」：扫描 client.js 里所有 `ctx.<service>` 访问（含 alias、
 *      解构、字面量下标、ctx.get("name")），与插件返回对象的 `inject: [...]`
 *      数组比对；访问了但不在 inject 里的服务 → FAIL（P0-2 那类 bug 的通用检测）。
 *   2) 「加载/挂载即崩」：用 node:vm 以浏览器 ModuleLoader 的方式执行 client.js，
 *      stub 最小 React，调用 factory(require) 得到插件对象，断言 apply 是函数、
 *      inject 是字符串数组、apply(ctx stub) 不抛异常（所有 register 返回 disposer）。
 *
 * 用法：
 *   node scripts/check-client-static.mjs              # 常规：FAIL 退出 1，WARN 只提示
 *   node scripts/check-client-static.mjs --strict     # 严格：WARN 也算失败（task-6 用）
 *   node scripts/check-client-static.mjs --file <p>   # 检查指定文件（默认仓库根 client.js）
 *   node scripts/check-client-static.mjs --json       # 机器可读输出（CI）
 *
 * 已知限制（如实降级并标注）：
 *   - 纯文本扫描，不做完整 JS 解析：`ctx[expr]` 非字面量、把 ctx 存进数组/对象后再取、
 *     跨函数把别名当参数传递后再访问，都无法静态归因 → 记为 WARN（--strict 时失败）。
 *   - 注释里出现的 `ctx.xxx` 视为注释提及，只报 INFO。
 *   - VM 沙箱只提供 apply() 需要的 stub 面；它验证“挂载即崩”，不验证槽位渲染。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const STRICT = ARGS.includes("--strict");
const JSON_OUT = ARGS.includes("--json");
const FILE_ARG = (() => {
  const i = ARGS.indexOf("--file");
  return i >= 0 ? ARGS[i + 1] : undefined;
})();
const TARGET = path.resolve(REPO, FILE_ARG ?? "client.js");

/** Cordis context 自身成员：可访问但不需要出现在插件 inject 数组里。 */
const CORDIS_BUILTINS = new Set([
  "get", "set", "provide", "effect", "on", "off", "once", "emit", "parallel", "serial",
  "bail", "waterfall", "inject", "require", "logger", "fiber", "plugin", "registry",
  "isolate", "extend", "scope", "accessor", "reflect", "root", "ctx", "runtime",
]);

const findings = { fail: [], warn: [], info: [] };
const fail = (message, detail = "") => findings.fail.push({ message, detail });
const warn = (message, detail = "") => findings.warn.push({ message, detail });
const info = (message, detail = "") => findings.info.push({ message, detail });

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function lineText(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

function isInsideBlockComment(text, index) {
  const open = text.lastIndexOf("/*", index);
  if (open === -1) return false;
  const close = text.lastIndexOf("*/", index);
  return close < open;
}

function isCommentMention(text, index) {
  const line = lineText(text, index);
  if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return true;
  return isInsideBlockComment(text, index);
}

/** Extract string literals of the plugin-level inject array from source text (fallback only). */
function staticInjectArray(source) {
  const matches = [...source.matchAll(/\binject\s*:\s*\[([^\]]*)\]/g)];
  const arrays = [];
  for (const match of matches) {
    const body = match[1];
    const raw = body.split(",").map((part) => part.trim()).filter((part) => part !== "");
    if (raw.length === 0) continue;
    const strings = raw.map((part) => {
      const literal = /^(["'`])([^"'`]*)\1$/.exec(part);
      return literal === null ? undefined : literal[2];
    });
    if (strings.every((value) => typeof value === "string")) arrays.push({ strings, index: match.index });
  }
  // 插件级 inject 一般出现在 return { inject: [...] } 里；优先最后一个纯字符串数组
  const chosen = arrays.at(-1);
  return chosen === undefined ? undefined : { inject: chosen.strings, index: chosen.index, candidates: arrays.length };
}

/** Strip line/block comments safely enough for `ctx.X` scanning (keeps strings intact). */
function scanCtxAccesses(source, aliases, entries) {
  const accessPattern = (receiver) => new RegExp(`\\b${escapeRegExp(receiver)}\\s*\\??\\s*\\.\\s*([A-Za-z_$][A-Za-z0-9_$]*)`, "g");
  const receivers = ["ctx", ...aliases];
  for (const receiver of receivers) {
    for (const match of source.matchAll(accessPattern(receiver))) {
      const name = match[1];
      const index = match.index + match[0].indexOf(".");
      if (isCommentMention(source, index)) {
        info(`注释提及 ${receiver}.${name}（不计入访问）`, `client.js:${lineOf(source, index)}`);
        continue;
      }
      if (CORDIS_BUILTINS.has(name)) {
        entries.push({ name, receiver, builtin: true, line: lineOf(source, index), snippet: lineText(source, index), kind: "dot" });
        continue;
      }
      entries.push({ name, receiver, builtin: false, line: lineOf(source, index), snippet: lineText(source, index), kind: "dot" });
    }
  }

  // 字面量下标访问：ctx["sessions"] / alias["sessions"]
  for (const receiver of receivers) {
    const bracket = new RegExp(`\\b${escapeRegExp(receiver)}\\s*\\??\\s*\\[\\s*(["'\`])([^"'\`]+)\\1\\s*\\]`, "g");
    for (const match of source.matchAll(bracket)) {
      const name = match[2];
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        warn(`字面量下标访问了非常规服务名 ${receiver}[${JSON.stringify(name)}]`, `client.js:${lineOf(source, match.index)}`);
        continue;
      }
      if (CORDIS_BUILTINS.has(name)) continue;
      entries.push({ name, receiver, builtin: false, line: lineOf(source, match.index), snippet: lineText(source, match.index), kind: "bracket" });
    }
  }

  // 非字面量下标访问：动态，无法归因
  for (const receiver of receivers) {
    const dynamic = new RegExp(`\\b${escapeRegExp(receiver)}\\s*\\??\\s*\\[\\s*(?!["'\`])`, "g");
    for (const match of source.matchAll(dynamic)) {
      if (isCommentMention(source, match.index)) continue;
      warn(`检测到动态下标访问 ${receiver}[...]，无法静态归因（已知限制）`, `client.js:${lineOf(source, match.index)}`);
    }
  }

  // 解构：const { slots, sessions: s } = ctx
  for (const match of source.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*ctx\b/g)) {
    for (const part of match[1].split(",")) {
      const picked = part.trim().split(":")[0].trim();
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(picked)) continue;
      if (CORDIS_BUILTINS.has(picked)) continue;
      entries.push({ name: picked, receiver: "ctx", builtin: false, line: lineOf(source, match.index), snippet: lineText(source, match.index), kind: "destructure" });
    }
  }
}

/** Minimal React good enough for the module factory body (no rendering is performed). */
function makeReactStub() {
  class Component {
    constructor(props) { this.props = props ?? {}; this.state = {}; }
    setState(next) { this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) }; }
    render() { return null; }
  }
  return {
    Component,
    PureComponent: Component,
    Fragment: "Fragment",
    createElement: () => null,
    cloneElement: (element) => element,
    useState: (value) => [typeof value === "function" ? value() : value, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useContext: (context) => context?._value,
    createContext: (value) => ({ _value: value, Provider: ({ children }) => children ?? null, Consumer: () => null }),
    memo: (fn) => fn,
    forwardRef: (fn) => fn,
  };
}

function makeDomStub() {
  const element = () => ({
    style: {},
    textContent: "",
    value: "",
    tagName: "DIV",
    isContentEditable: false,
    appendChild() {}, removeChild() {}, remove() {}, select() {}, focus() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  });
  return {
    createElement: element,
    createTextNode: () => element(),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
    body: element(),
    head: element(),
    documentElement: element(),
    activeElement: null,
    readyState: "complete",
  };
}

function makeCtxStub(pluginInject) {
  const disposer = () => () => {};
  const services = {};
  const slotRegistrations = [];
  const eventDefinitions = [];
  const known = {
    slots: {
      inject(channel, callback) {
        const result = typeof callback === "function" ? callback() : undefined;
        return typeof result === "function" ? result : disposer;
      },
      register(config, render) {
        slotRegistrations.push({ config, render });
        return disposer;
      },
      list: () => [],
    },
    sessions: {
      binding: () => undefined,
      scope: () => ({}),
      create: async () => "stub-session",
      fork: async () => "stub-session",
      list: { getSnapshot: () => ({ byId: {}, items: [] }) },
    },
    workspaces: {
      archiveSession: async () => true,
      list: { getSnapshot: () => ({ items: [] }) },
    },
    uiWorkspace: { openSession: () => true },
    uiConversation: {
      events: {
        register(definition) { eventDefinitions.push(definition); return disposer; },
      },
    },
    locale: {
      register: () => disposer,
      t: (key) => String(key),
      tFor: () => (key) => String(key),
    },
    conversation: {
      input: { for: () => ({ setDraft: () => true }) },
    },
  };
  known.uiWorkspace = known.uiWorkspace ?? { openSession: () => true };

  const registerCalls = [];
  for (const name of pluginInject) {
    services[name] = known[name] ?? {
      // 未知 inject 名称给一个“什么都能点”的宽松 stub，避免误伤
      event: { register: () => disposer },
      register: () => disposer,
    };
  }
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fiber: { effect: () => disposer },
    get(name) { return known[name] ?? services[name] ?? { register: () => disposer }; },
    inject() { return disposer; },
    require() { return {}; },
    effect(execute) {
      const result = execute();
      registerCalls.push("effect");
      return typeof result === "function" ? result : disposer;
    },
    on() { return disposer; },
    ...services,
  };
  // 把 plugin.inject 里的服务挂到 ctx 名字上（上面 spread services 已覆盖）
  for (const [name, value] of Object.entries(services)) {
    if (ctx[name] === undefined) ctx[name] = value;
  }
  return { ctx, registerCalls, slotRegistrations, eventDefinitions };
}

/**
 * Render-level degradation smoke: invoke every slot render callback and the
 * Event Definition callbacks with the host-guaranteed minimum props (t + ctx)
 * plus hostile/absent snapshots. The host injects `t` via `locale: NS` and the
 * session hook via slot scope, so `{}` entirely-empty props is NOT a supported
 * contract input (counted separately as a note, not a failure).
 */
function runRenderSmoke(slotRegistrations, eventDefinitions, ctx) {
  const failures = [];
  const t = (key, params) => `${String(key)}${params === undefined ? "" : `|${JSON.stringify(params)}`}`;
  const snapshots = [
    ["missing useChat", undefined],
    ["empty snapshot", (select) => select({})],
    ["null snapshot", (select) => select(null)],
    ["throwing snapshot", (select) => select(new Proxy({}, { get() { throw new Error("snapshot boom"); } }))],
    ["malformed chat snapshot", (select) => select({ nodes: new Map(), timeline: {}, locations: { getTurn() { return []; } } })],
  ];
  for (const { config, render } of slotRegistrations) {
    const label = `${config?.name ?? "?"}:${config?.id ?? config?.key ?? "?"}`;
    if (typeof render !== "function") continue;
    for (const [scenario, useChat] of snapshots) {
      const props = {
        sessionId: "smoke-session",
        t,
        ctx,
        node: { key: "smoke-node", data: { seq: 1 } },
        ...(useChat === undefined ? {} : { useChat }),
      };
      try {
        render(props);
      } catch (error) {
        failures.push(`${label} / ${scenario}：${error.message}`);
      }
    }
  }
  let emptyPropsThrows = 0;
  for (const { render } of slotRegistrations) {
    if (typeof render !== "function") continue;
    try { render({}); } catch { emptyPropsThrows += 1; }
  }
  for (const definition of eventDefinitions) {
    try {
      for (const event of [undefined, null, {}, { type: "user/message" }, { type: "user/message", surfaceOp: "replace" }, { type: "user/message", data: { source: { kind: "user" } } }]) {
        definition.match?.(event);
      }
      const built = definition.buildViewNode?.({ state: undefined, key: "smoke-key", id: "smoke-id", start: undefined, matches: [] });
      if (built !== undefined && built !== null) failures.push(`Event Definition buildViewNode(undefined state) 应返回 null/undefined，实际=${JSON.stringify(built)}`);
    } catch (error) {
      failures.push(`Event Definition：${error.message}`);
    }
  }
  return { failures, slotCount: slotRegistrations.length, definitionCount: eventDefinitions.length, emptyPropsThrows };
}

async function main() {
  let source;
  try {
    source = await readFile(TARGET, "utf8");
  } catch (error) {
    console.error(`[check-client-static] 读取 ${TARGET} 失败：${error.message}`);
    return 1;
  }
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  console.log(`[check-client-static] file=${TARGET}`);
  console.log(`[check-client-static] bytes=${Buffer.byteLength(source)} sha256=${digest} strict=${STRICT}`);

  // ---------- 1) 静态扫描 ----------
  const aliases = new Set();
  for (const match of source.matchAll(/(?:^|[;{}()\s,])([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*ctx\s*(?=[;,\n)])/g)) {
    if (match[1] !== "ctx") aliases.add(match[1]);
  }
  const entries = [];
  scanCtxAccesses(source, [...aliases], entries);
  const accesses = entries.filter((entry) => entry.builtin === false);
  const accessByName = new Map();
  for (const entry of accesses) {
    const list = accessByName.get(entry.name) ?? [];
    list.push(entry);
    accessByName.set(entry.name, list);
  }

  // ctx.get("literal")：cordis 合法路径，不要求 inject，仅 INFO
  for (const match of source.matchAll(/\bctx\s*\.\s*get\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)) {
    const name = match[2];
    info(`ctx.get(${JSON.stringify(name)})（get 不要求 inject）`, `client.js:${lineOf(source, match.index)}`);
  }

  // ---------- 2) VM 加载 + apply 冒烟 ----------
  let plugin;
  let vmError;
  let vmInject;
  const entry = { id: undefined, factoryType: undefined };
  try {
    const entries = [];
    const sandbox = {
      window: {
        __ModuleLoader__: { load: (loaded) => entries.push(loaded) },
        addEventListener() {}, removeEventListener() {},
      },
      document: makeDomStub(),
      localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      navigator: { clipboard: { writeText: async () => true } },
      console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
      fetch: async () => { throw new Error("sandbox: fetch 不可用"); },
      setTimeout, clearTimeout, setInterval, clearInterval,
      URL, URLSearchParams,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: TARGET, timeout: 10_000 });
    if (entries.length === 0) throw new Error("window.__ModuleLoader__.load 未被调用（不是 DSH client bundle）");
    if (entries.length > 1) warn(`bundle 注册了 ${entries.length} 个入口（预期 1 个）`);
    const loaded = entries.find((item) => item?.factory !== undefined);
    if (loaded === undefined) throw new Error("ModuleLoader 入口缺少 factory()");
    entry.id = loaded.id;
    entry.factoryType = typeof loaded.factory;
    if (entry.factoryType !== "function") throw new Error(`entry.factory 类型=${entry.factoryType}（预期 function）`);
    const React = makeReactStub();
    plugin = loaded.factory((specifier) => {
      if (specifier === "react") return React;
      if (specifier === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: "Fragment" };
      throw new Error(`client bundle 请求了 package.json 未声明的外部依赖：${specifier}`);
    });
    if (plugin === null || typeof plugin !== "object") throw new Error(`factory 返回值不是对象：${typeof plugin}`);
    vmInject = plugin.inject;
  } catch (error) {
    vmError = error;
  }

  const inject = Array.isArray(vmInject) ? vmInject.filter((value) => typeof value === "string") : undefined;
  const staticInject = staticInjectArray(source);
  for (const [index, name] of (inject ?? []).entries()) {
    if (inject.indexOf(name) !== index) warn(`inject 数组有重复项 ${name}`);
  }
  if (inject !== undefined && staticInject !== undefined) {
    const same = inject.length === staticInject.inject.length && inject.every((value, index) => value === staticInject.inject[index]);
    if (!same) warn(`VM 得到的 inject=${JSON.stringify(inject)} 与静态解析=${JSON.stringify(staticInject.inject)} 不一致`);
    else info(`inject 静态/VM 一致：${JSON.stringify(inject)}`);
  }

  // ---------- 3) 比对 ----------
  const missing = [...accessByName.keys()].filter((name) => inject === undefined || !inject.includes(name));
  if (inject === undefined) {
    if (vmError !== undefined) {
      // VM 失败时无法拿到权威 inject：退回静态解析
      if (staticInject !== undefined) {
        warn(`VM 加载失败，inject 退回静态解析=${JSON.stringify(staticInject.inject)}`, vmError.message);
        for (const name of [...accessByName.keys()]) {
          if (!staticInject.inject.includes(name)) {
            fail(`访问了 ctx.${name} 但不在 plugin.inject 里（静态解析）`, accessByName.get(name).slice(0, 3).map((item) => `client.js:${item.line} ${item.snippet}`).join("\n"));
          }
        }
      } else {
        fail("无法取得 plugin.inject（VM 加载失败且静态解析失败）", vmError.message);
      }
    }
  } else {
    for (const name of missing) {
      fail(
        `访问了 ctx.${name} 但不在 plugin.inject 里`,
        accessByName.get(name).slice(0, 4).map((item) => `client.js:${item.line} [${item.kind}/${item.receiver}] ${item.snippet}`).join("\n"),
      );
    }
  }

  // ---------- 4) VM 契约断言 ----------
  if (vmError !== undefined) {
    fail("以浏览器 ModuleLoader 方式加载 client.js 失败", vmError.stack?.split("\n").slice(0, 4).join("\n") ?? vmError.message);
  } else {
    if (typeof plugin.apply !== "function") fail(`plugin.apply 不是函数（实际 ${typeof plugin.apply}）`);
    if (!Array.isArray(vmInject)) fail(`plugin.inject 不是数组（实际 ${JSON.stringify(vmInject)}）`);
    else if (vmInject.some((value) => typeof value !== "string")) fail(`plugin.inject 含非字符串项：${JSON.stringify(vmInject)}`);
    if (Array.isArray(vmInject) && vmInject.length === 0) warn("plugin.inject 是空数组");

    if (typeof plugin.apply === "function") {
      const stub = makeCtxStub(Array.isArray(vmInject) ? vmInject.filter((value) => typeof value === "string") : []);
      const applyStartedAt = Date.now();
      try {
        plugin.apply(stub.ctx);
        info(`apply(ctx stub) 通过（${Date.now() - applyStartedAt}ms；registrations: slots=${stub.slotRegistrations.length} events=${stub.eventDefinitions.length}）`);
        const smoke = runRenderSmoke(stub.slotRegistrations, stub.eventDefinitions, stub.ctx);
        for (const message of smoke.failures) fail(`渲染回调在服务/快照缺失时抛异常`, message);
        info(`渲染降级冒烟：${smoke.slotCount} 个 slot 渲染回调 × 5 种快照/useChat 场景 + ${smoke.definitionCount} 个 Event Definition 均未抛异常`);
        if (smoke.emptyPropsThrows > 0) {
          info(`${smoke.emptyPropsThrows} 个渲染回调在“连 t 都没有”的空 props 下会抛；宿主按 locale:NS 注入 t，不属契约路径`);
        }
      } catch (error) {
        fail("plugin.apply(ctx stub) 抛异常（挂载即崩）", error.stack?.split("\n").slice(0, 6).join("\n") ?? error.message);
      }
    }
  }

  // ---------- 5) 输出 ----------
  const accessed = [...accessByName.entries()].map(([name, list]) => `${name}×${list.length}`).join(", ") || "(无)";
  const builtins = [...new Set(entries.filter((item) => item.builtin).map((item) => item.name))].sort();
  console.log(`\n1) 静态扫描（client.js 文本）`);
  console.log(`   alias=${[...aliases].length ? [...aliases].join(", ") : "(无)"}`);
  console.log(`   服务访问：${accessed}`);
  console.log(`   已排除 cordis 内置/方法：${builtins.length ? builtins.join(", ") : "(无)"}`);
  console.log(`   plugin.inject：${inject === undefined ? "(未取得)" : JSON.stringify(inject)}`);

  console.log(`\n2) VM 加载 / apply 冒烟`);
  console.log(`   entry.id=${entry.id ?? "(未捕获)"}  factory=${entry.factoryType ?? "(未捕获)"}`);
  if (vmError !== undefined) console.log(`   VM 错误：${vmError.message.split("\n")[0]}`);

  console.log(`\n3) 结论`);
  for (const item of findings.fail) console.log(`   ❌ FAIL ${item.message}${item.detail ? `\n      ${item.detail.replace(/\n/g, "\n      ")}` : ""}`);
  for (const item of findings.warn) console.log(`   ⚠️  WARN ${item.message}${item.detail ? `\n      ${item.detail.replace(/\n/g, "\n      ")}` : ""}`);
  for (const item of findings.info) console.log(`   ℹ️  INFO ${item.message}${item.detail ? ` — ${item.detail}` : ""}`);

  const failed = findings.fail.length > 0 || (STRICT && findings.warn.length > 0);
  if (JSON_OUT) {
    console.log(JSON.stringify({
      file: TARGET,
      sha256: digest,
      inject: inject ?? null,
      accesses: Object.fromEntries([...accessByName.entries()].map(([name, list]) => [name, list.map((item) => item.line)])),
      fail: findings.fail,
      warn: findings.warn,
      info: findings.info,
      status: failed ? "FAIL" : "PASS",
    }, null, 2));
  }
  console.log(`\n[check-client-static] ${failed ? "FAIL" : "PASS"}（FAIL=${findings.fail.length} WARN=${findings.warn.length} INFO=${findings.info.length}${STRICT ? "，strict" : ""}）`);
  return failed ? 1 : 0;
}

process.exitCode = await main().catch((error) => {
  console.error(`[check-client-static] 致命错误：${error.stack ?? error.message}`);
  return 1;
});
