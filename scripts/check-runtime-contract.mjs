#!/usr/bin/env node
/**
 * check-runtime-contract.mjs — DSH 宿主/客户端「契约守卫」只读检查。
 *
 * dsh-rewind 依赖一批 DSH 内部契约（Session 同步读取、sessionPersistence 句柄、
 * webServer 前缀路由、Fork/Create RPC 字段、客户端 slot / Definition / 服务名、
 * 主题 CSS 变量、client bundle 声明解析）。DSH 每次升级都可能悄悄改动其中之一，
 * 而我们的 mock 单测跑在假 ctx 上，抓不到“宿主本身变了”。本脚本直接对当前安装的
 * DSH 运行时（app.asar 或源码 checkout）做静态断言：契约点消失即 FAIL。
 *
 * 语义：
 *   - 只读：不写任何文件、不启动 DSH、不碰 ~/.dsh。
 *   - 宽松匹配：正则按“符号出现”判定（如 /snapshotEvents\s*\(/），不绑行号；
 *     行号仅作证据展示（压缩/重排产物行号会漂移）。
 *   - 目标解析顺序：--asar <path> → DSH_ASAR → 默认 app.asar 路径 →
 *     --checkout <dir> → DSH_CHECKOUT。显式指定的路径不回退；全都没有 → SKIP
 *     （--strict 下算失败）。
 *
 * 用法：
 *   node scripts/check-runtime-contract.mjs            # 人类可读，末行汇总
 *   node scripts/check-runtime-contract.mjs --json     # 机器可读
 *   node scripts/check-runtime-contract.mjs --strict   # SKIP 视为失败
 *   node scripts/check-runtime-contract.mjs --list     # 只列出契约清单
 *   node scripts/check-runtime-contract.mjs --asar /path/app.asar
 *   node scripts/check-runtime-contract.mjs --checkout /path/to/repo
 *
 * 退出码：0 = 全 PASS（或非 strict 下 SKIP）；1 = 有 FAIL / strict 下 SKIP；2 = 用法错误。
 */

import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
const PKG_SCOPE = "@deepseek-ai";

//#region 契约清单
/**
 * 每条契约：
 *   id     稳定编号（H*=宿主，C*=客户端），供报告与日志引用。
 *   title  一句话说明契约点。
 *   why    插件为何依赖它（失效后果）。
 *   files  候选文件（包内相对路径）；按顺序取第一个存在的，命中可跨候选。
 *   needs  必须同时命中的正则（label 用于失败信息）。
 */
const CONTRACTS = [
  {
    id: "H1",
    title: "dsh-session: Session 提供 snapshotEvents/ownEvents/eventAt（同步事件读取）",
    why: "插件的 live 读取路径用它取事件做 checkpoint / restore；缺失则 restore(atSeq) 退化为 baseline。",
    files: ["dsh-session/lib/index.js"],
    needs: [
      { label: "snapshotEvents(fromSeq, toSeqExclusive)", re: /snapshotEvents\s*\(\s*fromSeq/ },
      { label: "ownEvents()", re: /ownEvents\s*\(\s*\)/ },
      { label: "eventAt(seq)", re: /eventAt\s*\(\s*seq\s*\)/ },
    ],
  },
  {
    id: "H2",
    title: "dsh-session-persistence: async open(id, access) / async stat(id)，handle.read() 返回 {eventState, events}",
    why: "冷会话（未 attach）的跟踪与还原走 persistence 句柄；接口改名/改形即冷会话不可跟踪。",
    files: [
      "dsh-session-persistence-jsonl/lib/index.js",
      "dsh-session-persistence/lib/index.js",
    ],
    needs: [
      { label: "async open(id, access, ...)", re: /async\s+open\s*\(\s*id\s*,\s*access/ },
      { label: "async stat(id, ...)", re: /async\s+stat\s*\(\s*id\s*[,)]/ },
      { label: "async read(offset, length, ...)", re: /async\s+read\s*\(\s*offset\s*=\s*0\s*,\s*length/ },
      { label: "read() 返回事件切片 events: source.events.slice(...)", re: /events\s*:\s*source\.events\.slice\s*\(/ },
      { label: "read() 返回 eventState", re: /eventState\s*:\s*("detached"|source\.eventState)/ },
      { label: "服务名 sessionPersistence", re: /super\s*\(\s*ctx\s*,\s*["']sessionPersistence["']\s*\)/ },
    ],
  },
  {
    id: "H3",
    title: "dsh-client-connection: requestRejection(request)（HTTP 鉴权 fail-closed 判定）",
    why: "插件 API 路由用它对每个请求判 401/403；缺失则无法复用宿主鉴权语义。",
    files: ["dsh-client-connection/lib/index.js"],
    needs: [{ label: "requestRejection(request)", re: /requestRejection\s*\(\s*request\s*\)/ }],
  },
  {
    id: "H4",
    title: 'dsh-host-webserver: register({kind}) 支持 prefix 路由（最长前缀优先）',
    why: "插件以 prefix 挂 /dsh-rewind/api；只支持 exact 的话路由不会命中。",
    files: ["dsh-host-webserver/lib/index.js"],
    needs: [
      { label: 'route.kind === "exact" ? exact : prefixes', re: /route\.kind\s*===\s*["']exact["']\s*\?\s*this\.exact\s*:\s*this\.prefixes/ },
      { label: "register(route) 入口", re: /register\s*\(\s*route\s*\)\s*\{/ },
      { label: "前缀匹配按 path 边界（prefix/）", re: /startsWith\s*\(\s*`\$\{prefix\}/ },
    ],
  },
  {
    id: "H5",
    title: "dsh-api-session-controller: Fork RPC 接受 atSeq（SessionForkRequest.atSeq）",
    why: "插件的「回退到此」用 fork(atSeq) 精确切到某一轮边界；字段消失则只能 fork 到最新。",
    files: [
      "dsh-api-session-controller/lib/typert.host.js",
      "dsh-api-session-controller/lib/index.js",
    ],
    needs: [
      { label: "atSeq zod 字段", re: /['"]atSeq['"]\s*:\s*z\.number\s*\(\s*\)/ },
      { label: "fork jsonSchema 含 atSeq", re: /"atSeq"\s*:\s*\{\s*"type"\s*:\s*"number"/ },
      { label: "SessionForkRequest 声明含 atSeq", re: /interface SessionForkRequest\s*\{[^}]*atSeq/ },
      { label: "atSeq 语义为 inclusive source event seq", re: /[Ii]nclusive source event seq/ },
    ],
  },
  {
    id: "H6",
    title: "dsh-api-session-controller: Create RPC 同时接受 workspaceId 与 cwd（SessionCreateRequest）",
    why: "插件建/复用会话时按工作区或目录二选一；任一字段消失则该模式建会话失败。",
    files: [
      "dsh-api-session-controller/lib/typert.host.js",
      "dsh-api-session-controller/lib/index.js",
    ],
    needs: [
      { label: "workspaceId zod 字段", re: /['"]workspaceId['"]\s*:\s*z\.string\s*\(\s*\)/ },
      { label: "cwd zod 字段", re: /['"]cwd['"]\s*:\s*z\.string\s*\(\s*\)/ },
      { label: "SessionCreateRequest 声明同时含 workspaceId 与 cwd", re: /interface SessionCreateRequest\s*\{[^}]*workspaceId[^}]*cwd/ },
    ],
  },
  {
    id: "H7",
    title: "dsh-client-ui-workspace: archiveSession(sessionId, options = {}) 取字符串 id；uiWorkspace.openSession(target)",
    why: "插件回退后用 archiveSession(sessionId) 归档旧会话、用 openSession 打开新会话；签名变了会抛错或归档错对象。",
    files: ["dsh-client-ui-workspace/lib/client.js"],
    needs: [
      { label: "archiveSession(sessionId, options = {})", re: /async\s+archiveSession\s*\(\s*sessionId\s*,\s*options\s*=\s*\{\s*\}\s*\)/ },
      { label: "转发到 workspaces.archiveSession(sessionId, options)", re: /this\.workspaces\.archiveSession\s*\(\s*sessionId\s*,\s*options\s*\)/ },
      { label: "openSession(target)", re: /openSession\s*\(\s*target\s*\)\s*\{/ },
    ],
  },
  {
    id: "C1",
    title: 'dsh-client-ui-chat: 渲染 conversation.chat.node 时把 chat 节点作为 props.node 传给 slot',
    why: "插件的「每问操作行」靠 props.node 拿到该节点 seq；不传 node 就永远找不到对应提问（P0-1）。",
    files: ["dsh-client-ui-chat/lib/client.js"],
    needs: [
      { label: 'renderSlot("conversation.chat.node", routedOwner, {...})', re: /renderSlot\s*\(\s*["']conversation\.chat\.node["']\s*,\s*routedOwner/ },
      { label: "routedOwner 携带 node: routedNode", re: /node\s*:\s*routedNode/ },
    ],
  },
  {
    id: "C2",
    title: 'dsh-client-ui-chat: user 事件定义产出 kind:"user" 且 seq = event.seq，节点经 chatNode(context,kind,anchorSeq,data) 生成',
    why: "插件按 kind===\"user\" + data.seq 定位用户提问节点；kind/seq 变了操作行就挂错位置或消失。",
    files: ["dsh-client-ui-chat/lib/client.js"],
    needs: [
      { label: 'kind: "user" 与 seq: event.seq 同处 user 定义', re: /kind\s*:\s*["']user["']\s*,\s*seq\s*:\s*event\.seq/ },
      { label: "chatNode(context, kind, anchorSeq, data, options)", re: /function\s+chatNode\s*\(\s*context\s*,\s*kind\s*,\s*anchorSeq\s*,\s*data/ },
    ],
  },
  {
    id: "C3",
    title: 'dsh-client-ui-chat: isAppendSurfaceEvent(event) ⟺ surfaceOp === "append"',
    why: "插件的 match 只取 append-origin 事件，避免回退后重复渲染 replacement 副本。",
    files: ["dsh-client-ui-chat/lib/client.js"],
    needs: [
      { label: 'isAppendSurfaceEvent 体内 surfaceOp === "append"', re: /function\s+isAppendSurfaceEvent\s*\(\s*event\s*\)\s*\{[\s\S]{0,240}?surfaceOp\s*===\s*["']append["']/ },
    ],
  },
  {
    id: "C4",
    title: "dsh-client-ui-conversation: 渲染 conversation.input.left slot（并声明该 slot 类型）",
    why: "插件的快捷短语 / 提示词面板挂在这里；slot 消失整块 UI 不出现。",
    files: ["dsh-client-ui-conversation/lib/client.js"],
    needs: [
      { label: 'renderSlot("conversation.input.left", ...)', re: /renderSlot\s*\(\s*["']conversation\.input\.left["']/ },
      { label: '"conversation.input.left": {...} 声明', re: /["']conversation\.input\.left["']\s*:\s*\{/ },
    ],
  },
  {
    id: "C5",
    title: "dsh-client-ui-conversation: Definition target 与 buildViewNode 必须同生共死（assertDefinitionTarget）",
    why: "插件注册的 Event Definition 遵守该不变量；宿主校验放宽或改语义时，插件定义可能被静默丢弃。",
    files: ["dsh-client-ui-conversation/lib/client.js"],
    needs: [
      { label: "function assertDefinitionTarget(definition)", re: /function\s+assertDefinitionTarget\s*\(\s*definition\s*\)/ },
      { label: "target 与 buildViewNode 的 XOR 校验", re: /definition\.target\s*===\s*void 0\s*!==\s*\(\s*definition\.buildViewNode\s*===\s*void 0\s*\)/ },
    ],
  },
  {
    id: "C6",
    title: 'dsh-client-ui-conversation: 服务名为 "uiConversation"',
    why: "插件 inject 列表与 ctx.uiConversation 调用依赖该服务名；改名则 apply 阶段缺服务。",
    files: ["dsh-client-ui-conversation/lib/client.js"],
    needs: [{ label: 'super(ctx, "uiConversation")', re: /super\s*\(\s*ctx\s*,\s*["']uiConversation["']\s*\)/ }],
  },
  {
    id: "C7",
    title: "dsh-client-ui-workspace: uiWorkspace.archiveSession(sessionId, options) 与 uiWorkspace.openSession(target)",
    why: "客户端半区通过 uiWorkspace 打开回退会话、归档旧会话；方法名/参数变了整条流程中断。",
    files: ["dsh-client-ui-workspace/lib/client.js"],
    needs: [
      { label: "async archiveSession(sessionId, options = {})", re: /async\s+archiveSession\s*\(\s*sessionId\s*,\s*options\s*=\s*\{\s*\}\s*\)/ },
      { label: "openSession(target)", re: /openSession\s*\(\s*target\s*\)\s*\{/ },
    ],
  },
  {
    id: "C8",
    title: 'dsh-client-ui-session / dsh-client-ui-chat: provide hooks 覆盖 "session" 与 "chat"（useChat 可用）',
    why: "插件渲染函数从 props 拿 useChat/useSession；hooks 未提供则快照读取退化（仅降级不崩）。",
    files: ["dsh-client-ui-session/lib/client.js", "dsh-client-ui-chat/lib/client.js"],
    needs: [
      { label: 'hooks: ["session"]', re: /hooks\s*:\s*\[\s*["']session["']\s*\]/ },
      { label: 'hooks: ["chat"]', re: /hooks\s*:\s*\[\s*["']chat["']\s*\]/ },
    ],
  },
  {
    id: "C9",
    title: "dsh-client-ui-theme: 主题 CSS 变量 --dsw-alias-bg-layer-1 与 --dsw-alias-interactive-bg-hover 存在",
    why: "插件在独立渲染上下文里用这两个变量对齐宿主外观；变量改名则样式错位（不影响功能）。",
    files: ["dsh-client-ui-theme/lib/client.js"],
    needs: [
      { label: 'token 注册 name: "--dsw-alias-bg-layer-1"', re: /name\s*:\s*["']--dsw-alias-bg-layer-1["']/ },
      { label: "--dsw-alias-interactive-bg-hover（CSS/hover 语义）", re: /--dsw-alias-interactive-bg-hover/ },
    ],
  },
  {
    id: "C10",
    title: "dsh-client-modules: 仍解析 dsh.client 的 inject/external/immediately，且 immediately 必须是 boolean",
    why: "插件 client 半区的 dsh.client.inject 声明靠它注入，immediately 决定 eager 预取；解析器消失则 bundle 不进 ModuleLoader。",
    files: ["dsh-client-modules/lib/client.js", "dsh-client-modules/lib/index.js"],
    needs: [
      { label: '"dsh.client.inject" 解析', re: /["']dsh\.client\.inject["']/ },
      { label: '"dsh.client.external" 解析', re: /["']dsh\.client\.external["']/ },
      { label: "dsh.client.immediately 解析/校验", re: /dsh\.client\.immediately/ },
      { label: "immediately 必须 boolean", re: /dsh\.client\.immediately must be a boolean/ },
    ],
  },
];
//#endregion

//#region asar 读取（最小实现，零依赖）
/**
 * 打开 asar 归档并建立只读索引。
 *
 * 头部布局（Electron asar）：
 *   u32@0  = 4（pickle 头）
 *   u32@4  = headerBlockSize（头块大小）
 *   u32@8  = 头的 pickle 载荷大小
 *   u32@12 = JSON 头长度
 *   @16... = JSON 头（'{"files":...'）
 *   数据基址 = 8 + headerBlockSize；文件 offset 相对数据基址。
 *
 * @param {string} file asar 绝对路径。
 */
async function openAsar(file) {
  const fh = await open(file, "r");
  const head = Buffer.alloc(16);
  const { bytesRead } = await fh.read(head, 0, 16, 0);
  if (bytesRead < 16) throw new Error("asar 头长度不足");
  if (head.readUInt32LE(0) !== 4) throw new Error("asar 头魔数不符（u32@0 应为 4）");
  const headerBlockSize = head.readUInt32LE(4);
  const dataBase = 8 + headerBlockSize;
  const chunk = Buffer.alloc(dataBase);
  await fh.read(chunk, 0, dataBase, 0);
  let jsonStart = -1;
  for (let i = 8; i < chunk.length; i += 1) {
    if (chunk[i] === 0x7b) {
      jsonStart = i;
      break;
    }
  }
  if (jsonStart < 0) throw new Error("asar 头缺少 JSON 起点");
  const jsonLen = chunk.readUInt32LE(jsonStart - 4);
  let header;
  try {
    header = JSON.parse(chunk.subarray(jsonStart, jsonStart + jsonLen).toString("utf8"));
  } catch (error) {
    throw new Error(`asar JSON 头解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  /** @type {Map<string, {offset:number,size:number,unpacked:boolean}>} */
  const entries = new Map();
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (child.files !== undefined) walk(child, path);
      else entries.set(path, { offset: Number(child.offset), size: Number(child.size), unpacked: child.unpacked === true });
    }
  };
  walk(header, "");
  const readRaw = async (path) => {
    const entry = entries.get(path);
    if (entry === undefined) return undefined;
    if (entry.unpacked) return undefined;
    const buf = Buffer.alloc(entry.size);
    await fh.read(buf, 0, entry.size, dataBase + entry.offset);
    return buf.toString("utf8");
  };
  return {
    kind: "asar",
    label: file,
    dataBase,
    /** 读取包内相对路径（如 dsh-session/lib/index.js）。 */
    readFile: (relative) => readRaw(`dsh/node_modules/${PKG_SCOPE}/${relative}`),
    /** 读取运行时清单（dsh/package.json）。 */
    readManifest: () => readRaw("dsh/package.json"),
    close: () => fh.close(),
  };
}
//#endregion

//#region checkout（普通目录）读取
/**
 * 打开源码 checkout：按包内相对路径在常见布局中查找文件。
 * @param {string} root checkout 根目录。
 */
async function openCheckout(root) {
  const bases = [
    join(root, "dsh", "node_modules", PKG_SCOPE),
    join(root, "node_modules", PKG_SCOPE),
    join(root, "packages"),
    root,
  ];
  const readFirst = async (candidates) => {
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        return await readFile(candidate, "utf8");
      } catch {
        // 继续尝试下一个布局
      }
    }
    return undefined;
  };
  return {
    kind: "checkout",
    label: root,
    /** 读取包内相对路径（如 dsh-session/lib/index.js）。 */
    readFile: (relative) => readFirst(bases.map((base) => join(base, relative))),
    /** 读取运行时清单：优先 <root>/dsh/package.json，其次 <root>/package.json。 */
    readManifest: () => readFirst([join(root, "dsh", "package.json"), join(root, "package.json")]),
    close: async () => {},
  };
}
//#endregion

//#region 目标解析 / 契约执行
/**
 * 解析检查目标。顺序：--asar → DSH_ASAR → 默认 app.asar → --checkout → DSH_CHECKOUT。
 * @param {{asar?: string, checkout?: string}} options CLI 选项。
 * @returns {Promise<{skip: true, reason: string} | {skip: false, reader: object}>}
 */
async function resolveTarget(options) {
  // 显式指定的目标不做回退：指错了就要报出来，而不是悄悄换成默认安装。
  const explicitAsar =
    options.asar !== undefined
      ? { path: resolve(options.asar), source: "--asar" }
      : process.env.DSH_ASAR !== undefined && process.env.DSH_ASAR !== ""
        ? { path: resolve(process.env.DSH_ASAR), source: "DSH_ASAR" }
        : undefined;
  if (explicitAsar !== undefined) {
    return openAsarTarget(explicitAsar);
  }
  if (options.checkout !== undefined) {
    return openCheckoutTarget({ path: resolve(options.checkout), source: "--checkout" });
  }
  if (await existsFile(DEFAULT_ASAR)) {
    return openAsarTarget({ path: DEFAULT_ASAR, source: "默认安装路径" });
  }
  if (process.env.DSH_CHECKOUT !== undefined && process.env.DSH_CHECKOUT !== "") {
    return openCheckoutTarget({ path: resolve(process.env.DSH_CHECKOUT), source: "DSH_CHECKOUT" });
  }
  return {
    skip: true,
    reason: `未找到 app.asar 或 checkout（试过 ${DEFAULT_ASAR}、DSH_ASAR、--asar、--checkout、DSH_CHECKOUT）`,
  };
}

/**
 * 打开一个显式 asar 目标；不可读时返回 broken reader（由调用方判失败）。
 * @param {{path: string, source: string}} candidate 目标路径与来源。
 */
async function openAsarTarget(candidate) {
  if (!(await existsFile(candidate.path))) {
    return { skip: true, reason: `指定的 asar 不存在或不是文件（${candidate.source}: ${candidate.path}）` };
  }
  try {
    return { skip: false, reader: await openAsar(candidate.path), source: candidate.source };
  } catch (error) {
    return {
      skip: false,
      reader: {
        broken: true,
        label: candidate.path,
        error: error instanceof Error ? error.message : String(error),
      },
      source: candidate.source,
    };
  }
}

/**
 * 打开一个显式 checkout 目标；不是目录时返回 skip。
 * @param {{path: string, source: string}} candidate 目标路径与来源。
 */
async function openCheckoutTarget(candidate) {
  try {
    const info = await stat(candidate.path);
    if (!info.isDirectory()) return { skip: true, reason: `checkout 不是目录（${candidate.source}: ${candidate.path}）` };
    return { skip: false, reader: await openCheckout(candidate.path), source: candidate.source };
  } catch {
    return { skip: true, reason: `checkout 不存在（${candidate.source}: ${candidate.path}）` };
  }
}

/** 文件是否存在且为普通文件。 */
async function existsFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 在候选文件联合体中执行一条契约的断言。
 * @param {object} reader 目标读取器。
 * @param {object} contract 契约定义。
 */
async function runContract(reader, contract) {
  const loaded = [];
  for (const relative of contract.files) {
    const text = reader.broken === true ? undefined : await reader.readFile(relative);
    loaded.push({ relative, text });
  }
  const available = loaded.filter((entry) => entry.text !== undefined);
  if (available.length === 0) {
    return {
      id: contract.id,
      title: contract.title,
      why: contract.why,
      status: "FAIL",
      evidence: [],
      failures: [`候选文件全部缺失：${contract.files.join("、")}`],
    };
  }
  const evidence = [];
  const failures = [];
  for (const need of contract.needs) {
    let hit;
    for (const entry of available) {
      const match = need.re.exec(entry.text);
      if (match !== null) {
        hit = { ...locate(entry, match), label: need.label };
        break;
      }
    }
    if (hit === undefined) failures.push(`${need.label} —— 未命中（已查 ${available.map((e) => e.relative).join("、")}）`);
    else evidence.push(hit);
  }
  // 同一行被多条断言命中时只留一条证据，避免输出噪音。
  const seen = new Set();
  const deduped = evidence.filter((item) => {
    const key = `${item.file}:${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    id: contract.id,
    title: contract.title,
    why: contract.why,
    status: failures.length === 0 ? "PASS" : "FAIL",
    evidence: deduped,
    failures,
  };
}

/**
 * 把一次正则命中转成「文件:行 + 摘录」证据。
 * @param {{relative: string, text: string}} entry 命中的文件。
 * @param {RegExpExecArray} match 正则结果。
 */
function locate(entry, match) {
  const index = match.index ?? 0;
  const before = entry.text.slice(0, index);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEndCandidate = entry.text.indexOf("\n", index);
  const lineEnd = lineEndCandidate < 0 ? entry.text.length : lineEndCandidate;
  const raw = entry.text.slice(lineStart, lineEnd).trim();
  const snippet = raw.length > 150 ? `${raw.slice(0, 147)}...` : raw;
  return { file: entry.relative, line, snippet };
}

/** 读取运行时的 dsh 版本（`dsh/package.json`），失败返回 undefined。 */
async function readRuntimeVersion(reader) {
  if (reader.broken === true) return undefined;
  try {
    const text = await reader.readManifest();
    if (text === undefined) return undefined;
    const parsed = JSON.parse(text);
    return typeof parsed.version === "string" ? { name: parsed.name, version: parsed.version } : undefined;
  } catch {
    return undefined;
  }
}
//#endregion

//#region CLI
const USAGE = `用法: node scripts/check-runtime-contract.mjs [选项]

选项:
  --asar <path>       指定 app.asar（优先于环境变量与默认路径）
  --checkout <dir>    指定 DSH 源码 checkout 目录
  --json              输出机器可读 JSON
  --strict            SKIP（找不到目标）视为失败
  --list              只列出契约清单并退出
  -h, --help          显示本帮助

解析顺序: --asar → DSH_ASAR → ${DEFAULT_ASAR} → --checkout → DSH_CHECKOUT
`;

/**
 * 解析命令行参数。
 * @param {string[]} argv 原始参数（不含 node 与脚本名）。
 */
function parseArgs(argv) {
  const options = { json: false, strict: false, list: false, help: false, asar: undefined, checkout: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--asar":
      case "--checkout": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 需要一个路径参数`);
        options[arg.slice(2)] = value;
        i += 1;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`未知参数 ${JSON.stringify(arg)}（--help 查看用法）`);
    }
  }
  return options;
}

/** 人类可读渲染。 */
function printHuman(report) {
  const lines = [];
  lines.push(`[check-runtime-contract] 目标: ${report.target.kind} ${report.target.path}${report.target.source === undefined ? "" : `（来源 ${report.target.source}）`}`);
  if (report.target.version !== undefined) lines.push(`[check-runtime-contract] 运行时版本: ${report.target.version}`);
  if (report.skip === true) {
    lines.push(`[check-runtime-contract] SKIP: ${report.reason}`);
    return lines.join("\n");
  }
  for (const check of report.checks) {
    const mark = check.status === "PASS" ? "✅ PASS" : "❌ FAIL";
    lines.push(`${mark} ${check.id} ${check.title}`);
    for (const item of check.evidence) {
      lines.push(`         ↳ ${item.file}:${item.line}  ${item.snippet}`);
    }
    for (const failure of check.failures ?? []) {
      lines.push(`         ↳ 缺失: ${failure}`);
    }
  }
  lines.push(`[check-runtime-contract] 汇总: PASS=${report.summary.pass} FAIL=${report.summary.fail} SKIP=${report.summary.skip}`);
  return lines.join("\n");
}

/** 入口。 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-runtime-contract: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.list) {
    for (const contract of CONTRACTS) process.stdout.write(`${contract.id}\t${contract.title}\n`);
    return;
  }

  const resolved = await resolveTarget(options);
  const started = Date.now();
  if (resolved.skip === true || resolved.reader?.broken === true) {
    const target = resolved.skip === true
      ? { kind: "none", path: "(未找到)", source: undefined }
      : { kind: "asar", path: resolved.reader.label, source: resolved.source };
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      skip: true,
      reason: resolved.skip === true ? resolved.reason : `目标不可用：${resolved.reader.error}`,
      target,
      summary: { pass: 0, fail: 0, skip: CONTRACTS.length },
      checks: [],
    };
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`[check-runtime-contract] 目标: ${target.kind} ${target.path}\n`);
      process.stdout.write(`[check-runtime-contract] SKIP: ${report.reason}\n`);
      process.stdout.write(`[check-runtime-contract] 汇总: PASS=0 FAIL=0 SKIP=${CONTRACTS.length}${options.strict ? "（--strict：SKIP 视为失败）" : ""}\n`);
    }
    if (options.strict) process.exitCode = 1;
    return;
  }

  const reader = resolved.reader;
  const version = await readRuntimeVersion(reader);
  const checks = [];
  for (const contract of CONTRACTS) checks.push(await runContract(reader, contract));
  await reader.close();

  const summary = {
    pass: checks.filter((c) => c.status === "PASS").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
    skip: 0,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    skip: false,
    target: {
      kind: reader.kind,
      path: reader.label,
      source: resolved.source,
      version: version === undefined ? undefined : version.version,
      package: version === undefined ? undefined : version.name,
    },
    summary,
    checks,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`${printHuman(report)}\n`);
    if (options.strict && summary.fail === 0) process.stdout.write("[check-runtime-contract] --strict: 全部通过\n");
  }
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`check-runtime-contract: 未捕获异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
//#endregion
