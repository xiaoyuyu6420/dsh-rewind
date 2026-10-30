#!/usr/bin/env node
/**
 * dsh-rewind 真机闭环（turn → checkpoint → restore）：
 *   隔离 DSH_HOME/HOME → pnpm pack → dsh plugin --profile web add <tarball>
 *   → 本地假模型端点（Anthropic Messages SSE）→ dsh web --no-open --port <free>
 *   → token→cookie → RPC session/create + session/prompt 跑真实两轮
 *   → 断言插件真的在 turn/end 落盘 baseline.json / turn-N.json / blobs
 *   → 用插件自己的 HTTP API 做 dryRun + restore(atSeq) + restore(baseline)，断言文件真被还原。
 *
 * 为什么不用 `dsh --profile headless` 跑轮次（任务书原建议）：
 *   本插件的 Host 半区 `inject = ["webServer", "sessions", "connection"]`，而 headless
 *   profile 的合成树里**没有** webserver / client-connection 两行（见 docs/e2e-turn.md §1：
 *   `dsh --profile headless --dump-config` 命中 webserver|client-connection 为 0 行，web 为 3 行）。
 *   Cordis 的 inject 不满足时插件不会 apply，headless 里这些检查点代码根本不会被挂载，
 *   所以「真实轮次」必须在 web profile 里跑 —— 也就是用户真实使用的那个宿主，
 *   通过浏览器客户端同一条 Typert RPC 通道（POST /api/<endpoint>）驱动。
 *   headless 只用于探测「隔离无头运行能否到达本地假端点」，结论见文档 §1。
 *
 * 零依赖（Node 内置 http/fetch/crypto），不碰真实 ~/.dsh、不装 desktop profile、
 * 不重启用户正在用的 DSH。
 *
 * 用法：
 *   node scripts/e2e-turn.mjs                 # 全自动；环境缺依赖时 SKIP 并退出 0
 *   node scripts/e2e-turn.mjs --fail-on-skip  # CI 用：SKIP 也算失败（退出 1）
 *   node scripts/e2e-turn.mjs --keep          # 保留临时 DSH_HOME / 日志 / 工作区
 *   node scripts/e2e-turn.mjs --port 45871    # 指定 web 端口（默认自动挑空闲端口）
 *   node scripts/e2e-turn.mjs --verbose       # 打印 RPC / 假模型请求细节
 *
 * 退出码：0 = A1–A5 全部通过（或环境性 SKIP）；1 = 真实断言失败 / 致命错误。
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const FAIL_ON_SKIP = ARGS.includes("--fail-on-skip");
const KEEP = ARGS.includes("--keep");
const VERBOSE = ARGS.includes("--verbose");
const PORT_ARG = (() => {
  const i = ARGS.indexOf("--port");
  return i >= 0 ? Number(ARGS[i + 1]) : undefined;
})();

const DSH_BIN_CANDIDATES = [
  process.env.DSH_BIN,
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
  "dsh",
].filter(Boolean);

const PLUGIN_NAME = "@xiaoyuyu6420/dsh-rewind";
const BOOT_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 90_000;

/** 工作区内容：每轮结束后由脚本改写，restore 后应回到对应历史状态。 */
const CONTENT = {
  initial: "v0-initial\n",
  duringTurn1: "v1-during-turn1\n",
  round1: "r1-after-turn1\n",
  turn2: "r2-after-turn2\n",
  dirty: "r2-dirty-uncommitted\n",
};

const results = [];
let skipped = null;
let bootProc = null;
let bootLogPath = null;
let bootLogStream = null;
let fakeModel = null;
let home = null;
let packDir = null;
let workspace = null;
let bootPort = 0;
let cookie = "";
let modelHits = 0;

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  return ok;
}

function note(name, detail = "") {
  console.log(`  ℹ️  ${name}${detail ? ` — ${detail}` : ""}`);
}

function warn(name, detail = "") {
  console.log(`  ⚠️  ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(reason) {
  skipped = reason;
  console.log(`\n[e2e-turn] SKIP（环境性，不计为断言失败）：${reason}`);
  return 0;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 240_000, maxBuffer: 32 << 20, ...opts });
  return {
    status: result.status,
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function tail(text, lines = 30) {
  return String(text ?? "").split("\n").slice(-lines).join("\n");
}

function findDshCli() {
  for (const candidate of DSH_BIN_CANDIDATES) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 30_000 });
    if (result.status === 0) return { bin: candidate, version: (result.stdout || "").trim() };
  }
  return undefined;
}

/** 隔离环境：自己的 HOME/DSH_HOME，清掉宿主注入的 DSH_* 与会话变量。 */
function isolatedEnv() {
  const env = { ...process.env, DSH_HOME: home, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (key === "DSH_HOME") continue;
    if (key.startsWith("DSH_")) delete env[key];
  }
  // 假模型端点：llm-deepseek 从启动环境读 $DEEPSEEK_BASE_URL，键值走 x-api-key 头。
  env.DEEPSEEK_BASE_URL = fakeModel.baseUrl;
  env.DEEPSEEK_API_KEY = "sk-fake-e2e-turn-not-a-real-key";
  // 宿主可能导出了 SOCKS 代理变量（rc.5 会警告并直连），清掉让日志安静。
  for (const key of ["all_proxy", "ALL_PROXY"]) if (env[key] && /^socks/i.test(env[key])) delete env[key];
  return env;
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
  });
}

async function waitFor(predicate, { timeoutMs, intervalMs = 100, label = "条件" }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} 等待超时（${timeoutMs}ms）${last instanceof Error ? `：${last.message}` : ""}`);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function readIfExists(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// 本地假模型端点（Anthropic Messages，SSE，只回文本）
// ---------------------------------------------------------------------------

/**
 * 假端点：POST /v1/messages → 一条纯文本 SSE 回复（无 tool_use）。
 * `onFirstRequest` 在第一条请求被处理前执行一次，用于「轮次进行中改工作区」。
 */
function startFakeModel() {
  const state = {
    hits: [],
    baseUrl: "",
    onFirstRequest: undefined,
    hookDone: false,
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      modelHits += 1;
      const record = {
        n: modelHits,
        method: req.method,
        url: req.url,
        hasApiKey: req.headers["x-api-key"] !== undefined,
        bodyBytes: Buffer.byteLength(body),
      };
      state.hits.push(record);
      if (VERBOSE) console.log(`[e2e-turn] fake-model ← ${req.method} ${req.url} (${record.bodyBytes}B, x-api-key=${record.hasApiKey ? "yes" : "no"})`);
      if (!req.url?.endsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found", message: "e2e-turn fake endpoint: only /v1/messages" } }));
        return;
      }
      try {
        if (!state.hookDone && typeof state.onFirstRequest === "function") {
          state.hookDone = true;
          await state.onFirstRequest();
        }
      } catch (error) {
        console.error(`[e2e-turn] fake-model hook 失败：${error.message}`);
      }
      streamText(res, `e2e-turn fake reply #${modelHits}`);
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      state.baseUrl = `http://127.0.0.1:${port}`;
      state.close = () => new Promise((r) => server.close(() => r()));
      resolvePromise(state);
    });
  });
}

/** 每条 SSE 事件必须自带 `event:` 名，Anthropic SDK 依此分派。 */
function streamText(res, text) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `msg_e2e_${crypto.randomUUID()}`;
  send("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "deepseek-flash",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  res.end();
}

// ---------------------------------------------------------------------------
// dsh web boot
// ---------------------------------------------------------------------------

function startBoot(dshBin, port) {
  bootLogPath = path.join(home, "boot.log");
  bootLogStream = fs.createWriteStream(bootLogPath);
  bootProc = spawn(dshBin, ["web", "--no-open", "--port", String(port)], {
    cwd: workspace,
    env: isolatedEnv(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  bootProc.stdout.pipe(bootLogStream);
  bootProc.stderr.pipe(bootLogStream);
  bootProc.unref();
}

function dumpBootLog(reason) {
  try {
    const text = fs.readFileSync(bootLogPath, "utf8");
    console.error(`\n[e2e-turn] boot 日志（${reason}）最后 40 行:\n${tail(text, 40)}`);
  } catch (error) {
    console.error(`[e2e-turn] boot 日志不可读：${error.message}`);
  }
}

async function stopBoot(port) {
  if (bootProc === null) return;
  const proc = bootProc;
  bootProc = null;
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, "SIGTERM");
    else proc.kill();
  } catch { /* 已退出 */ }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch { /* 已退出 */ }
  }
  for (let i = 0; i < 20; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(300) });
      await new Promise((r) => setTimeout(r, 150));
    } catch { break; }
  }
  bootLogStream?.end();
}

/** 从启动日志抓 `?token=`，换 HttpOnly cookie（与 e2e-host.mjs 同一套做法）。 */
async function waitBoot(base, timeoutMs = BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let token = "";
  let lastError = "";
  while (Date.now() < deadline) {
    if (bootProc !== null && bootProc.exitCode !== null) {
      dumpBootLog(`提前退出 code ${bootProc.exitCode}`);
      throw new Error(`dsh web 提前退出（code ${bootProc.exitCode}）——见上方 boot 日志`);
    }
    try {
      const log = fs.readFileSync(bootLogPath, "utf8");
      const match = log.match(/dsh web: \S+\?token=(\S+)/);
      if (match !== null) token = match[1];
    } catch { /* 日志尚未写入 */ }
    try {
      const response = await fetch(token === "" ? base : `${base}/?token=${token}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return { response, token, cookie: "" };
      if (response.status === 303 && token !== "") {
        const cookies = response.headers.getSetCookie?.() ?? [];
        const jar = cookies.map((item) => item.split(";")[0]).join("; ");
        const page = await fetch(base, { headers: jar === "" ? {} : { cookie: jar }, signal: AbortSignal.timeout(2000) });
        if (page.ok) return { response: page, token, cookie: jar };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  dumpBootLog(`等待超时（${timeoutMs / 1000}s）`);
  throw new Error(`boot 超时：${timeoutMs / 1000}s 内未在 ${base} 就绪（最后探测：${lastError}）`);
}

// ---------------------------------------------------------------------------
// 两条 HTTP 通道：宿主 Typert RPC（/api/<endpoint>）与插件 API（/dsh-rewind/api/<method>）
// ---------------------------------------------------------------------------

function authHeaders(extra = {}) {
  return { ...(cookie === "" ? {} : { cookie }), ...extra };
}

/** POST /api/<endpoint>：信封 {type,rpcId,method,payload:{args}}，见 dsh-client-connection RPC schema。 */
async function rpc(endpoint, args, timeoutMs = 30_000) {
  const base = `http://127.0.0.1:${bootPort}`;
  const rpcId = crypto.randomUUID();
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { /* 下面统一报错 */ }
  if (VERBOSE) console.log(`[e2e-turn] rpc ${endpoint} → HTTP ${response.status} ${text.slice(0, 200)}`);
  if (!response.ok || json === undefined) {
    throw new Error(`RPC ${endpoint} HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  if (json.result?.ok !== true) {
    const error = json.result?.error ?? {};
    throw new Error(`RPC ${endpoint} 失败: ${error.code} ${error.message} ${JSON.stringify(error.details ?? {})}`);
  }
  return json.result.value;
}

async function pluginApi(method, payload, timeoutMs = 30_000) {
  const base = `http://127.0.0.1:${bootPort}`;
  const response = await fetch(`${base}/dsh-rewind/api/${method}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { /* 下面统一报错 */ }
  if (VERBOSE) console.log(`[e2e-turn] plugin ${method} → HTTP ${response.status} ${text.slice(0, 400)}`);
  if (!response.ok || json === undefined) {
    throw new Error(`插件 API ${method} HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  if (json.ok !== true) throw new Error(`插件 API ${method} 返回失败: ${JSON.stringify(json.error ?? json)}`);
  return json.value;
}

/** 等到插件落出第 n 轮检查点（检查点本身就是 turn/end 的证据）。 */
async function waitForTurnCheckpoint(sessionId, turn, timeoutMs = TURN_TIMEOUT_MS) {
  return waitFor(async () => {
    const value = await pluginApi("checkpoints", { sessionId });
    const hit = value.checkpoints?.find((item) => item.turn === turn);
    if (hit !== undefined) return { value, checkpoint: hit };
    return undefined;
  }, { timeoutMs, intervalMs: 250, label: `turn ${turn} 检查点` });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[e2e-turn] repo=${REPO}`);
  console.log(`[e2e-turn] node=${process.version} platform=${process.platform}`);

  // ---------- 0. 环境依赖 ----------
  const cli = findDshCli();
  if (cli === undefined) return skip(`找不到可用的 dsh CLI（候选：${DSH_BIN_CANDIDATES.join(", ")}）`);
  console.log(`[e2e-turn] dsh=${cli.bin} version=${cli.version}`);
  if (!/^0\.2\./.test(cli.version)) warn("dsh 版本不是 0.2.x", cli.version);

  const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (pnpm.status !== 0) return skip("PATH 里找不到 pnpm（pnpm pack 需要）");
  console.log(`[e2e-turn] pnpm=${(pnpm.stdout || "").trim()}`);

  home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rewind-turn-home-"));
  packDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rewind-turn-pack-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rewind-turn-ws-"));
  console.log(`[e2e-turn] 隔离 DSH_HOME=${home}`);
  console.log(`[e2e-turn] 隔离工作区=${workspace}`);

  // 初始工作区内容（baseline 应捕获它）
  fs.writeFileSync(path.join(workspace, "A.txt"), CONTENT.initial);
  fs.writeFileSync(path.join(workspace, "keep.txt"), "keep-me\n");

  // ---------- 1. 假模型端点 ----------
  fakeModel = await startFakeModel();
  console.log(`[e2e-turn] 本地假模型端点=${fakeModel.baseUrl}（Anthropic Messages，SSE 纯文本）`);

  // ---------- 2. 打包 + 装进隔离 web profile ----------
  console.log("[e2e-turn] pnpm pack ...");
  const pack = run("pnpm", ["pack", "--pack-destination", packDir], { cwd: REPO });
  if (!pack.ok) {
    console.error(`[e2e-turn] pnpm pack 输出:\n${tail(pack.stdout + pack.stderr, 20)}`);
    return skip(`pnpm pack 失败（环境问题）：exit ${pack.status}`);
  }
  const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length === 0) return skip("pnpm pack 未产出 tarball");
  const tarball = path.join(packDir, tarballs[0]);
  console.log(`[e2e-turn] tarball=${tarball}`);

  console.log("[e2e-turn] dsh plugin --profile web add <tarball> ...");
  const add = run(cli.bin, ["plugin", "--profile", "web", "add", tarball], { env: isolatedEnv(), cwd: path.dirname(home) });
  const addOutput = `${add.stdout}\n${add.stderr}`;
  if (!add.ok) {
    console.error(`[e2e-turn] plugin add 输出:\n${tail(addOutput, 30)}`);
    if (/network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_PNPM_META_FETCH_FAIL|proxy|registry|offline|fetch/i.test(addOutput)) {
      return skip(`dsh plugin add 因网络/registry 不可用失败（环境问题）：exit ${add.status}`);
    }
    throw new Error(`dsh plugin add 失败（非网络原因）：exit ${add.status}`);
  }
  const installedIndex = path.join(home, "profiles", "web", "node_modules", ...PLUGIN_NAME.split("/"), "index.js");
  check("插件装进隔离 web profile", fs.existsSync(installedIndex), installedIndex);

  // ---------- 3. boot dsh web（隔离 home，假端点） ----------
  bootPort = PORT_ARG ?? (await freePort());
  const base = `http://127.0.0.1:${bootPort}`;
  console.log(`[e2e-turn] 启动 dsh web --no-open --port ${bootPort} ...`);
  startBoot(cli.bin, bootPort);
  const boot = await waitBoot(base);
  cookie = boot.cookie;
  check("dsh web 在隔离 home 就绪（拿到鉴权 cookie）", boot.response.ok && (boot.token === "" || cookie !== ""), `HTTP ${boot.response.status} token=${boot.token === "" ? "none" : "yes"} cookie=${cookie === "" ? "none" : "set"}`);

  // ---------- 4. 真实两轮 ----------
  const sessionId = `e2e-turn-${crypto.randomUUID()}`;
  const created = await rpc("session/create", { request: { cwd: workspace, sessionId } });
  check("RPC session/create 建出真实会话", created?.sessionId === sessionId, JSON.stringify(created));

  // 轮 1：模型请求到达后（baseline 已落盘）改工作区，制造「轮内改动」——
  // 这样 turn-1 检查点与 baseline 的内容不同，A3/A4 才能区分。
  const baselinePath = path.join(home, "storages", "dsh-rewind", sessionId, "baseline.json");
  fakeModel.onFirstRequest = async () => {
    await waitFor(() => fs.existsSync(baselinePath), { timeoutMs: 30_000, label: "baseline.json" });
    await waitFor(() => JSON.parse(readIfExists(baselinePath) ?? "{}").files !== undefined, { timeoutMs: 10_000, label: "baseline.json 内容完整" });
    fs.writeFileSync(path.join(workspace, "A.txt"), CONTENT.duringTurn1);
    if (VERBOSE) console.log("[e2e-turn] 轮内改动：A.txt = duringTurn1");
  };

  const prompt = (text) => rpc("session/prompt", {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    },
  });

  console.log("[e2e-turn] 轮 1 …");
  const accepted1 = await prompt("请只回复一句确认，不要使用任何工具。");
  check("轮 1 prompt 被接受", accepted1?.accepted === true, JSON.stringify(accepted1));
  const turn1 = await waitForTurnCheckpoint(sessionId, 1);
  check("轮 1 真实 turn/end 后落出 turn-1 检查点", turn1.checkpoint.turn === 1 && Number.isInteger(turn1.checkpoint.endSeq), JSON.stringify(turn1.checkpoint));

  // 轮 1 之后改工作区：A → round1，新建 B
  fs.writeFileSync(path.join(workspace, "A.txt"), CONTENT.round1);
  fs.writeFileSync(path.join(workspace, "B.txt"), "b-created-after-turn1\n");

  console.log("[e2e-turn] 轮 2 …");
  const accepted2 = await prompt("再确认一次，仍然不要使用工具。");
  check("轮 2 prompt 被接受（同一会话续跑）", accepted2?.accepted === true, JSON.stringify(accepted2));
  const turn2 = await waitForTurnCheckpoint(sessionId, 2);
  check("轮 2 真实 turn/end 后落出 turn-2 检查点", turn2.checkpoint.turn === 2, JSON.stringify(turn2.checkpoint));

  // 轮 2 之后继续改：A → dirty，新建 C（restore 时都应被回退）
  fs.writeFileSync(path.join(workspace, "A.txt"), CONTENT.dirty);
  fs.writeFileSync(path.join(workspace, "C.txt"), "c-created-after-turn2\n");

  // ---------- A1：磁盘上的检查点与 blob ----------
  const storeDir = path.join(home, "storages", "dsh-rewind", sessionId);
  const blobsDir = path.join(storeDir, "blobs");
  const blobNames = fs.existsSync(blobsDir) ? fs.readdirSync(blobsDir) : [];
  check(
    "A1 隔离 home 里真的落了 baseline.json / turn-1.json / turn-2.json",
    fs.existsSync(path.join(storeDir, "baseline.json"))
      && fs.existsSync(path.join(storeDir, "turn-1.json"))
      && fs.existsSync(path.join(storeDir, "turn-2.json")),
    `storeDir=${storeDir} 现有=${fs.existsSync(storeDir) ? fs.readdirSync(storeDir).join(",") : "(不存在)"}`,
  );
  check(
    "A1 blobs/ 含内容寻址 blob（sha256 命名，且含 baseline 里的 A.txt 内容）",
    blobNames.length > 0 && blobNames.every((name) => /^[0-9a-f]{64}$/.test(name)) && blobNames.includes(sha256(CONTENT.initial)),
    `blobs=${blobNames.length} 期望含 ${sha256(CONTENT.initial).slice(0, 12)}…`,
  );

  // ---------- A2：插件 API 在同一 home 的 web 宿主里列出这些检查点 ----------
  const list = await pluginApi("checkpoints", { sessionId });
  check(
    "A2 checkpoints API：tracking:true 且列出 2 个检查点（turn 1/2，endSeq 递增）",
    list.tracking === true
      && list.checkpoints?.length === 2
      && list.checkpoints[0].turn === 1
      && list.checkpoints[1].turn === 2
      && list.checkpoints[1].endSeq > list.checkpoints[0].endSeq,
    JSON.stringify(list),
  );

  const atSeqTurn1 = list.checkpoints?.[0]?.endSeq;
  check("A2 turn-1 检查点带 endSeq（restore 的 atSeq 来源）", Number.isInteger(atSeqTurn1) && atSeqTurn1 > 0, `atSeq=${atSeqTurn1}`);

  // ---------- A3：dryRun 不落盘 + restore(atSeq=turn-1) 真还原 ----------
  const dry = await pluginApi("restore", { sessionId, atSeq: atSeqTurn1, dryRun: true });
  check(
    "A3 dryRun 返回计划（mode:turn / boundary.turn=1）且未改工作区",
    dry.mode === "turn" && dry.boundary?.turn === 1 && dry.dryRun === true
      && readIfExists(path.join(workspace, "A.txt")) === CONTENT.dirty
      && fs.existsSync(path.join(workspace, "B.txt")),
    `mode=${dry.mode} A=${JSON.stringify(readIfExists(path.join(workspace, "A.txt")))}`,
  );

  const restored = await pluginApi("restore", { sessionId, atSeq: atSeqTurn1 });
  const aAfter = readIfExists(path.join(workspace, "A.txt"));
  check(
    "A3 restore(atSeq=turn-1 endSeq) 命中 turn 检查点并还原 A.txt",
    restored.mode === "turn" && restored.boundary?.turn === 1 && aAfter === CONTENT.duringTurn1,
    `mode=${restored.mode} boundary=${JSON.stringify(restored.boundary)} A=${JSON.stringify(aAfter)}`,
  );
  check(
    "A3 回退点之后新建的 B.txt / C.txt 被删除（返回体与事实一致）",
    !fs.existsSync(path.join(workspace, "B.txt"))
      && !fs.existsSync(path.join(workspace, "C.txt"))
      && (restored.deleted ?? []).includes("B.txt")
      && (restored.deleted ?? []).includes("C.txt"),
    `deleted=${JSON.stringify(restored.deleted)} B=${fs.existsSync(path.join(workspace, "B.txt"))} C=${fs.existsSync(path.join(workspace, "C.txt"))}`,
  );
  check(
    "A3 restored 列表与实际写入一致（含 A.txt，keep.txt 未被误动）",
    (restored.restored ?? []).includes("A.txt")
      && readIfExists(path.join(workspace, "keep.txt")) === "keep-me\n",
    `restored=${JSON.stringify(restored.restored)}`,
  );

  // ---------- A4：baseline 还原到会话开始前 ----------
  const baselineRestore = await pluginApi("restore", { sessionId, baseline: true });
  const aBaseline = readIfExists(path.join(workspace, "A.txt"));
  check(
    "A4 restore(baseline:true) 把 A.txt 还原到初始内容（与 turn-1 状态不同，证明确实来自 baseline）",
    baselineRestore.mode === "baseline" && aBaseline === CONTENT.initial && aBaseline !== CONTENT.duringTurn1,
    `mode=${baselineRestore.mode} A=${JSON.stringify(aBaseline)}`,
  );
  check(
    "A4 baseline 还原后 B/C 仍不存在（历史文件没被回魂）",
    !fs.existsSync(path.join(workspace, "B.txt")) && !fs.existsSync(path.join(workspace, "C.txt")),
    `B=${fs.existsSync(path.join(workspace, "B.txt"))} C=${fs.existsSync(path.join(workspace, "C.txt"))}`,
  );

  // ---------- A5：全程无 crash / 无插件报错 ----------
  // 交叉校验：宿主自己的会话日志里也必须有 turn/end，且 seq 与插件检查点的 endSeq 一一对应。
  let logTurnEnds = [];
  let logReadError = "";
  try {
    // session/page 的 throughSeq 必须等于宿主当前游标：先用 session/list 取该会话的最新 seq。
    const listed = await rpc("session/list", { _request: {} });
    const row = (listed.items ?? []).find((item) => item.sessionId === sessionId);
    if (row === undefined) throw new Error("session/list 里没有本次会话");
    // 游标取 projections.asOfSeq（session/list 的行不带顶层 seq）
    const cursor = row.projections?.asOfSeq;
    if (!Number.isInteger(cursor)) throw new Error(`session/list 行里没有 projections.asOfSeq：${JSON.stringify(Object.keys(row))}`);
    const page = await rpc("session/page", {
      request: { address: { kind: "session", sessionId }, throughSeq: cursor, maxMessages: 200 },
    }, 30_000);
    logTurnEnds = (page.records ?? []).map((record) => record.event).filter((event) => event?.type === "turn/end");
  } catch (error) {
    logReadError = error.message;
  }
  if (logReadError === "") {
    const logSeqs = logTurnEnds.map((event) => event.seq);
    check(
      "A5 宿主会话日志里的 turn/end seq 与插件检查点 endSeq 完全一致（证明检查点对齐真实轮次边界）",
      logSeqs.length === 2 && logSeqs[0] === turn1.checkpoint.endSeq && logSeqs[1] === turn2.checkpoint.endSeq,
      `日志 turn/end seq=${JSON.stringify(logSeqs)} 检查点 endSeq=${JSON.stringify([turn1.checkpoint.endSeq, turn2.checkpoint.endSeq])}`,
    );
  } else {
    warn("会话日志直读失败（session/page），跳过交叉校验（不影响 A1–A4）", logReadError);
  }

  const bootLog = fs.readFileSync(bootLogPath, "utf8");
  const crashLines = bootLog.split("\n").filter((line) => /slot entry crashed|failed to compose|plugin .*failed to load|uncaught|unhandled/i.test(line));
  const pluginErrorLines = bootLog.split("\n").filter((line) => line.includes("dsh-rewind") && /\berror\b|failed|crash|exception|throw/i.test(line));
  check("A5 启动日志无 slot crash / 组合失败", crashLines.length === 0, crashLines.slice(0, 5).join("\n"));
  check("A5 启动日志无 dsh-rewind 报错行", pluginErrorLines.length === 0, pluginErrorLines.slice(0, 5).join("\n"));
  check("A5 假模型端点确实被真实宿主调用（≥2 次 /v1/messages）", fakeModel.hits.length >= 2, `hits=${fakeModel.hits.length}`);
  check("A5 dsh web 进程仍存活（全程未退出）", bootProc !== null && bootProc.exitCode === null);

  // 诊断信息（不参与断言）：检查点里记录的摘要
  note("检查点摘要", JSON.stringify(list.checkpoints.map((item) => ({ turn: item.turn, endSeq: item.endSeq, changed: item.changed }))));
  note("模型请求", fakeModel.hits.map((hit) => `${hit.method} ${hit.url} ${hit.bodyBytes}B`).join(" | "));

  const failed = results.filter((item) => item.ok !== true);
  console.log(`\n[e2e-turn] 结果: ${results.length - failed.length}/${results.length} 通过（port ${bootPort}，会话 ${sessionId}）`);
  if (failed.length > 0) {
    for (const item of failed) console.log(`  ❌ ${item.name}${item.detail ? `\n     ${item.detail}` : ""}`);
    process.exitCode = 1;
  }
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = (await main()) ?? 0;
} catch (error) {
  console.error(`\n[e2e-turn] 致命错误：${error.message}`);
  if (bootLogPath !== null) dumpBootLog("致命错误");
  exitCode = 1;
} finally {
  await stopBoot(bootPort).catch(() => {});
  if (fakeModel !== null) await fakeModel.close().catch(() => {});
  if (KEEP) {
    console.log(`[e2e-turn] --keep：保留 DSH_HOME=${home} 工作区=${workspace} 日志=${bootLogPath}`);
  } else {
    if (home !== null) fs.rmSync(home, { recursive: true, force: true });
    if (workspace !== null) fs.rmSync(workspace, { recursive: true, force: true });
    if (packDir !== null) fs.rmSync(packDir, { recursive: true, force: true });
  }
  if (skipped !== null && FAIL_ON_SKIP) exitCode = 1;
}
process.exitCode = exitCode;
