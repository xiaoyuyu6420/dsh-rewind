// Host half of @xiaoyuyu6420/dsh-rewind.
// Per-turn workspace checkpoints (CAS blobs) + a restore HTTP API.
// Adapted for DSH 0.2.x: route auth uses `connection.requestRejection` instead
// of the removed `webRuntime.trustedHosts`.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";

const name = "dsh-rewind";
const inject = ["webServer", "sessions", "connection"];

const DEFAULT_IGNORE_NAMES = [
  ".git", ".dsh", "node_modules", ".pnpm-store", ".venv", "venv", "__pycache__",
  "dist", "build", ".next", ".nuxt", ".idea", ".vscode", ".mypy_cache",
  ".pytest_cache", ".DS_Store", "coverage", ".turbo", ".cache", "target"
];
const DEFAULT_IGNORE_PATTERNS = ["*.pyc", "*.pyo", "*.log", "*.tmp", "*.swp"];

function patternToRegExp(pattern) {
  if (!pattern.includes("*")) return null;
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`);
}

function parseGitignore(content) {
  const rules = [];
  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (line === "" || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) { negate = true; line = line.slice(1).trim(); }
    if (line === "") continue;
    let dirOnly = false;
    if (line.endsWith("/")) { dirOnly = true; line = line.slice(0, -1); }
    const hasSlash = line.includes("/");
    let norm = line.startsWith("/") ? line.slice(1) : line;
    norm = norm.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    norm = norm.replace(/\*\*/g, "___DS___");
    norm = norm.replace(/\*/g, "[^/]*");
    norm = norm.replace(/\?/g, "[^/]");
    norm = norm.replace(/___DS___\//g, "(?:.*/)?");
    norm = norm.replace(/___DS___/g, ".*");
    const regexStr = hasSlash ? `^${norm}$` : `(?:^|/)${norm}$`;
    try {
      rules.push({ pattern: line, negate, dirOnly, regex: new RegExp(regexStr) });
    } catch {}
  }
  return rules;
}

function matchesGitignore(relPath, isDir, rules) {
  if (rules.length === 0) return false;
  const normalized = relPath.split(sep).join("/");
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.regex.test(normalized)) ignored = !rule.negate;
  }
  return ignored;
}

function isIgnored(relPath, ignoreNames, ignorePatterns, isDir, gitignoreRules) {
  const segments = relPath.split(sep);
  const names = new Set(ignoreNames);
  const regexes = ignorePatterns.map(patternToRegExp).filter((r) => r !== null);
  for (const segment of segments) {
    if (names.has(segment)) return true;
    for (const re of regexes) if (re.test(segment)) return true;
  }
  if (gitignoreRules.length > 0 && matchesGitignore(relPath, isDir, gitignoreRules)) return true;
  return false;
}

function toRelative(root, absolute) {
  const rel = relative(root, absolute);
  return rel === "" ? "." : rel;
}

/** Whether `target` equals `root` or lies below it (both resolved absolute paths). */
function isSameOrInside(target, root) {
  return target === root || target.startsWith(root + sep);
}

/** Reject values that would escape (or collapse) a single storage path segment. */
function isSafeStorageSegment(value) {
  return typeof value === "string" && value !== "" && value !== "." && value !== ".." && !/[/\\\0]/.test(value);
}

async function pathExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function writeAtomic(targetPath, data) {
  const tmpPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(tmpPath, data);
  await rename(tmpPath, targetPath);
}

async function walkWorkspace(root, options = {}, previousFiles) {
  const ignoreNames = options.ignoreNames ?? DEFAULT_IGNORE_NAMES;
  const ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
  const trackSizeCap = options.trackSizeCap ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 1e5;
  const enableGitignore = options.enableGitignore ?? true;
  const logger = options.logger ?? {};
  // Absolute subtrees never snapshotted or restored, even when the workspace is
  // an ancestor of them (the caller skips such workspaces, this is a backstop).
  const excludeRoots = (options.excludeRoots ?? []).map((root) => resolve(root));
  const files = {};
  const rootAbs = resolve(root);
  let gitignoreRules = [];
  if (enableGitignore) {
    try { gitignoreRules = parseGitignore(await readFile(join(rootAbs, ".gitignore"), "utf8")); } catch {}
  }
  let count = 0;
  const walk = async (dir) => {
    if (count >= maxFiles) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= maxFiles) break;
      const absolute = join(dir, entry.name);
      if (excludeRoots.some((excluded) => isSameOrInside(absolute, excluded))) continue;
      const rel = toRelative(rootAbs, absolute);
      if (entry.isDirectory()) {
        if (!isIgnored(rel, ignoreNames, ignorePatterns, true, gitignoreRules)) await walk(absolute);
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      if (isIgnored(rel, ignoreNames, ignorePatterns, false, gitignoreRules)) continue;
      let info;
      try { info = await stat(absolute); } catch { continue; }
      count += 1;
      if (info.size > trackSizeCap) {
        files[rel] = { size: info.size, mtimeMs: info.mtimeMs };
        continue;
      }
      const prev = previousFiles?.[rel];
      if (prev !== undefined && prev.sha !== undefined && prev.size === info.size && Math.abs(prev.mtimeMs - info.mtimeMs) < 1) {
        files[rel] = { sha: prev.sha, size: info.size, mtimeMs: info.mtimeMs };
        continue;
      }
      try { files[rel] = { sha: await hashFile(absolute), size: info.size, mtimeMs: info.mtimeMs }; }
      catch { logger.warn?.(`[dsh-rewind] hash failed: ${rel}`); }
    }
  };
  await walk(rootAbs);
  return files;
}

class CheckpointStore {
  constructor(dataDir, workspaceRoot, options = {}) {
    this.dir = dataDir;
    this.root = resolve(workspaceRoot);
    this.options = {
      ignoreNames: options.ignoreNames ?? DEFAULT_IGNORE_NAMES,
      ignorePatterns: options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
      trackSizeCap: options.trackSizeCap ?? 5 * 1024 * 1024,
      blobSizeCap: options.blobSizeCap ?? 1024 * 1024,
      maxFiles: options.maxFiles ?? 1e5,
      maxTotalBlobBytes: options.maxTotalBlobBytes ?? 500 * 1024 * 1024,
      enableGitignore: options.enableGitignore ?? true,
      excludeRoots: options.excludeRoots ?? [],
      logger: options.logger ?? {}
    };
    this.baselineLoaded = false;
    this.baseline = undefined;
    this.turnsLoaded = false;
    this.turns = new Map();
    this.totalBlobBytes = 0;
  }
  baselinePath() { return join(this.dir, "baseline.json"); }
  turnPath(turn) { return join(this.dir, `turn-${turn}.json`); }
  blobsDir() { return join(this.dir, "blobs"); }
  blobPath(sha) { return join(this.blobsDir(), sha); }
  async hasBlob(sha) { try { await stat(this.blobPath(sha)); return true; } catch { return false; } }
  async saveBlob(sha, sourcePath, size) {
    if (size > this.options.blobSizeCap) return false;
    if (this.totalBlobBytes + size > this.options.maxTotalBlobBytes) {
      this.options.logger.warn?.(`[dsh-rewind] blob storage over limit (${this.options.maxTotalBlobBytes} bytes), skipped ${sha}`);
      return false;
    }
    if (await this.hasBlob(sha)) return true;
    try {
      const data = await readFile(sourcePath);
      await writeAtomic(this.blobPath(sha), data);
      this.totalBlobBytes += size;
      return true;
    } catch { return false; }
  }
  async getBlob(sha) {
    try { return await readFile(this.blobPath(sha)); } catch { return null; }
  }
  async loadBaseline() {
    if (this.baselineLoaded) return;
    this.baselineLoaded = true;
    try { this.baseline = JSON.parse(await readFile(this.baselinePath(), "utf8")); } catch { this.baseline = undefined; }
  }
  async loadTurns() {
    if (this.turnsLoaded) return;
    this.turnsLoaded = true;
    let names;
    try { names = await readdir(this.dir); } catch { return; }
    for (const n of names) {
      const m = /^turn-(\d+)\.json$/.exec(n);
      if (m === null) continue;
      try {
        const cp = JSON.parse(await readFile(join(this.dir, n), "utf8"));
        this.turns.set(cp.turn, cp);
      } catch {}
    }
  }
  async ensureBaseline(now = Date.now()) {
    await this.loadBaseline();
    if (this.baseline !== undefined) return this.baseline;
    await mkdir(this.dir, { recursive: true });
    const files = await walkWorkspace(this.root, this.options);
    for (const [rel, file] of Object.entries(files)) {
      if (file.sha === undefined) continue;
      await this.saveBlob(file.sha, join(this.root, rel), file.size);
    }
    const baseline = { kind: "baseline", turn: 0, endSeq: -1, at: now, files };
    await writeAtomic(this.baselinePath(), JSON.stringify(baseline));
    this.baseline = baseline;
    return baseline;
  }
  async previousOf(turn) {
    if (turn <= 1) { await this.loadBaseline(); return this.baseline; }
    await this.loadTurns();
    let best;
    for (const cp of this.turns.values()) {
      if (cp.turn < turn && (best === undefined || cp.turn > best.turn)) best = cp;
    }
    return best;
  }
  async recordTurn(turn, endSeq, now = Date.now()) {
    await this.loadTurns();
    const existing = this.turns.get(turn);
    if (existing !== undefined && existing.endSeq === endSeq) return existing;
    await mkdir(this.dir, { recursive: true });
    const previous = await this.previousOf(turn);
    const files = await walkWorkspace(this.root, this.options, previous?.files);
    for (const [rel, file] of Object.entries(files)) {
      if (file.sha === undefined) continue;
      const before = previous?.files[rel];
      if (before !== undefined && before.sha === file.sha) continue;
      await this.saveBlob(file.sha, join(this.root, rel), file.size);
    }
    const checkpoint = { kind: "turn", turn, endSeq, at: now, files };
    await writeAtomic(this.turnPath(turn), JSON.stringify(checkpoint));
    this.turns.set(turn, checkpoint);
    return checkpoint;
  }
  async list() {
    await this.loadTurns();
    const rows = [];
    for (const cp of this.turns.values()) {
      const previous = await this.previousOf(cp.turn);
      let changed = 0;
      for (const [rel, file] of Object.entries(cp.files)) {
        const prev = previous?.files[rel];
        if (prev === undefined || prev.sha !== file.sha) changed += 1;
      }
      rows.push({ turn: cp.turn, endSeq: cp.endSeq, at: cp.at, changed });
    }
    rows.sort((a, b) => a.turn - b.turn);
    return rows;
  }
  async hasBaseline() { await this.loadBaseline(); return this.baseline !== undefined; }
  resolveTarget(events, atSeq, baseline) {
    if (baseline) return { checkpoint: this.baseline, boundary: undefined };
    if (atSeq === undefined) return { checkpoint: undefined, boundary: undefined };
    const boundaryEvent = events.find((e) => e.type === "turn/end" && e.seq >= atSeq);
    if (boundaryEvent === undefined || boundaryEvent.data?.turn === undefined) {
      return { checkpoint: this.baseline, boundary: undefined };
    }
    const turn = boundaryEvent.data.turn;
    let checkpoint = this.turns.get(turn);
    if (checkpoint === undefined) {
      for (let earlier = turn - 1; earlier >= 1 && checkpoint === undefined; earlier -= 1) checkpoint = this.turns.get(earlier);
      checkpoint ??= this.baseline;
    }
    return { checkpoint, boundary: { turn, endSeq: boundaryEvent.seq } };
  }
  async restore(events, options = {}) {
    await this.loadBaseline();
    await this.loadTurns();
    const target = this.resolveTarget(events, options.atSeq, options.baseline === true);
    if (target.checkpoint === undefined) {
      return { mode: "none", restored: [], deleted: [], skipped: [], dryRun: options.dryRun === true };
    }
    const checkpoint = target.checkpoint;
    const current = await walkWorkspace(this.root, this.options);
    const restored = [];
    const deleted = [];
    const skipped = [];
    const dryRun = options.dryRun === true;
    const absolute = (rel) => resolve(this.root, rel);
    const within = (rel) => {
      const abs = absolute(rel);
      if (this.options.excludeRoots.some((excluded) => isSameOrInside(abs, excluded))) return false;
      return isSameOrInside(abs, this.root);
    };
    for (const rel of Object.keys(current)) {
      if (checkpoint.files[rel] !== undefined) continue;
      if (!within(rel)) continue;
      if (dryRun) { deleted.push(rel); continue; }
      try { await rm(absolute(rel), { force: true }); deleted.push(rel); }
      catch { skipped.push({ path: rel, reason: "delete-failed" }); }
    }
    for (const [rel, file] of Object.entries(checkpoint.files)) {
      if (!within(rel)) continue;
      const present = current[rel];
      const same = present !== undefined && file.sha !== undefined && present.sha === file.sha;
      if (same) continue;
      if (file.sha === undefined) { skipped.push({ path: rel, reason: "too-large" }); continue; }
      const blob = await this.getBlob(file.sha);
      if (blob === null) { skipped.push({ path: rel, reason: "no-content" }); continue; }
      if (dryRun) { restored.push(rel); continue; }
      try { await writeAtomic(absolute(rel), blob); restored.push(rel); }
      catch { skipped.push({ path: rel, reason: "write-failed" }); }
    }
    return {
      mode: checkpoint.kind,
      ...(target.boundary === undefined ? {} : { boundary: target.boundary }),
      restored, deleted, skipped, dryRun
    };
  }
}

function dshHome() {
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim() !== "") return resolve(env);
  return join(homedir(), ".dsh");
}
function storageRoot() { return join(dshHome(), "storages", "dsh-rewind"); }

async function loadConfig() {
  try {
    const raw = await readFile(join(storageRoot(), "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      ...(Array.isArray(parsed.ignoreNames) ? { ignoreNames: parsed.ignoreNames.filter((value) => typeof value === "string") } : {}),
      ...(Array.isArray(parsed.ignorePatterns) ? { ignorePatterns: parsed.ignorePatterns.filter((value) => typeof value === "string") } : {}),
      ...(typeof parsed.trackSizeCap === "number" ? { trackSizeCap: parsed.trackSizeCap } : {}),
      ...(typeof parsed.blobSizeCap === "number" ? { blobSizeCap: parsed.blobSizeCap } : {}),
      ...(typeof parsed.maxFiles === "number" ? { maxFiles: parsed.maxFiles } : {}),
      ...(typeof parsed.maxTotalBlobBytes === "number" ? { maxTotalBlobBytes: parsed.maxTotalBlobBytes } : {}),
      ...(typeof parsed.enableGitignore === "boolean" ? { enableGitignore: parsed.enableGitignore } : {}),
      ...(typeof parsed.gitAutoCommit === "boolean" ? { gitAutoCommit: parsed.gitAutoCommit } : {}),
      ...(typeof parsed.gitCommitPrefix === "string" ? { gitCommitPrefix: parsed.gitCommitPrefix } : {})
    };
  } catch { return { enabled: true }; }
}

function runGit(cwd, args, timeoutMs = 15000) {
  // Never inherit repository overrides from the host process environment: a
  // GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE would point these commands at a
  // different repository (or index) than the session workspace.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[key];
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (error.code ?? 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** Validation failure: reported to the caller as HTTP 400. */
class BadRequestError extends Error {}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}
function sendError(res, error) {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { ok: false, error: { code: "internal", message } });
}
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > 1 << 20) throw new BadRequestError("请求体超出大小限制");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try { return JSON.parse(text); } catch { throw new BadRequestError("请求体不是合法的 JSON"); }
}
function requireString(payload, key) {
  const value = payload?.[key];
  if (typeof value !== "string" || value === "") throw new BadRequestError(`缺少或无效的字段 "${key}"`);
  return value;
}
function optionalNumber(payload, key) {
  const value = payload?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new BadRequestError(`无效的数值字段 "${key}"`);
  return value;
}
function optionalBoolean(payload, key) {
  const value = payload?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new BadRequestError(`无效的布尔字段 "${key}"`);
  return value;
}

function apply(ctx) {
  const stores = new Map();
  const chains = new Map();
  let configPromise = null;
  const config = () => { configPromise ??= loadConfig(); return configPromise; };
  const warnedOnce = new Set();
  const warnOnce = (key, message) => {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    ctx.logger?.warn?.(message);
  };
  const enqueue = (sessionId, task) => {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    chains.set(sessionId, next.catch(() => void 0));
    return next;
  };
  const gitChains = new Map();
  const enqueueGit = (sessionId, task) => {
    const previous = gitChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    gitChains.set(sessionId, next.catch(() => void 0));
    return next;
  };

  async function workspaceRootOf(sessionId) {
    const live = ctx.sessions.get(sessionId);
    const liveCwd = live?.header?.cwd;
    if (typeof liveCwd === "string" && liveCwd !== "") return liveCwd;
    const persistence = ctx.get("sessionPersistence");
    if (persistence === undefined) return undefined;
    // DSH 0.2.1 SessionPersistence has no inspect(); stat(id) returns
    // { header, revision, ... } or undefined (README "What the service provides").
    // The legacy inspect() shape is kept as a fallback so hosts that still
    // expose it (and older backends) keep working.
    if (typeof persistence.stat === "function") {
      try {
        const snapshot = await persistence.stat(sessionId);
        const cwd = snapshot?.header?.cwd;
        if (typeof cwd === "string" && cwd !== "") return cwd;
      } catch {}
    }
    if (typeof persistence.inspect === "function") {
      try {
        const inspected = await persistence.inspect(sessionId);
        const cwd = inspected?.meta?.cwd;
        if (typeof cwd === "string" && cwd !== "") return cwd;
      } catch {}
    }
    return undefined;
  }

  async function storeFor(sessionId) {
    const existing = stores.get(sessionId);
    if (existing !== undefined) return existing;
    if (!isSafeStorageSegment(sessionId)) return undefined;
    const rawRoot = await workspaceRootOf(sessionId);
    if (rawRoot === undefined) return undefined;
    const root = resolve(rawRoot);
    const home = dshHome();
    // Skip a workspace inside the DSH home AND one that is an ancestor of it
    // (for example the OS home directory): either would put ~/.dsh/** into the
    // snapshot, including credentials and session logs.
    if (isSameOrInside(root, home) || isSameOrInside(home, root)) return undefined;
    const { enabled, ...options } = await config();
    if (enabled === false) return undefined;
    const dir = join(storageRoot(), sessionId);
    await mkdir(dir, { recursive: true });
    const store = new CheckpointStore(dir, root, { ...options, excludeRoots: [home], logger: ctx.logger });
    stores.set(sessionId, store);
    return store;
  }

  ctx.effect(() => {
    const off = ctx.on("session/event", (session, event) => {
      const sessionId = session.header?.id ?? session.id;
      if (session.header?.origin === "subagent") return;
      void enqueue(sessionId, async () => {
        const store = await storeFor(sessionId);
        if (store === undefined) return;
        try {
          await store.ensureBaseline();
          if (event.type === "turn/end" && event.data?.turn !== undefined) {
            await store.recordTurn(event.data.turn, event.seq);
          }
        } catch (error) {
          ctx.logger?.warn?.(`dsh-rewind: checkpoint failed for ${sessionId}: ${String(error)}`);
        }
      });
    });
    return off;
  }, "dsh-rewind: session checkpoint feed");

  async function autoCommitFor(sessionId, turn) {
    const cfg = await config();
    if (cfg.gitAutoCommit === false) return;
    const rootOfSession = await workspaceRootOf(sessionId);
    if (rootOfSession === undefined) return;
    const root = resolve(rootOfSession);
    const home = dshHome();
    if (isSameOrInside(root, home) || isSameOrInside(home, root)) return;
    const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok) return;
    // Only commit when the session workspace IS the repository root. From a
    // subdirectory `git add -A` stages the whole work tree (Git 2.0 semantics),
    // which would sweep unrelated user changes into this checkpoint commit.
    // --show-prefix is empty exactly at the work-tree root (symlink-safe).
    const workTreePrefix = await runGit(root, ["rev-parse", "--show-prefix"]);
    if (!workTreePrefix.ok) return;
    if (workTreePrefix.stdout.trim() !== "") {
      warnOnce(`git-root:${sessionId}`, `dsh-rewind: git auto-commit skipped in ${root}: not the repository root`);
      return;
    }
    // Never conclude a user's in-progress merge/rebase/cherry-pick/revert/bisect.
    const gitDir = await runGit(root, ["rev-parse", "--git-dir"]);
    if (!gitDir.ok || gitDir.stdout.trim() === "") return;
    const gitDirAbs = resolve(root, gitDir.stdout.trim());
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]) {
      if (await pathExists(join(gitDirAbs, marker))) {
        warnOnce(`git-op:${sessionId}:${marker}`, `dsh-rewind: git auto-commit skipped in ${root}: ${marker} present`);
        return;
      }
    }
    // Stay inside the workspace: pathspecs keep both the status check and the
    // commit from touching anything the user staged outside of it.
    const status = await runGit(root, ["status", "--porcelain", "--", "."]);
    if (!status.ok) { ctx.logger?.warn?.(`dsh-rewind: git status failed in ${root}`); return; }
    if (status.stdout.trim() === "") return;
    const added = await runGit(root, ["add", "-A", "--", "."]);
    if (!added.ok) { ctx.logger?.warn?.(`dsh-rewind: git add failed in ${root}: ${added.stderr.trim()}`); return; }
    const prefix = cfg.gitCommitPrefix ?? "dsh: checkpoint before turn";
    const message = turn !== undefined ? `${prefix} ${turn}` : prefix;
    const committed = await runGit(root, ["commit", "-m", message, "--", "."]);
    if (!committed.ok) ctx.logger?.warn?.(`dsh-rewind: git commit failed in ${root}: ${committed.stderr.trim()}`);
  }

  ctx.effect(() => {
    const off = ctx.on("session/event", (session, event) => {
      if (session.header?.origin === "subagent") return;
      if (event.type !== "turn/start") return;
      const sessionId = session.header?.id ?? session.id;
      void enqueueGit(sessionId, () => autoCommitFor(sessionId, event.data?.turn).catch((error) => {
        ctx.logger?.warn?.(`dsh-rewind: git auto-commit failed for ${sessionId}: ${String(error)}`);
      }));
    });
    return off;
  }, "dsh-rewind: git auto-commit");

  // Drop per-session bookkeeping so a long-lived host does not retain one store
  // and two promise chains per session forever. Pending tasks keep their own
  // references; a later cold request rebuilds the store from disk.
  ctx.effect(() => {
    const off = ctx.on("session/disposed", (session) => {
      const sessionId = session?.header?.id ?? session?.id;
      if (sessionId === undefined) return;
      stores.delete(sessionId);
      chains.delete(sessionId);
      gitChains.delete(sessionId);
      for (const key of warnedOnce) {
        if (key.endsWith(`:${sessionId}`) || key.includes(`:${sessionId}:`)) warnedOnce.delete(key);
      }
    });
    return off;
  }, "dsh-rewind: session cleanup");

  function liveEventsOf(live) {
    try {
      // Full log: a forked session needs its inherited prefix too, because the
      // client's atSeq may point at an inherited turn/end. DSH 0.2.1 Session
      // exposes snapshotEvents() (deprecated but present); .events never exists.
      if (typeof live?.snapshotEvents === "function") return live.snapshotEvents();
      if (typeof live?.ownEvents === "function") return live.ownEvents();
    } catch {}
    return Array.isArray(live?.events) ? live.events : [];
  }

  async function eventsOf(sessionId) {
    const live = ctx.sessions.get(sessionId);
    if (live !== undefined) return liveEventsOf(live);
    const persistence = ctx.get("sessionPersistence");
    if (persistence === undefined) return [];
    if (typeof persistence.open === "function") {
      let handle;
      try {
        handle = await persistence.open(sessionId, "read");
        const slice = await handle.read();
        if (Array.isArray(slice?.events)) return slice.events;
      } catch {
        // fall through to the legacy inspect() shape
      } finally {
        if (handle !== undefined) { try { await handle.close(); } catch {} }
      }
    }
    if (typeof persistence.inspect === "function") {
      try {
        const inspected = await persistence.inspect(sessionId);
        return Array.isArray(inspected?.events) ? inspected.events : [];
      } catch {}
    }
    return [];
  }

  const api = {
    async checkpoints(payload) {
      const sessionId = requireString(payload, "sessionId");
      const store = await storeFor(sessionId);
      if (store === undefined) return { tracking: false, hasBaseline: false, checkpoints: [] };
      const result = await enqueue(sessionId, async () => Promise.all([store.hasBaseline(), store.list()]));
      return { tracking: true, hasBaseline: result?.[0] ?? false, checkpoints: result?.[1] ?? [] };
    },
    async restore(payload) {
      const sessionId = requireString(payload, "sessionId");
      const atSeq = optionalNumber(payload, "atSeq");
      const baseline = optionalBoolean(payload, "baseline") ?? false;
      const dryRun = optionalBoolean(payload, "dryRun") ?? false;
      const store = await storeFor(sessionId);
      if (store === undefined) {
        // Not tracking this session (unknown cwd, DSH home, subagent, or
        // plugin disabled): report "nothing to restore" instead of failing,
        // so the client's conversation cut still completes.
        return { mode: "none", restorable: false, restored: [], deleted: [], skipped: [], dryRun };
      }
      const events = await eventsOf(sessionId);
      return enqueue(sessionId, async () => store.restore(events, { atSeq, baseline, dryRun }));
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/dsh-rewind/api",
    handler: async (req, res) => {
      const connection = Reflect.get(ctx, "connection");
      if (connection === undefined || typeof connection.requestRejection !== "function") {
        sendJson(res, 503, { ok: false, error: { code: "unavailable", message: "trust fence unavailable" } });
        return;
      }
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined && rejection !== null) {
        // Fail closed on an unexpected rejection shape (0.2.1 returns 401/403).
        res.statusCode = typeof rejection === "number" ? rejection : 503;
        res.end();
        return;
      }
      if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } }); return; }
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const method = url.pathname.startsWith("/dsh-rewind/api/") ? url.pathname.slice("/dsh-rewind/api/".length) : undefined;
      if (method === undefined || method.includes("/")) { sendJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown method" } }); return; }
      const handler = Object.hasOwn(api, method) ? api[method] : undefined;
      if (handler === undefined) { sendJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown method "${method}"` } }); return; }
      try {
        const payload = await readJsonBody(req);
        sendJson(res, 200, { ok: true, value: await handler(payload) });
      } catch (error) {
        if (error instanceof BadRequestError) {
          sendJson(res, 400, { ok: false, error: { code: "bad-request", message: error.message } });
          return;
        }
        sendError(res, error);
      }
    }
  }), "dsh-rewind: /dsh-rewind/api routes");
}

export { apply, inject, name };
