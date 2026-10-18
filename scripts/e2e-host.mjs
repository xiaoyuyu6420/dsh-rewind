#!/usr/bin/env node
/**
 * dsh-rewind 真机 boot 冒烟（e2e）：
 *   隔离 DSH_HOME/HOME → pnpm pack 本仓库 → dsh plugin --profile web add <tarball>
 *   → dsh web --no-open --port <free> → 解析启动日志里的 token 换 HttpOnly cookie
 *   → HTTP 断言 boot / 客户端 bundle / host API / 鉴权 / 启动日志无插件报错。
 *
 * 零依赖（Node 内置 fetch / vm），不碰真实 ~/.dsh、不装 desktop profile、不重启用户
 * 正在用的 DSH，也不依赖 dsh-backup（那个项目只作为模式参考，绝不修改）。
 *
 * 用法：
 *   node scripts/e2e-host.mjs                # 全自动；环境缺依赖（无 dsh/pnpm/网络）时 SKIP 并退出 0
 *   node scripts/e2e-host.mjs --fail-on-skip # CI 用：SKIP 也算失败（退出 1）
 *   node scripts/e2e-host.mjs --keep         # 保留临时 DSH_HOME / boot.log 便于排查
 *   node scripts/e2e-host.mjs --port 45871   # 指定端口（默认自动挑空闲端口）
 *
 * 退出码：0 = 全部断言通过（或环境性 SKIP）；1 = 真实断言失败/致命错误。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const FAIL_ON_SKIP = ARGS.includes("--fail-on-skip");
const KEEP = ARGS.includes("--keep");
const PORT_ARG = (() => {
  const i = ARGS.indexOf("--port");
  return i >= 0 ? Number(ARGS[i + 1]) : undefined;
})();

const DSH_BIN_CANDIDATES = [
  process.env.DSH_BIN,
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
  "dsh",
].filter(Boolean);

const BOOT_TIMEOUT_MS = 120_000;
const PLUGIN_NAME = "@local/dsh-rewind";
const results = [];
let skipped = null;
let bootProc = null;
let bootLogPath = null;
let bootLogStream = null;
let home = null;
let packDir = null;
let bootStartedAt = 0;
let bootPort = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  return ok;
}

function warn(name, detail = "") {
  console.log(`  ⚠️  ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(reason) {
  skipped = reason;
  console.log(`\n[e2e-host] SKIP（环境性，不计为断言失败）：${reason}`);
  return 0;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 240_000, maxBuffer: 32 << 20, ...opts });
  return {
    status: result.status,
    signal: result.signal,
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
    if (result.status === 0) {
      return { bin: candidate, version: (result.stdout || "").trim() };
    }
  }
  return undefined;
}

/** Environment for every isolated dsh invocation: own HOME/DSH_HOME, scrubbed session vars. */
function isolatedEnv() {
  const env = { ...process.env, DSH_HOME: home, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (key === "DSH_HOME") continue;
    if (key.startsWith("DSH_")) delete env[key];
  }
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

function dumpBootLog(reason) {
  try {
    const text = fs.readFileSync(bootLogPath, "utf8");
    console.error(`\n[e2e-host] boot 日志（${reason}）最后 40 行:\n${tail(text, 40)}`);
  } catch (error) {
    console.error(`[e2e-host] boot 日志不可读：${error.message}`);
  }
}

function startBoot(dshBin, port) {
  bootLogPath = path.join(home, "boot.log");
  bootLogStream = fs.createWriteStream(bootLogPath);
  bootStartedAt = Date.now();
  bootProc = spawn(dshBin, ["web", "--no-open", "--port", String(port)], {
    cwd: home,
    env: isolatedEnv(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  bootProc.stdout.pipe(bootLogStream);
  bootProc.stderr.pipe(bootLogStream);
  bootProc.unref();
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
    const alive = proc.exitCode === null && proc.signalCode === null;
    if (!alive) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch { /* 已退出 */ }
  }
  // 等端口彻底释放，避免同进程后续再 boot 撞 EADDRINUSE
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 20; i += 1) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(300) });
      await new Promise((r) => setTimeout(r, 150));
    } catch { break; }
  }
  bootLogStream?.end();
}

async function waitBoot(base, timeoutMs = BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let token = "";
  let cookie = "";
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
      if (response.ok) {
        return { response, token, cookie, bootMs: Date.now() - bootStartedAt };
      }
      if (response.status === 303 && token !== "") {
        const cookies = response.headers.getSetCookie?.() ?? [];
        cookie = cookies.map((item) => item.split(";")[0]).join("; ");
        const page = await fetch(base, { headers: cookie === "" ? {} : { cookie }, signal: AbortSignal.timeout(2000) });
        if (page.ok) return { response: page, token, cookie, bootMs: Date.now() - bootStartedAt };
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

/** In a browser ModuleLoader sandbox, evaluate the served combo bundle and pull our plugin entry. */
function inspectClientBundle(bundleSource) {
  const entries = [];
  const React = {
    Component: class Component {
      constructor(props) { this.props = props ?? {}; this.state = {}; }
      setState(next) { this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) }; }
      render() { return null; }
    },
    Fragment: "Fragment",
    createElement: () => null,
    useState: (value) => [typeof value === "function" ? value() : value, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    createContext: (value) => ({ _v: value, Provider: ({ children }) => children ?? null, Consumer: () => null }),
    useContext: (context) => context?._v,
  };
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (entry) => entries.push(entry) },
      addEventListener() {}, removeEventListener() {},
    },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: {
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; },
      createElement() { return { style: {}, select() {}, remove() {} }; },
      body: { appendChild() {} },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: {},
    fetch: async () => { throw new Error("sandbox: fetch 不可用"); },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleSource, sandbox, { filename: "combo-client.js", timeout: 20_000 });
  const entry = entries.find((item) => item?.id === PLUGIN_NAME);
  if (entry === undefined) {
    throw new Error(`combo bundle 里没有注册 ${PLUGIN_NAME}；已注册=${JSON.stringify(entries.map((item) => item?.id).slice(0, 20))}`);
  }
  const plugin = entry.factory((specifier) => {
    if (specifier === "react") return React;
    throw new Error(`client bundle 请求了预期外的外部依赖: ${specifier}`);
  });
  return { entries: entries.map((item) => item?.id), plugin };
}

async function main() {
  console.log(`[e2e-host] repo=${REPO}`);
  console.log(`[e2e-host] node=${process.version} platform=${process.platform}`);

  // ---------- 0. 环境依赖 ----------
  const cli = findDshCli();
  if (cli === undefined) return skip(`找不到可用的 dsh CLI（候选：${DSH_BIN_CANDIDATES.join(", ")}）`);
  console.log(`[e2e-host] dsh=${cli.bin} version=${cli.version}`);
  if (!/^0\.2\./.test(cli.version)) warn("dsh 版本不是 0.2.x（本插件按 0.2.1-rc.2 编写）", cli.version);

  const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (pnpm.status !== 0) return skip("PATH 里找不到 pnpm（pnpm pack 需要）");
  console.log(`[e2e-host] pnpm=${(pnpm.stdout || "").trim()}`);

  home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rewind-e2e-home-"));
  packDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rewind-e2e-pack-"));
  console.log(`[e2e-host] 隔离 DSH_HOME=${home}`);

  // ---------- 1. pnpm pack ----------
  console.log("[e2e-host] pnpm pack ...");
  const pack = run("pnpm", ["pack", "--pack-destination", packDir], { cwd: REPO });
  if (!pack.ok) {
    console.error(`[e2e-host] pnpm pack 输出:\n${tail(pack.stdout + pack.stderr, 20)}`);
    return skip(`pnpm pack 失败（环境问题，非插件断言）：exit ${pack.status}`);
  }
  const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length === 0) return skip("pnpm pack 未产出 tarball");
  const tarball = path.join(packDir, tarballs[0]);
  console.log(`[e2e-host] tarball=${tarball}`);

  // ---------- 2. 安装进隔离 web profile ----------
  console.log("[e2e-host] dsh plugin --profile web add <tarball> ...");
  const add = run(cli.bin, ["plugin", "--profile", "web", "add", tarball], { env: isolatedEnv(), cwd: path.dirname(home) });
  const addOutput = `${add.stdout}\n${add.stderr}`;
  if (!add.ok) {
    console.error(`[e2e-host] plugin add 输出:\n${tail(addOutput, 30)}`);
    if (/network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_PNPM_META_FETCH_FAIL|proxy|registry|offline|fetch/i.test(addOutput)) {
      return skip(`dsh plugin add 因网络/registry 不可用失败（环境问题）：exit ${add.status}`);
    }
    throw new Error(`dsh plugin add 失败（非网络原因）：exit ${add.status}；见上方输出`);
  }
  check("dsh plugin add 成功", true);

  const installedIndex = path.join(home, "profiles", "web", "node_modules", "@local", "dsh-rewind", "index.js");
  const installedPkg = path.join(home, "profiles", "web", "package.json");
  let profilePkg = {};
  try { profilePkg = JSON.parse(fs.readFileSync(installedPkg, "utf8")); } catch { /* 下面断言会报 */ }
  const profileDeps = profilePkg?.dependencies ?? {};
  const profileBundles = profilePkg?.dsh?.profile?.bundles ?? [];
  check(
    "tarball 安装到隔离 profile（index.js + bundle 声明）",
    fs.existsSync(installedIndex) && profileDeps[PLUGIN_NAME] !== undefined && profileBundles.includes(PLUGIN_NAME),
    `installed=${fs.existsSync(installedIndex)} dep=${JSON.stringify(profileDeps)} bundles=${JSON.stringify(profileBundles)}`,
  );

  // ---------- 3. boot web ----------
  const port = PORT_ARG ?? (await freePort());
  bootPort = port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[e2e-host] 启动 dsh web --no-open --port ${port}（隔离 HOME/DSH_HOME）...`);
  startBoot(cli.bin, port);
  const boot = await waitBoot(base);
  const cookie = boot.cookie;
  const authed = (options = {}) => {
    const { headers = {}, ...rest } = options;
    return { ...rest, headers: { ...(cookie === "" ? {} : { cookie }), ...headers } };
  };
  check("boot 后 Web shell 返回 200", boot.response.ok, `HTTP ${boot.response.status}`);
  console.log(`[e2e-host] boot 耗时 ${boot.bootMs}ms；token 模式=${boot.token === "" ? "无 token" : "token→cookie"}；cookie=${cookie === "" ? "(none)" : "set"}`);

  const html = await boot.response.text();
  check("Web shell HTML 有内容", html.length > 1000, `len=${html.length}`);

  // ---------- 4. 客户端半区：启动图里出现本插件 bundle 并能被 ModuleLoader 解析 ----------
  const combos = [...html.matchAll(/<link[^>]+href="([^"]*plugins\/\?\?[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const ourCombo = combos.find((item) => item.includes(`${PLUGIN_NAME}/client.js`));
  check(
    "index HTML 的启动预加载列表包含本插件 client bundle",
    ourCombo !== undefined,
    `combo 数=${combos.length}；示例=${JSON.stringify(combos.slice(0, 2).map((item) => item.slice(0, 120)))}`,
  );

  if (ourCombo !== undefined) {
    const comboUrl = new URL(ourCombo, `${base}/`);
    const comboRes = await fetch(comboUrl, { headers: cookie === "" ? {} : { cookie }, signal: AbortSignal.timeout(30_000) });
    const comboBody = await comboRes.text();
    check("client bundle combo 可下载（200 且含本插件代码）", comboRes.ok && comboBody.includes("dsh-rewind"), `HTTP ${comboRes.status} len=${comboBody.length}`);
    try {
      const { entries, plugin } = inspectClientBundle(comboBody);
      check(
        "client bundle 可在 ModuleLoader 沙箱里导出插件面（apply/inject）",
        typeof plugin?.apply === "function" && Array.isArray(plugin?.inject) && plugin.inject.includes("slots"),
        `entries=${entries.length} inject=${JSON.stringify(plugin?.inject)}`,
      );
    } catch (error) {
      // combo 里还打包了别的插件；若是别的插件在沙箱里抛错，不能算本插件失败
      if (String(error.message).includes(PLUGIN_NAME) || String(error.message).includes("请求了预期外的外部依赖")) {
        check("client bundle 可在 ModuleLoader 沙箱里导出插件面（apply/inject）", false, error.message);
      } else {
        warn("client bundle 沙箱解析被 combo 内其它插件打断，本插件条目无法单独验证", error.message);
      }
    }
  }

  // ---------- 5. Host 半区：路由注册 + 鉴权 + 真实请求 ----------
  const apiPath = "/dsh-rewind/api/checkpoints";
  const postRes = await fetch(`${base}${apiPath}`, authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "e2e-smoke-unknown-session" }),
    signal: AbortSignal.timeout(15_000),
  }));
  const postBody = await postRes.text();
  let postJson;
  try { postJson = JSON.parse(postBody); } catch { /* 下面断言会报 */ }
  check(
    "POST /dsh-rewind/api/checkpoints 返回 200 且 tracking:false（host 半区 apply() 真的跑了）",
    postRes.status === 200 && postJson?.ok === true && postJson?.value?.tracking === false,
    `HTTP ${postRes.status} body=${postBody.slice(0, 300)}`,
  );

  const getRes = await fetch(`${base}${apiPath}`, authed({ signal: AbortSignal.timeout(15_000) }));
  const getBody = await getRes.text();
  let getJson;
  try { getJson = JSON.parse(getBody); } catch { /* 下面断言会报 */ }
  check(
    "GET /dsh-rewind/api/checkpoints 返回 405（路由已注册，不是 fallback 404）",
    getRes.status === 405 && getJson?.error?.code === "method-error",
    `HTTP ${getRes.status} body=${getBody.slice(0, 200)}`,
  );

  const unauthRes = await fetch(`${base}${apiPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  check("无 cookie 调 API 返回 401（鉴权 fail-closed）", unauthRes.status === 401, `HTTP ${unauthRes.status}`);

  const unknownRes = await fetch(`${base}/dsh-rewind/api/nope`, authed({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  }));
  check("未知方法返回 404（API 前缀路由生效）", unknownRes.status === 404, `HTTP ${unknownRes.status}`);

  // ---------- 6. 启动日志：无插件报错 / slot crash ----------
  const bootLog = fs.readFileSync(bootLogPath, "utf8");
  const pluginLines = bootLog.split("\n").filter((line) => line.includes("dsh-rewind"));
  const errorish = bootLog
    .split("\n")
    .filter((line) => /slot entry crashed|failed to compose|client bundles not found|plugin .*failed|加载.*失败/i.test(line));
  const pluginErrorish = pluginLines.filter((line) => /error|fail|crash|exception|throw/i.test(line));
  check("启动日志无 slot crash / client 组合失败", errorish.length === 0, errorish.slice(0, 5).join("\n"));
  check("启动日志无 dsh-rewind 报错行", pluginErrorish.length === 0, pluginErrorish.slice(0, 5).join("\n"));
  if (pluginLines.length > 0) warn("启动日志提到 dsh-rewind（请人工确认非报错）", pluginLines.slice(0, 5).join(" | "));

  // ---------- 7. 进程仍存活 ----------
  check("dsh web 进程仍在运行（boot 后未退出）", bootProc !== null && bootProc.exitCode === null);

  const failed = results.filter((item) => item.ok !== true);
  console.log(`\n[e2e-host] 结果: ${results.length - failed.length}/${results.length} 通过（boot ${boot.bootMs}ms，port ${port}）`);
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
  console.error(`\n[e2e-host] 致命错误：${error.message}`);
  if (bootLogPath !== null) dumpBootLog("致命错误");
  exitCode = 1;
} finally {
  await stopBoot(bootPort).catch(() => {});
  if (home !== null) {
    if (KEEP) console.log(`[e2e-host] --keep：保留 DSH_HOME=${home} boot.log=${bootLogPath}`);
    else fs.rmSync(home, { recursive: true, force: true });
  }
  if (packDir !== null && !KEEP) fs.rmSync(packDir, { recursive: true, force: true });
  if (skipped !== null && FAIL_ON_SKIP) exitCode = 1;
}
process.exitCode = exitCode;
