#!/usr/bin/env node
/**
 * dsh-rewind Host 半区单测：用最小假 cordis ctx 直接驱动 index.js 的 apply()。
 *
 * 零依赖（只用 Node 内置模块）。每个用例在 mkdtemp 隔离的 DSH_HOME 与工作区里跑，
 * 不触碰真实 ~/.dsh、不联网、不改源码。
 *
 * 用法：
 *   node scripts/test-host.mjs                 # 常规：已知缺陷记为 XFAIL，退出码只反映意外失败
 *   node scripts/test-host.mjs --strict        # 严格：已知缺陷仍复现也算失败（task-6 验收用）
 *   node scripts/test-host.mjs -k restore      # 只跑名字包含子串的用例
 *   node scripts/test-host.mjs --list          # 列出用例
 *
 * 退出码：0 = 通过（--strict 时还要求已知缺陷全部消失）；1 = 有失败。
 *
 * 假 ctx 契约（按 DSH 0.2.1-rc.2 真实实现建模，源码抽取自 app.asar）：
 *   ctx.effect(fn,label)      立即执行 fn，收集其返回的 disposer
 *   ctx.on(event,handler)     返回 disposer；session/event 的 handler 签名 (session,event)
 *   ctx.get(name)             读服务（sessionPersistence 等）
 *   ctx.sessions.get(id)      live Session：header.cwd、snapshotEvents()（没有 .events）
 *   ctx.webServer.register()  收集 {kind,path,handler}，返回 disposer
 *   ctx.connection            Host Connection 服务：requestRejection(req) -> 401/403/undefined
 *
 * 已发现的真实缺陷（见 docs/test-report.md）用 knownBug 标记：
 *   BUG-1  restore(atSeq) 在 0.2.1 上退化为 baseline（eventsOf 读 live.events，真实 Session 无此属性）
 *   BUG-2  非 live 会话读不到 cwd/events（sessionPersistence.inspect() 在 0.2.1 不存在）
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname), "..");
const INDEX = join(REPO, "index.js");
const ARGS = process.argv.slice(2);
const STRICT = ARGS.includes("--strict");
const LIST_ONLY = ARGS.includes("--list");
const FILTER = (() => {
  const i = ARGS.indexOf("-k");
  return i >= 0 ? ARGS[i + 1] : undefined;
})();

const KNOWN_BUGS = {
  "BUG-1": "restore(atSeq) 在真实 0.2.1 宿主上退化为 baseline：eventsOf() 读 live.events，而 @deepseek-ai/dsh-session 的 Session 只暴露 snapshotEvents()/ownEvents()。结果：回退到任意非首轮提问都会还原成最初 baseline，而不是上一轮检查点。",
  "BUG-2": "非 live（已归档/冷）会话无法建立 store：workspaceRootOf()/eventsOf() 调用 sessionPersistence.inspect(id)，DSH 0.2.1-rc.2 的持久化服务只有 create/open/stat/list/flush，没有 inspect。异常被静默吞掉 → 不跟踪、restore 返回 mode:none。",
};

// ---------------------------------------------------------------------------
// tiny runner
// ---------------------------------------------------------------------------
const cases = [];
function defineCase(name, fn, opts = {}) {
  cases.push({ name, fn, ...opts });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(probe, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(10);
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}${lastError ? `；最后一次探测异常：${lastError.message}` : ""}`);
}

async function main() {
  const selected = cases.filter((c) => !FILTER || c.name.includes(FILTER));
  if (LIST_ONLY) {
    for (const c of selected) console.log(`- ${c.name}${c.knownBug ? `  [${c.knownBug} XFAIL]` : ""}`);
    return 0;
  }
  console.log(`[test-host] index=${INDEX}`);
  console.log(`[test-host] node=${process.version} 工作目录=${process.cwd()} strict=${STRICT}`);
  console.log(`[test-host] 用例数=${selected.length}${FILTER ? `（过滤 -k ${FILTER}）` : ""}\n`);

  const rows = [];
  for (const c of selected) {
    const env = await makeEnv();
    const startedAt = Date.now();
    let row;
    try {
      await c.fn(env);
      row = { ...c, status: "pass" };
    } catch (error) {
      row = { ...c, status: c.knownBug ? "xfail" : "fail", error };
    } finally {
      await env.cleanup();
    }
    row.ms = Date.now() - startedAt;
    rows.push(row);
    const icon = row.status === "pass" ? "✅" : row.status === "xfail" ? "⚠️ " : "❌";
    const tag = row.knownBug ? ` [${row.knownBug}${row.status === "xfail" ? " 复现" : " 已消失"}]` : "";
    console.log(`${icon} ${row.name}${tag} (${row.ms}ms)`);
    if (row.status === "xfail") {
      console.log(`    已知缺陷：${KNOWN_BUGS[row.knownBug] ?? row.knownBug}`);
      console.log(`    断言：${firstLine(row.error?.message)}`);
    } else if (row.status === "fail") {
      console.log(`    ${(row.error?.stack ?? String(row.error)).split("\n").slice(0, 12).join("\n    ")}`);
    }
  }

  const passed = rows.filter((r) => r.status === "pass");
  const xfails = rows.filter((r) => r.status === "xfail");
  const failed = rows.filter((r) => r.status === "fail");
  console.log(`\n[test-host] 结果：${passed.length} 通过 / ${xfails.length} 已知缺陷复现(XFAIL) / ${failed.length} 失败（共 ${rows.length}）`);
  if (xfails.length > 0) {
    for (const r of xfails) console.log(`  ⚠️  ${r.knownBug}: ${r.name}`);
    if (!STRICT) console.log("  （已知缺陷不参与退出码；用 --strict 让它们算失败）");
  }
  if (failed.length > 0 || (STRICT && xfails.length > 0)) return 1;
  return 0;
}

function firstLine(text) {
  return String(text ?? "").split("\n")[0];
}

// ---------------------------------------------------------------------------
// case environment: isolated DSH_HOME + scratch dirs
// ---------------------------------------------------------------------------
async function makeEnv() {
  const root = await mkdtemp(join(tmpdir(), "dsh-rewind-unit-"));
  const home = join(root, "dsh-home");
  await mkdir(home, { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const disposers = [];
  let pluginLoaded = false;

  const env = {
    root,
    home,
    /** Create (or reuse) a workspace dir under the scratch root. */
    async ws(name = "ws") {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    /** Write <DSH_HOME>/storages/dsh-rewind/config.json before apply(). */
    async writeConfig(config) {
      const dir = join(home, "storages", "dsh-rewind");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "config.json"), JSON.stringify(config));
    },
    /** Load index.js freshly (no ESM cache across cases) and apply() it to a mock ctx.
     *  默认提供放行的 connection 服务；传 connection:null 表示服务缺失（测 fail-closed 503）。 */
    async start(opts = {}) {
      const module = await import(`${pathToFileURL(INDEX).href}?case=${Date.now()}-${Math.random()}`);
      pluginLoaded = true;
      let connection;
      if (!Object.hasOwn(opts, "connection")) connection = { requestRejection: () => undefined };
      else if (opts.connection === null) connection = undefined;
      else connection = opts.connection;
      const mock = createMockContext({ ...opts, connection });
      for (const session of opts.sessions ?? []) mock.sessions.set(session.header.id, session);
      const returned = module.apply(mock.ctx);
      mock.applyReturned = returned;
      disposers.push(() => mock.disposeAll());
      return { mock, module };
    },
    async cleanup() {
      for (const dispose of disposers.reverse()) {
        try { await dispose(); } catch { /* ignore */ }
      }
      await sleep(30); // 让被 dispose 后仍在跑的 promise 落定，避免删目录时抢跑
      try { await rm(root, { recursive: true, force: true }); } catch { /* ignore */ }
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    },
  };
  return env;
}

// ---------------------------------------------------------------------------
// mock cordis ctx (0.2.1-rc.2 contracts; see header comment)
// ---------------------------------------------------------------------------
function createMockContext({ connection, sessionPersistence } = {}) {
  const handlers = new Map();
  const routes = [];
  const logs = [];
  const disposers = [];
  const sessions = new Map();
  const services = new Map();
  if (connection !== undefined) services.set("connection", connection);
  if (sessionPersistence !== undefined) services.set("sessionPersistence", sessionPersistence);

  const pushLog = (level) => (...args) => logs.push({ level, message: args.map((v) => (typeof v === "string" ? v : String(v))).join(" ") });
  const logger = { debug: pushLog("debug"), info: pushLog("info"), warn: pushLog("warn"), error: pushLog("error") };

  const ctx = {
    logger,
    effect(execute) {
      const disposable = execute();
      if (typeof disposable === "function") disposers.push(disposable);
      return disposable;
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event);
        if (current === undefined) return;
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    get(name) { return services.get(name); },
    sessions: {
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    connection,
  };

  const mock = {
    ctx,
    sessions,
    routes,
    logs,
    handlers,
    applyReturned: undefined,
    /** Fire one session/event at every registered listener (handler is sync fire-and-forget in index.js). */
    emit(session, event) {
      if (session?._events !== undefined) session._events.push(event);
      for (const handler of handlers.get("session/event") ?? []) handler(session, event);
    },
    disposeAll() {
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch { /* ignore */ }
      }
      disposers.length = 0;
    },
    apiRoute() {
      const route = routes.find((r) => r.kind === "prefix" && r.path === "/dsh-rewind/api");
      assert.ok(route, `未注册 prefix 路由 /dsh-rewind/api；已注册路由=${JSON.stringify(routes.map((r) => ({ kind: r.kind, path: r.path })))}`);
      return route;
    },
    /** Drive the registered HTTP handler with a fake req/res. */
    async api(method, payload, opts = {}) {
      const route = this.apiRoute();
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      const req = makeReq({
        method: opts.method ?? "POST",
        url: opts.url ?? `/dsh-rewind/api/${method}`,
        body,
        headers: opts.headers,
      });
      const res = makeRes();
      await route.handler(req, res);
      let json;
      try { json = res.body === "" ? undefined : JSON.parse(res.body); } catch { /* non-json */ }
      return { status: res.statusCode, headers: res.headers, body: res.body, json };
    },
    warnings() { return logs.filter((entry) => entry.level === "warn").map((entry) => entry.message); },
  };
  return mock;
}

function makeReq({ method, url, body = "", headers = {} }) {
  const chunks = body === "" ? [] : [Buffer.from(body)];
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    finished: false,
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    getHeader(name) { return res.headers[name.toLowerCase()]; },
    writeHead(status, headers) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
    },
    write(chunk) { res.body += String(chunk); },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk);
      res.finished = true;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// fixtures: 0.2.1-shaped live Session / persistence service
// ---------------------------------------------------------------------------
function mkSession({ id = "session-1", cwd, events = [], legacyEvents = false, origin } = {}) {
  const header = { version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, ...(origin === undefined ? {} : { origin }) };
  const session = {
    _events: events,
    header,
    get id() { return header.id; },
    // DSH 0.2.1 Session: only snapshotEvents()/ownEvents(); NO .events
    snapshotEvents() { return [...events]; },
    ownEvents() { return [...events]; },
    get seq() { return events.length; },
  };
  if (legacyEvents) {
    // 0.1.x / 旧插件假设：live Session 暴露 .events。仅用于隔离测试 restore 算法本身。
    Object.defineProperty(session, "events", { get() { return events; }, enumerable: false });
  }
  return session;
}

/** Minimal 0.2.1 sessionPersistence: create/open/stat/list/flush (no inspect). */
function mkPersistence(records) {
  const map = new Map(records.map((record) => [record.header.id, record]));
  return {
    async create() { throw new Error("mock: create() 未实现"); },
    async open(id, mode = "read") {
      const record = map.get(id);
      if (record === undefined) throw new Error(`mock persistence: unknown session ${id}`);
      return {
        mode,
        async read() { return { eventState: "detached", events: record.events }; },
        async append() { throw new Error("mock: append() 未实现"); },
        async flush() {},
        async close() {},
      };
    },
    async stat(id) {
      const record = map.get(id);
      if (record === undefined) throw new Error(`mock persistence: unknown session ${id}`);
      return { header: record.header, revision: "rev-1" };
    },
    async list() { return [...map.values()].map((record) => ({ header: record.header, revision: "rev-1" })); },
    async flush() {},
  };
}

/** Legacy 0.1.x-era persistence surface: inspect(id) -> {meta:{cwd}, events}. */
function mkLegacyPersistence(records) {
  const map = new Map(records.map((record) => [record.header.id, record]));
  return {
    async inspect(id) {
      const record = map.get(id);
      if (record === undefined) throw new Error(`mock legacy persistence: unknown session ${id}`);
      return { meta: { cwd: record.header.cwd }, events: record.events };
    },
  };
}

function ev(type, seq, data) {
  return { type, seq, time: 1_700_000_000_000 + seq, data };
}
function turnStart(seq, turn) { return ev("turn/start", seq, { turn }); }
function turnEnd(seq, turn) { return ev("turn/end", seq, { turn, reason: { kind: "completed" } }); }

// ---------------------------------------------------------------------------
// filesystem helpers (with diagnostics)
// ---------------------------------------------------------------------------
function storeDir(env, sessionId) {
  return join(env.home, "storages", "dsh-rewind", sessionId);
}
function baselinePath(env, sessionId) { return join(storeDir(env, sessionId), "baseline.json"); }
function turnPath(env, sessionId, turn) { return join(storeDir(env, sessionId), `turn-${turn}.json`); }
function blobsDir(env, sessionId) { return join(storeDir(env, sessionId), "blobs"); }

async function readJsonFile(path) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`读取 ${path} 失败：${error.code ?? error.message}`); }
  try { return JSON.parse(text); }
  catch { throw new Error(`${path} 不是合法 JSON：${text.slice(0, 400)}`); }
}

async function waitForFile(path, what) {
  return waitFor(async () => {
    try { await stat(path); return true; } catch { return false; }
  }, `${what}（${path}）`);
}

async function assertFileEquals(path, expected, label) {
  let actual;
  try { actual = await readFile(path, "utf8"); }
  catch (error) { throw new Error(`${label}: 读取 ${path} 失败（${error.code ?? error.message}）`); }
  assert.equal(actual, expected, `${label}: 文件内容不符\n  path=${path}\n  期望=${JSON.stringify(expected)}\n  实际=${JSON.stringify(actual)}`);
}

async function fileTree(root) {
  const rows = [];
  const walk = async (dir, prefix = "") => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else rows.push(rel);
    }
  };
  await walk(root);
  return rows.sort();
}

async function dumpApi(label, result) {
  return `${label}: HTTP ${result.status} body=${String(result.body).slice(0, 500)}`;
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
function git(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile("git", args, { cwd, timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, code: error?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

async function initGitRepo(cwd) {
  assert.ok((await git(cwd, ["init", "-q"])).ok, "git init 失败");
  assert.ok((await git(cwd, ["config", "user.email", "rewind-test@example.invalid"])).ok, "配置 git user.email 失败");
  assert.ok((await git(cwd, ["config", "user.name", "rewind test"])).ok, "配置 git user.name 失败");
  await writeFile(join(cwd, "seed.txt"), "seed\n");
  assert.ok((await git(cwd, ["add", "-A"])).ok, "git add 失败");
  assert.ok((await git(cwd, ["commit", "-q", "-m", "seed"])).ok, "git commit 失败");
}

// ===========================================================================
// cases
// ===========================================================================

defineCase("exports: name / inject / apply", async (env) => {
  const { module } = await env.start();
  assert.equal(module.name, "dsh-rewind");
  assert.deepEqual(module.inject, ["webServer", "sessions", "connection"]);
  assert.equal(typeof module.apply, "function");
});

defineCase("baseline: 首个事件建立 baseline，忽略 .git/node_modules/.gitignore 项", async (env) => {
  const ws = await env.ws();
  await writeFile(join(ws, ".gitignore"), "*.log\nsecret/\n");
  await writeFile(join(ws, "a.txt"), "A1");
  await mkdir(join(ws, "node_modules"));
  await writeFile(join(ws, "node_modules", "dep.js"), "dep");
  await mkdir(join(ws, "secret"));
  await writeFile(join(ws, "secret", "s.txt"), "s");
  await mkdir(join(ws, ".git"));
  await writeFile(join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(ws, "noisy.log"), "log");

  const session = mkSession({ id: "s-baseline", cwd: ws });
  const { mock } = await env.start({ sessions: [session] });
  mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-baseline"), "baseline.json 落盘");

  const baseline = await readJsonFile(baselinePath(env, "s-baseline"));
  assert.equal(baseline.kind, "baseline");
  assert.equal(baseline.turn, 0);
  assert.deepEqual(Object.keys(baseline.files).sort(), [".gitignore", "a.txt"]);

  // CAS 内容真的进了 blobs/
  const blobFiles = await readdir(blobsDir(env, "s-baseline"));
  assert.ok(blobFiles.includes(baseline.files["a.txt"].sha), `blobs 里应有 a.txt 的内容对象；实际=${blobFiles.join(",")}`);
  const blob = await readFile(join(blobsDir(env, "s-baseline"), baseline.files["a.txt"].sha), "utf8");
  assert.equal(blob, "A1", "baseline blob 内容应为 A1");

  // 忽略项不产生 blobs
  assert.equal(baseline.files["secret/s.txt"], undefined, "gitignore 目录不应入 baseline");
  assert.equal(baseline.files["noisy.log"], undefined, "gitignore 模式不应入 baseline");
  assert.equal(baseline.files["node_modules/dep.js"], undefined, "node_modules 不应入 baseline");
});

defineCase("turn/end: checkpoint 落盘、changed 统计、重复事件幂等", async (env) => {
  const ws = await env.ws();
  await writeFile(join(ws, "a.txt"), "A1");
  const session = mkSession({ id: "s-ckpt", cwd: ws });
  const { mock } = await env.start({ sessions: [session] });

  mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-ckpt"), "baseline");
  await writeFile(join(ws, "a.txt"), "A2");
  await writeFile(join(ws, "b.txt"), "B1");
  mock.emit(session, turnEnd(1, 1));
  await waitForFile(turnPath(env, "s-ckpt", 1), "turn-1.json");

  const checkpoint = await readJsonFile(turnPath(env, "s-ckpt", 1));
  assert.equal(checkpoint.kind, "turn");
  assert.equal(checkpoint.turn, 1);
  assert.equal(checkpoint.endSeq, 1);
  assert.ok(checkpoint.files["a.txt"].sha !== undefined, "a.txt 应有 sha");
  assert.ok(checkpoint.files["b.txt"].sha !== undefined, "b.txt 应有 sha");

  // 相同 turn/end 重放：不重复写、list 不重复
  const before = await readFile(turnPath(env, "s-ckpt", 1), "utf8");
  mock.emit(session, turnEnd(1, 1));
  await sleep(60);
  assert.equal(await readFile(turnPath(env, "s-ckpt", 1), "utf8"), before, "重放同一 turn/end 不应改写检查点");

  const api = await mock.api("checkpoints", { sessionId: "s-ckpt" });
  assert.equal(api.status, 200, await dumpApi("checkpoints", api));
  assert.equal(api.json.ok, true);
  const value = api.json.value;
  assert.equal(value.tracking, true);
  assert.equal(value.hasBaseline, true);
  assert.equal(value.checkpoints.length, 1, `checkpoints 应为 1 条，实际=${JSON.stringify(value.checkpoints)}`);
  assert.equal(value.checkpoints[0].turn, 1);
  assert.equal(value.checkpoints[0].endSeq, 1);
  assert.equal(value.checkpoints[0].changed, 2, `首轮 changed 应为 a.txt+b.txt=2，实际=${value.checkpoints[0].changed}`);
});

defineCase("restore(atSeq): 还原到上一轮检查点、删除新增文件、恢复被删文件、忽略项不动", async (env) => {
  const ws = await env.ws();
  await writeFile(join(ws, ".gitignore"), "*.log\n");
  await writeFile(join(ws, "a.txt"), "A1");
  await writeFile(join(ws, "ignored.log"), "keep-1");
  const events = [];
  // legacyEvents=true：mock 提供 .events，隔离验证 restore 算法本身（真实 0.2.1 分支见 BUG-1 用例）
  const session = mkSession({ id: "s-restore", cwd: ws, events, legacyEvents: true });
  const { mock } = await env.start({ sessions: [session] });

  mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-restore"), "baseline");
  await writeFile(join(ws, "a.txt"), "A2");
  await writeFile(join(ws, "b.txt"), "B1");
  mock.emit(session, turnEnd(1, 1));
  await waitForFile(turnPath(env, "s-restore", 1), "turn-1");

  mock.emit(session, turnStart(2, 2));
  await writeFile(join(ws, "a.txt"), "A3");
  await writeFile(join(ws, "c.txt"), "C1");
  await rm(join(ws, "b.txt"));
  await writeFile(join(ws, "ignored.log"), "keep-2");
  mock.emit(session, turnEnd(3, 2));
  await waitForFile(turnPath(env, "s-restore", 2), "turn-2");

  // 回退到 turn 1 结束点（客户端传的就是上一轮 turn/end 的 seq）
  const result = await mock.api("restore", { sessionId: "s-restore", atSeq: 1, dryRun: false });
  assert.equal(result.status, 200, await dumpApi("restore atSeq=1", result));
  const restored = result.json.value;
  assert.equal(restored.mode, "turn", `期望 mode=turn，实际=${JSON.stringify(restored)}`);
  assert.deepEqual(restored.boundary, { turn: 1, endSeq: 1 }, `boundary 不符：${JSON.stringify(restored.boundary)}`);
  assert.equal(restored.dryRun, false);

  await assertFileEquals(join(ws, "a.txt"), "A2", "a.txt 应还原到 turn1 结束状态");
  await assertFileEquals(join(ws, "b.txt"), "B1", "turn2 删除的 b.txt 应被恢复");
  assert.equal(existsSync(join(ws, "c.txt")), false, "turn2 新增的 c.txt 应被删除");
  await assertFileEquals(join(ws, "ignored.log"), "keep-2", "被 .gitignore 忽略的文件不参与还原（保持现状）");
  assert.ok(restored.restored.includes("a.txt"), `restored 应包含 a.txt：${JSON.stringify(restored.restored)}`);
  assert.ok(restored.deleted.includes("c.txt"), `deleted 应包含 c.txt：${JSON.stringify(restored.deleted)}`);

  // 再回到 baseline
  const base = await mock.api("restore", { sessionId: "s-restore", baseline: true });
  assert.equal(base.status, 200, await dumpApi("restore baseline", base));
  assert.equal(base.json.value.mode, "baseline");
  await assertFileEquals(join(ws, "a.txt"), "A1", "baseline 应还原 A1");
  assert.equal(existsSync(join(ws, "b.txt")), false, "baseline 应删除 b.txt");
});

defineCase("restore dryRun: 只预览不落盘", async (env) => {
  const ws = await env.ws();
  await writeFile(join(ws, "a.txt"), "A1");
  const session = mkSession({ id: "s-dry", cwd: ws, events: [], legacyEvents: true });
  const { mock } = await env.start({ sessions: [session] });
  mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-dry"), "baseline");
  await writeFile(join(ws, "a.txt"), "A2");
  mock.emit(session, turnEnd(1, 1));
  await waitForFile(turnPath(env, "s-dry", 1), "turn-1");
  await writeFile(join(ws, "a.txt"), "A3");
  await writeFile(join(ws, "new.txt"), "N");

  const preview = await mock.api("restore", { sessionId: "s-dry", atSeq: 1, dryRun: true });
  assert.equal(preview.status, 200, await dumpApi("restore dryRun", preview));
  const value = preview.json.value;
  assert.equal(value.dryRun, true);
  assert.equal(value.mode, "turn");
  assert.ok(value.restored.includes("a.txt"), `dryRun.restored 应含 a.txt：${JSON.stringify(value)}`);
  assert.ok(value.deleted.includes("new.txt"), `dryRun.deleted 应含 new.txt：${JSON.stringify(value)}`);
  await assertFileEquals(join(ws, "a.txt"), "A3", "dryRun 不得改文件");
  assert.equal(existsSync(join(ws, "new.txt")), true, "dryRun 不得删文件");
});

defineCase("验收: 两轮边界 restore 语义（第2轮边界还原 A 且 B 不存在；baseline 还原初始）", async (env) => {
  // 场景（task-6 指定）：
  //   初始 a.txt=A-init
  //   第1轮：a.txt A-init → A-round1（改文件 A）        turn1 end seq=1
  //   第2轮：新增 b.txt=B-round2（改文件 B）            turn2 end seq=3
  //   回退到第2轮之前（turn1 end seq=1）→ a.txt=A-round1、b.txt 不存在
  //   回退到第1轮之前（baseline:true）  → a.txt=A-init、b.txt 不存在
  const ws = await env.ws();
  await writeFile(join(ws, "a.txt"), "A-init");
  const events = [];
  const session = mkSession({ id: "s-accept", cwd: ws, events, legacyEvents: true });
  const { mock } = await env.start({ sessions: [session] });

  // 第 1 轮
  mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-accept"), "baseline");
  await writeFile(join(ws, "a.txt"), "A-round1");
  mock.emit(session, turnEnd(1, 1));
  await waitForFile(turnPath(env, "s-accept", 1), "turn-1");

  // 第 2 轮
  mock.emit(session, turnStart(2, 2));
  await writeFile(join(ws, "b.txt"), "B-round2");
  mock.emit(session, turnEnd(3, 2));
  await waitForFile(turnPath(env, "s-accept", 2), "turn-2");

  // 按第 2 轮边界（turn1 end seq=1）回退
  const toTurn1 = await mock.api("restore", { sessionId: "s-accept", atSeq: 1, dryRun: false });
  assert.equal(toTurn1.status, 200, await dumpApi("accept turn1 boundary", toTurn1));
  const value1 = toTurn1.json.value;
  assert.equal(value1.mode, "turn", `应命中 turn1 检查点：${JSON.stringify(value1)}`);
  assert.deepEqual(value1.boundary, { turn: 1, endSeq: 1 }, JSON.stringify(value1.boundary));
  await assertFileEquals(join(ws, "a.txt"), "A-round1", "第1轮结束内容应保留（A-round1）");
  assert.equal(existsSync(join(ws, "b.txt")), false, "第2轮新增的 b.txt 应被删除");
  assert.ok(value1.deleted.includes("b.txt"), `deleted 应含 b.txt：${JSON.stringify(value1.deleted)}`);

  // 按第 1 轮边界（baseline）回退
  const toBaseline = await mock.api("restore", { sessionId: "s-accept", baseline: true, dryRun: false });
  assert.equal(toBaseline.status, 200, await dumpApi("accept baseline", toBaseline));
  const value2 = toBaseline.json.value;
  assert.equal(value2.mode, "baseline", `应命中 baseline：${JSON.stringify(value2)}`);
  await assertFileEquals(join(ws, "a.txt"), "A-init", "baseline 应还原初始内容（A-init）");
  assert.equal(existsSync(join(ws, "b.txt")), false, "baseline 后 b.txt 仍不存在");
});

defineCase("restore 边界: 未知会话/无 atSeq → mode:none；atSeq 落在 turn 内取其后第一个 turn/end", async (env) => {
  const ws = await env.ws();
  await writeFile(join(ws, "a.txt"), "A1");
  const session = mkSession({ id: "s-edge", cwd: ws, events: [], legacyEvents: true });
  const { mock } = await env.start({ sessions: [session] });

  const unknown = await mock.api("restore", { sessionId: "no-such-session", atSeq: 1 });
  assert.equal(unknown.status, 200, await dumpApi("restore unknown", unknown));
  assert.equal(unknown.json.value.mode, "none", JSON.stringify(unknown.json.value));

  mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-edge"), "baseline");
  await writeFile(join(ws, "a.txt"), "A2");
  mock.emit(session, turnEnd(1, 1));
  await waitForFile(turnPath(env, "s-edge", 1), "turn-1");

  const noAtSeq = await mock.api("restore", { sessionId: "s-edge" });
  assert.equal(noAtSeq.status, 200);
  assert.equal(noAtSeq.json.value.mode, "none", "省略 atSeq 且 baseline!=true 应返回 mode:none");

  mock.emit(session, turnStart(2, 2));
  await writeFile(join(ws, "a.txt"), "A3");
  mock.emit(session, turnEnd(3, 2));
  await waitForFile(turnPath(env, "s-edge", 2), "turn-2");

  // 契约：resolveTarget 取「seq >= atSeq 的第一个 turn/end」。atSeq=2（turn2 内）→ turn2 检查点。
  // 客户端实际只传「上一轮 turn/end 的 seq」，因此这条仅用于锁定边界语义，不是客户端路径。
  const midTurn = await mock.api("restore", { sessionId: "s-edge", atSeq: 2 });
  assert.equal(midTurn.status, 200, await dumpApi("atSeq=2", midTurn));
  assert.equal(midTurn.json.value.mode, "turn");
  assert.deepEqual(midTurn.json.value.boundary, { turn: 2, endSeq: 3 }, JSON.stringify(midTurn.json.value.boundary));
  await assertFileEquals(join(ws, "a.txt"), "A3", "atSeq=2 应落在 turn2 检查点（turn2 结束状态）");
});

defineCase("store 边界: DSH_HOME 内工作区 / enabled:false / subagent 会话都不跟踪", async (env) => {
  // 1) 工作区在 DSH_HOME 内
  const innerWs = join(env.home, "workspace-inside");
  await mkdir(innerWs, { recursive: true });
  await writeFile(join(innerWs, "a.txt"), "A1");
  const innerSession = mkSession({ id: "s-inside", cwd: innerWs });
  const { mock } = await env.start({ sessions: [innerSession] });
  mock.emit(innerSession, turnStart(0, 1));
  await sleep(80);
  assert.equal(existsSync(storeDir(env, "s-inside")), false, "DSH_HOME 内工作区不应建立 checkpoint store");
  const insideApi = await mock.api("checkpoints", { sessionId: "s-inside" });
  assert.equal(insideApi.json.value.tracking, false, JSON.stringify(insideApi.json.value));
  mock.disposeAll();

  // 2) config enabled:false（新 apply 用新 DSH_HOME 才能重新读 config）
  const ws = await env.ws("ws-enabled");
  await writeFile(join(ws, "a.txt"), "A1");
  process.env.DSH_HOME = join(env.root, "home-enabled");
  await mkdir(join(process.env.DSH_HOME, "storages", "dsh-rewind"), { recursive: true });
  await writeFile(join(process.env.DSH_HOME, "storages", "dsh-rewind", "config.json"), JSON.stringify({ enabled: false }));
  const session = mkSession({ id: "s-disabled", cwd: ws });
  const { mock: mock2 } = await env.start({ sessions: [session] });
  mock2.emit(session, turnStart(0, 1));
  await sleep(80);
  assert.equal(existsSync(join(process.env.DSH_HOME, "storages", "dsh-rewind", "s-disabled")), false, "enabled:false 不应建立 store");
  const disabledApi = await mock2.api("checkpoints", { sessionId: "s-disabled" });
  assert.equal(disabledApi.json.value.tracking, false);
  mock2.disposeAll();

  // 3) subagent 会话（header.origin=subagent）不建立
  process.env.DSH_HOME = env.home;
  const subWs = await env.ws("ws-subagent");
  const subSession = mkSession({ id: "s-sub", cwd: subWs, origin: "subagent" });
  const { mock: mock3 } = await env.start({ sessions: [subSession] });
  mock3.emit(subSession, turnStart(0, 1));
  await sleep(80);
  assert.equal(existsSync(storeDir(env, "s-sub")), false, "subagent 会话不应建立 checkpoint store");
});

defineCase("api 鉴权: 401/403/503 与正常放行", async (env) => {
  const ws = await env.ws();
  const session = mkSession({ id: "s-auth", cwd: ws });

  const rejecting = await env.start({ sessions: [session], connection: { requestRejection: () => 401 } });
  const denied = await rejecting.mock.api("checkpoints", { sessionId: "s-auth" });
  assert.equal(denied.status, 401, await dumpApi("401", denied));
  assert.equal(denied.body, "", "401 应直接 end，无 body");
  rejecting.mock.disposeAll();

  const forbidding = await env.start({ sessions: [session], connection: { requestRejection: () => 403 } });
  const forbidden = await forbidding.mock.api("checkpoints", { sessionId: "s-auth" });
  assert.equal(forbidden.status, 403, await dumpApi("403", forbidden));
  forbidding.mock.disposeAll();

  // connection 服务存在但没有 requestRejection → fail-closed 503
  const broken = await env.start({ sessions: [session], connection: {} });
  const unavailable = await broken.mock.api("checkpoints", { sessionId: "s-auth" });
  assert.equal(unavailable.status, 503, await dumpApi("503", unavailable));
  assert.equal(unavailable.json?.error?.code, "unavailable", JSON.stringify(unavailable.json));
  broken.mock.disposeAll();

  // connection 服务整体缺失 → 同样 503（fail-closed，README 承诺）
  const missing = await env.start({ sessions: [session], connection: null });
  const missingRes = await missing.mock.api("checkpoints", { sessionId: "s-auth" });
  assert.equal(missingRes.status, 503, await dumpApi("503-missing", missingRes));
  missing.mock.disposeAll();

  // 放行
  const ok = await env.start({ sessions: [session], connection: { requestRejection: () => undefined } });
  const allowed = await ok.mock.api("checkpoints", { sessionId: "s-auth" });
  assert.equal(allowed.status, 200, await dumpApi("allowed", allowed));
  assert.equal(allowed.json.ok, true);
});

defineCase("api 校验: 405 / 404 / 400（坏 JSON、缺字段、错类型、超大 body）", async (env) => {
  const ws = await env.ws();
  const session = mkSession({ id: "s-validate", cwd: ws });
  const { mock } = await env.start({ sessions: [session], connection: { requestRejection: () => undefined } });

  const getRes = await mock.api("checkpoints", {}, { method: "GET" });
  assert.equal(getRes.status, 405, await dumpApi("GET", getRes));
  assert.equal(getRes.json?.error?.code, "method-error", JSON.stringify(getRes.json));

  const unknown = await mock.api("nope", {});
  assert.equal(unknown.status, 404, await dumpApi("unknown method", unknown));
  assert.equal(unknown.json?.error?.code, "not-found");

  const nested = await mock.api("checkpoints", {}, { url: "/dsh-rewind/api/checkpoints/extra" });
  assert.equal(nested.status, 404, await dumpApi("nested path", nested));

  const badJson = await mock.api("checkpoints", "{not json");
  assert.equal(badJson.status, 400, await dumpApi("bad json", badJson));
  assert.equal(badJson.json?.error?.code, "bad-request");

  const missingField = await mock.api("checkpoints", {});
  assert.equal(missingField.status, 400, await dumpApi("missing sessionId", missingField));

  const wrongType = await mock.api("restore", { sessionId: "s-validate", atSeq: "1" });
  assert.equal(wrongType.status, 400, await dumpApi("invalid atSeq", wrongType));

  const wrongBool = await mock.api("restore", { sessionId: "s-validate", dryRun: "yes" });
  assert.equal(wrongBool.status, 400, await dumpApi("invalid dryRun", wrongBool));

  const huge = await mock.api("restore", JSON.stringify({ sessionId: "s-validate", pad: "x".repeat((1 << 20) + 16) }));
  assert.equal(huge.status, 400, `超大 body 应 400；实际 HTTP ${huge.status} body=${String(huge.body).slice(0, 200)}`);
});

defineCase("gitAutoCommit: turn/start 前把脏工作区提交为一次 commit", async (env) => {
  const ws = await env.ws();
  await initGitRepo(ws);
  const session = mkSession({ id: "s-git", cwd: ws });
  const { mock } = await env.start({ sessions: [session] });

  // 埋一个未提交改动
  await writeFile(join(ws, "a.txt"), "A1");
  await writeFile(join(ws, "seed.txt"), "seed changed\n");
  mock.emit(session, turnStart(0, 1));
  await waitFor(async () => {
    const log = await git(ws, ["log", "--format=%s"]);
    return log.ok && log.stdout.trim().split("\n").length >= 2;
  }, "git 自动提交出现第二个 commit");
  await waitForFile(baselinePath(env, "s-git"), "baseline 同时建立");

  const log = await git(ws, ["log", "--format=%s"]);
  const subjects = log.stdout.trim().split("\n");
  assert.equal(subjects[0], "dsh: checkpoint before turn 1", `commit message 不符：${JSON.stringify(subjects)}`);
  const status = await git(ws, ["status", "--porcelain"]);
  assert.equal(status.stdout.trim(), "", `提交后工作区应干净；实际=${status.stdout}`);
  assert.deepEqual(mock.warnings(), [], `不应有告警：${JSON.stringify(mock.warnings())}`);
});

defineCase("gitAutoCommit: 非 git 目录静默跳过；gitAutoCommit:false 不提交", async (env) => {
  const plainWs = await env.ws("ws-plain");
  await writeFile(join(plainWs, "a.txt"), "A1");
  const session = mkSession({ id: "s-nogit", cwd: plainWs });
  const { mock } = await env.start({ sessions: [session] });
  mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-nogit"), "非 git 目录仍建立 baseline");
  assert.equal(existsSync(join(plainWs, ".git")), false, "非 git 目录不应被初始化");
  assert.deepEqual(mock.warnings(), [], `非 git 目录不应告警：${JSON.stringify(mock.warnings())}`);
  mock.disposeAll();

  // gitAutoCommit:false
  const ws = await env.ws("ws-git-off");
  await initGitRepo(ws);
  process.env.DSH_HOME = join(env.root, "home-git-off");
  await mkdir(join(process.env.DSH_HOME, "storages", "dsh-rewind"), { recursive: true });
  await writeFile(join(process.env.DSH_HOME, "storages", "dsh-rewind", "config.json"), JSON.stringify({ gitAutoCommit: false }));
  const offSession = mkSession({ id: "s-git-off", cwd: ws });
  const { mock: offMock } = await env.start({ sessions: [offSession] });
  await writeFile(join(ws, "a.txt"), "A1");
  offMock.emit(offSession, turnStart(0, 1));
  await waitForFile(join(process.env.DSH_HOME, "storages", "dsh-rewind", "s-git-off", "baseline.json"), "baseline");
  await sleep(250);
  const log = await git(ws, ["log", "--format=%s"]);
  assert.equal(log.stdout.trim().split("\n").length, 1, `gitAutoCommit:false 时不应新增提交：${JSON.stringify(log.stdout)}`);
  const status = await git(ws, ["status", "--porcelain"]);
  assert.ok(status.stdout.includes("a.txt"), `工作区应保持脏：${JSON.stringify(status.stdout)}`);
});

defineCase("大文件语义: >blobSizeCap 无内容、>trackSizeCap 无 sha，restore 如实 skipped", async (env) => {
  const ws = await env.ws();
  await env.writeConfig({ trackSizeCap: 100, blobSizeCap: 10 });
  const smallOriginal = "12345";
  const midOriginal = "m".repeat(50);
  const bigOriginal = "b".repeat(200);
  await writeFile(join(ws, "small.txt"), smallOriginal);
  await writeFile(join(ws, "mid.txt"), midOriginal);
  await writeFile(join(ws, "big.txt"), bigOriginal);
  const session = mkSession({ id: "s-big", cwd: ws, events: [], legacyEvents: true });
  const { mock } = await env.start({ sessions: [session] });

  mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-big"), "baseline");
  const baseline = await readJsonFile(baselinePath(env, "s-big"));
  assert.ok(baseline.files["small.txt"].sha !== undefined, "小文件应有 sha");
  assert.ok(baseline.files["mid.txt"].sha !== undefined, `中等文件应有 sha（但无 blob）：${JSON.stringify(baseline.files["mid.txt"])}`);
  assert.equal(baseline.files["big.txt"].sha, undefined, `大文件不应有 sha：${JSON.stringify(baseline.files["big.txt"])}`);

  await writeFile(join(ws, "small.txt"), "changed-small");
  await writeFile(join(ws, "mid.txt"), "changed-mid");
  await writeFile(join(ws, "big.txt"), "changed-big");
  await writeFile(join(ws, "extra.txt"), "extra");
  mock.emit(session, turnEnd(1, 1));
  await waitForFile(turnPath(env, "s-big", 1), "turn-1");

  const result = await mock.api("restore", { sessionId: "s-big", baseline: true });
  assert.equal(result.status, 200, await dumpApi("restore big", result));
  const value = result.json.value;
  await assertFileEquals(join(ws, "small.txt"), smallOriginal, "小文件应还原");
  await assertFileEquals(join(ws, "mid.txt"), "changed-mid", "超 blobSizeCap 的中等文件无法还原（内容未入 blob）");
  await assertFileEquals(join(ws, "big.txt"), "changed-big", "超 trackSizeCap 的大文件不跟踪");
  assert.equal(existsSync(join(ws, "extra.txt")), false, "baseline 之后新增文件应删除");
  const skipped = new Map(value.skipped.map((item) => [item.path, item.reason]));
  assert.equal(skipped.get("mid.txt"), "no-content", `mid.txt skip 原因应为 no-content：${JSON.stringify(value.skipped)}`);
  assert.equal(skipped.get("big.txt"), "too-large", `big.txt skip 原因应为 too-large：${JSON.stringify(value.skipped)}`);
});

defineCase("并发: 两次 restore 串行化互不踩；恢复期间 turn/end 快照不损坏", async (env) => {
  const ws = await env.ws();
  await writeFile(join(ws, "a.txt"), "A1");
  const events = [];
  const session = mkSession({ id: "s-conc", cwd: ws, events, legacyEvents: true });
  const { mock } = await env.start({ sessions: [session] });

  mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-conc"), "baseline");
  await writeFile(join(ws, "a.txt"), "A2");
  mock.emit(session, turnEnd(1, 1));
  await waitForFile(turnPath(env, "s-conc", 1), "turn-1");
  mock.emit(session, turnStart(2, 2));
  await writeFile(join(ws, "a.txt"), "A3");
  mock.emit(session, turnEnd(3, 2));
  await waitForFile(turnPath(env, "s-conc", 2), "turn-2");

  // 同一 session 的两个 restore 并发：enqueue 串行 → 后完成的 atSeq=3 生效
  const [first, second] = await Promise.all([
    mock.api("restore", { sessionId: "s-conc", atSeq: 1 }),
    mock.api("restore", { sessionId: "s-conc", atSeq: 3 }),
  ]);
  assert.equal(first.status, 200, await dumpApi("concurrent#1", first));
  assert.equal(second.status, 200, await dumpApi("concurrent#2", second));
  assert.equal(first.json.value.mode, "turn");
  assert.equal(second.json.value.mode, "turn");
  await assertFileEquals(join(ws, "a.txt"), "A3", "串行化后应停在 atSeq=3 对应的 turn2 状态");

  // restore 与 turn/end 快照并发：两者都不得抛错，checkpoint JSON 必须完整可解析
  await writeFile(join(ws, "a.txt"), "A4");
  const restorePromise = mock.api("restore", { sessionId: "s-conc", atSeq: 1 });
  mock.emit(session, turnEnd(5, 3));
  const concurrentRestore = await restorePromise;
  assert.equal(concurrentRestore.status, 200, await dumpApi("restore during checkpoint", concurrentRestore));
  await waitForFile(turnPath(env, "s-conc", 3), "turn-3.json");
  const turn3 = await readJsonFile(turnPath(env, "s-conc", 3));
  assert.equal(turn3.turn, 3);
  assert.equal(turn3.endSeq, 5);
  const finalContent = await readFile(join(ws, "a.txt"), "utf8");
  assert.ok(["A2", "A4"].includes(finalContent), `并发后 a.txt 应为 A2 或 A4，实际=${JSON.stringify(finalContent)}`);
  assert.deepEqual(mock.warnings(), [], `并发不应产生告警：${JSON.stringify(mock.warnings())}`);
});

defineCase("安全: 被篡改的 checkpoint 不能越界写/删工作区外文件", async (env) => {
  const ws = await env.ws();
  await writeFile(join(ws, "a.txt"), "A1");
  const events = [];
  const session = mkSession({ id: "s-trav", cwd: ws, events, legacyEvents: true });
  const first = await env.start({ sessions: [session] });
  first.mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-trav"), "baseline");
  await writeFile(join(ws, "a.txt"), "A2");
  first.mock.emit(session, turnEnd(1, 1));
  await waitForFile(turnPath(env, "s-trav", 1), "turn-1");
  first.mock.disposeAll();

  // 新 apply 实例（内存缓存清空），篡改落盘的 turn-1.json 注入越界路径
  const outsideRel = join(env.root, "outside-victim.txt");
  const outsideAbs = join(env.root, "outside-abs.txt");
  const checkpoint = await readJsonFile(turnPath(env, "s-trav", 1));
  const sha = checkpoint.files["a.txt"].sha;
  checkpoint.files["../outside-victim.txt"] = { sha, size: 2, mtimeMs: 0 };
  checkpoint.files[outsideAbs] = { sha, size: 2, mtimeMs: 0 };
  await writeFile(turnPath(env, "s-trav", 1), JSON.stringify(checkpoint));

  const second = await env.start({ sessions: [session] });
  const result = await second.mock.api("restore", { sessionId: "s-trav", atSeq: 1 });
  assert.equal(result.status, 200, await dumpApi("tampered restore", result));
  assert.equal(existsSync(outsideRel), false, `不得写出工作区外的 ../outside-victim.txt：${outsideRel}`);
  assert.equal(existsSync(outsideAbs), false, `不得写出绝对路径文件：${outsideAbs}`);
  await assertFileEquals(join(ws, "a.txt"), "A2", "合法部分仍应正常还原");
});

defineCase("checkpoints: 未跟踪会话返回 tracking:false", async (env) => {
  const ws = await env.ws();
  const session = mkSession({ id: "s-track", cwd: ws });
  const { mock } = await env.start({ sessions: [session] });
  const res = await mock.api("checkpoints", { sessionId: "unknown-session" });
  assert.equal(res.status, 200, await dumpApi("checkpoints unknown", res));
  assert.deepEqual(res.json.value, { tracking: false, hasBaseline: false, checkpoints: [] });
});

defineCase("兼容: 旧 persistence.inspect() 契约的冷会话可跟踪与还原（修复不得回归）", async (env) => {
  const ws = await env.ws();
  await writeFile(join(ws, "a.txt"), "A1");
  const events = [];
  const session = mkSession({ id: "s-legacy", cwd: ws, events, legacyEvents: true });
  const phase1 = await env.start({ sessions: [session] });
  phase1.mock.emit(session, turnStart(0, 1));
  await waitForFile(baselinePath(env, "s-legacy"), "baseline");
  await writeFile(join(ws, "a.txt"), "A2");
  phase1.mock.emit(session, turnEnd(1, 1));
  await waitForFile(turnPath(env, "s-legacy", 1), "turn-1");
  phase1.mock.disposeAll();

  // 冷会话（不在 ctx.sessions 里），只有旧版 inspect() 契约可用
  const legacyPersistence = mkLegacyPersistence([
    { header: { version: 4, id: "s-legacy", createdAt: Date.now(), cwd: ws, isSeeded: false }, events },
  ]);
  const cold = await env.start({ sessions: [], sessionPersistence: legacyPersistence });

  const list = await cold.mock.api("checkpoints", { sessionId: "s-legacy" });
  assert.equal(list.json.value.tracking, true, `旧 inspect 契约应可跟踪：${JSON.stringify(list.json.value)}`);
  await writeFile(join(ws, "a.txt"), "A3");
  const restore = await cold.mock.api("restore", { sessionId: "s-legacy", atSeq: 1 });
  assert.equal(restore.status, 200, await dumpApi("legacy inspect restore", restore));
  assert.equal(restore.json.value.mode, "turn", `旧 inspect 契约应命中 turn1：${JSON.stringify(restore.json.value)}`);
  await assertFileEquals(join(ws, "a.txt"), "A2", "旧 inspect 契约应还原 turn1 结束状态");
});

// ---- 0.2.1 真实宿主契约（已确认缺陷，XFAIL；修复后这些用例应转绿） -------------

defineCase(
  "真实 0.2.1 live Session（无 .events，只有 snapshotEvents）: restore(atSeq) 应还原上一轮",
  async (env) => {
    const ws = await env.ws();
    await writeFile(join(ws, "a.txt"), "A1");
    const events = [];
    // 关键：legacyEvents=false —— 与 0.2.1 Session 一致，没有 .events
    const session = mkSession({ id: "s-real", cwd: ws, events });
    const { mock } = await env.start({ sessions: [session] });

    mock.emit(session, turnStart(0, 1));
    await waitForFile(baselinePath(env, "s-real"), "baseline");
    await writeFile(join(ws, "a.txt"), "A2");
    mock.emit(session, turnEnd(1, 1));
    await waitForFile(turnPath(env, "s-real", 1), "turn-1");
    mock.emit(session, turnStart(2, 2));
    await writeFile(join(ws, "a.txt"), "A3");
    mock.emit(session, turnEnd(3, 2));
    await waitForFile(turnPath(env, "s-real", 2), "turn-2");

    const result = await mock.api("restore", { sessionId: "s-real", atSeq: 1 });
    assert.equal(result.status, 200, await dumpApi("real restore", result));
    const value = result.json.value;
    assert.equal(value.mode, "turn", `真实 Session 上 restore(atSeq=1) 应命中 turn1 检查点，实际=${JSON.stringify(value)}（读不到 events → resolveTarget 退化为 baseline）`);
    await assertFileEquals(join(ws, "a.txt"), "A2", "应还原到 turn1 结束状态 A2");
  },
  { knownBug: "BUG-1" },
);

defineCase(
  "真实 0.2.1 sessionPersistence（无 inspect，只有 stat/open）: 冷会话可跟踪与还原",
  async (env) => {
    const ws = await env.ws();
    await writeFile(join(ws, "a.txt"), "A1");
    const events = [];
    const session = mkSession({ id: "s-cold", cwd: ws, events, legacyEvents: true });
    // 阶段一：会话 live 时正常建 baseline + turn1/turn2 检查点（落盘在 DSH_HOME）
    const phase1 = await env.start({ sessions: [session] });
    phase1.mock.emit(session, turnStart(0, 1));
    await waitForFile(baselinePath(env, "s-cold"), "baseline");
    await writeFile(join(ws, "a.txt"), "A2");
    phase1.mock.emit(session, turnEnd(1, 1));
    await waitForFile(turnPath(env, "s-cold", 1), "turn-1");
    phase1.mock.emit(session, turnStart(2, 2));
    await writeFile(join(ws, "a.txt"), "A3");
    phase1.mock.emit(session, turnEnd(3, 2));
    await waitForFile(turnPath(env, "s-cold", 2), "turn-2");
    phase1.mock.disposeAll();

    // 阶段二：模拟重启后——会话不在内存里，非 live 服务只有真实 0.2.1 的 stat/open
    const header = { version: 4, id: "s-cold", createdAt: Date.now(), cwd: ws, isSeeded: false };
    const persistence = mkPersistence([{ header, events }]);
    const { mock } = await env.start({ sessions: [], sessionPersistence: persistence });

    await writeFile(join(ws, "a.txt"), "A4");
    const result = await mock.api("restore", { sessionId: "s-cold", atSeq: 3 });
    assert.equal(result.status, 200, await dumpApi("cold restore", result));
    assert.equal(result.json.value.mode, "turn", `冷会话应命中 turn2；实际=${JSON.stringify(result.json.value)}（workspaceRootOf/eventsOf 调用了不存在的 persistence.inspect）`);
    await assertFileEquals(join(ws, "a.txt"), "A3", "冷会话 restore(atSeq=3) 应还原 turn2 结束状态 A3");
    const list = await mock.api("checkpoints", { sessionId: "s-cold" });
    assert.equal(list.json.value.tracking, true, `冷会话应 tracking:true；实际=${JSON.stringify(list.json.value)}`);
    assert.equal(list.json.value.checkpoints.length, 2, `冷会话应看到 2 个检查点；实际=${JSON.stringify(list.json.value.checkpoints)}`);
  },
  { knownBug: "BUG-2" },
);

// ---------------------------------------------------------------------------
process.exitCode = await main();
