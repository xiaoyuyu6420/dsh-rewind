# dsh-rewind 测试报告（task-5：测试基建）

> 负责人：harness-builder（测试/验证）
> 日期：2026-10-18
> 目标宿主：DeepSeek Harness **0.2.1-rc.2**
> 范围：建立可重复的 Host 半区单测（mock-ctx）与真机 boot 冒烟（隔离 DSH_HOME），并记录验证结果与发现的缺陷。
> 硬约束：未修改 `index.js` / `client.js` / `package.json` / `dsh-backup` / `~/.dsh`；未 `git commit`；未重启用户桌面应用。
>
> **测试基线**：本报告的单测/e2e 结果全部针对 git commit `da034d7` 的 `index.js`/`client.js`（task-3/task-4 修复前）。并行修复（host-auditor/client-auditor）落地后，最终结论以 task-6 的 `docs/final-verify.md`（同一套脚本重跑）为准。

---

## 1. 环境

| 项 | 值 |
|---|---|
| 项目 | `/Users/xiao/Desktop/dsh/dsh-rewind`（git `da034d7`，工作区另有未跟踪 `scripts/`、`docs/`） |
| DSH CLI | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（`--version` = `0.2.1-rc.2`） |
| Node | v22.22.1（系统；脚本零第三方依赖） |
| pnpm | 12.9.1（系统；仅 e2e 打包用） |
| git | 2.54.0（单测里的 gitAutoCommit 用例用） |
| 平台 | macOS（darwin），zsh 默认 shell |
| 隔离策略 | 单测：每次用例 `mkdtemp` 独立 `DSH_HOME` + 工作区；e2e：`mkdtemp` 独立 `DSH_HOME` + `HOME`/`USERPROFILE`，独立空闲端口 |

宿主契约取证（只读，来自 app.asar 抽取）：
- `@deepseek-ai/dsh-session/lib/index.js` 的 `Session` 类：字段 `header`、`log`、`inheritedEventCount`，方法 `snapshotEvents()` / `ownEvents()`；**没有 `.events` 属性**。
- `@deepseek-ai/dsh-session-persistence/README.md`：服务方法只有 `create(header)` / `open(id, mode)` / `stat(id)` / `list()` / `flush()`；**没有 `inspect(id)`**。
- `@deepseek-ai/dsh-host-webserver`：`register({ kind: "exact"|"prefix", path, handler })` 返回 disposer；重复 `(kind,path)` 抛错。
- `@deepseek-ai/dsh-client-connection`：`requestRejection(request)` 返回 `401`/`403` 或 `undefined`（未鉴权/不可信来源拒绝）。
- 抽取命令：`node /tmp/asar-tool.mjs cat dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`。

---

## 2. 如何运行

```bash
cd /Users/xiao/Desktop/dsh/dsh-rewind

# A) mock-ctx 单测（秒级；每个用例独立临时 DSH_HOME，零网络）
node scripts/test-host.mjs                # 常规：已知缺陷记为 XFAIL，仅在“意外失败”时退出 1
node scripts/test-host.mjs --strict       # 严格：已知缺陷仍复现也算失败（task-6 验收用）
node scripts/test-host.mjs -k restore     # 只跑名字含子串的用例
node scripts/test-host.mjs --list         # 列出用例

# B) 真机 boot 冒烟（约 20s；隔离 DSH_HOME/HOME，不碰真实 ~/.dsh）
node scripts/e2e-host.mjs                 # 环境缺 dsh/pnpm/网络时 SKIP 并退出 0
node scripts/e2e-host.mjs --fail-on-skip  # CI 用：SKIP 也算失败
node scripts/e2e-host.mjs --keep          # 保留临时 DSH_HOME 与 boot.log 排查
node scripts/e2e-host.mjs --port 45871    # 指定端口

# C) 客户端静态回归守护（只读 client.js；秒级）
node scripts/check-client-static.mjs              # FAIL 退出 1；WARN 只提示
node scripts/check-client-static.mjs --strict     # WARN 也算失败（task-6 用）
node scripts/check-client-static.mjs --json       # 机器可读输出
node scripts/check-client-static.mjs --file /path/to/client.js
```

退出码约定：
- `test-host.mjs`：0 = 通过（strict 下还要求已知缺陷全部消失）；1 = 有意外失败。
- `e2e-host.mjs`：0 = 全部断言通过或环境性 SKIP；1 = 真实断言失败/致命错误。

---

## 3. 单测（scripts/test-host.mjs）

### 3.1 做法

直接 `import` 仓库根 `index.js` 的 `apply/main`，构造最小假 cordis ctx（按 0.2.1 真实契约建模）：

| 假 ctx 成员 | 行为 |
|---|---|
| `effect(fn,label)` | 立即执行 `fn`，收集其返回的 disposer（`ctx.on`/`ctx.webServer.register` 的返回值） |
| `on("session/event", handler)` | 收集 handler；`emit(session,event)` 时以 `(session,event)` 调用，模拟宿主 fire-and-forget |
| `get(name)` / `sessions.get(id)` | 返回假 `sessionPersistence` / live `Session`（`header.cwd`、`snapshotEvents()`，刻意**不带** `.events`） |
| `webServer.register(route)` | 收集 `{kind,path,handler}`；测试用假 req/res 直接调 `route.handler` 做 HTTP 断言 |
| `logger` | 收集日志，断言“非 git 目录不告警”等 |
| `connection.requestRejection(req)` | 可配置返回 `401`/`403`/`undefined`/无方法，覆盖鉴权分支 |

所有文件系统操作在临时目录；事件通过 `emit` 触发后以“轮询落盘文件/API 结果”等待异步链路完成（插件内部是 `void enqueue(...)`，不暴露 drain 钩子）。

### 3.2 用例清单与结果

**结果：18 用例 = 16 ✅ / 2 ⚠️XFAIL（均为已确认的真实缺陷，非测试缺陷）/ 0 ❌；退出码 0。`--strict` 退出码 1（符合预期）。连续 3 次运行结果一致。**

| # | 用例 | 覆盖点 | 结果 |
|---|---|---|---|
| 1 | exports | `name=dsh-rewind`、`inject=[webServer,sessions,connection]`、`apply` 类型 | ✅ |
| 2 | baseline | 首个事件建 baseline；`.git`/`node_modules`/`secret/`/`*.log` 按忽略规则不入档；blob 内容与文件一致 | ✅ |
| 3 | turn/end checkpoint | `turn-1.json` 落盘、`changed=2`、`checkpoints` API、同一 turn/end 重放幂等 | ✅ |
| 4 | restore(atSeq) | 还原到上一轮检查点、删除后续新增文件、恢复被删文件、`.gitignore` 忽略项不动、`mode/boundary/restored/deleted` 字段 | ✅ |
| 5 | restore dryRun | 只返回预览；磁盘无写入/无删除 | ✅ |
| 6 | restore 边界 | 未知会话 → `mode:none`；省略 `atSeq` → `mode:none`；`atSeq` 落在 turn 内 → 其后第一个 `turn/end`（锁定当前边界语义） | ✅ |
| 7 | store 边界 | 工作区在 `DSH_HOME` 内不跟踪；`config.enabled=false` 不跟踪；`header.origin=subagent` 不跟踪 | ✅ |
| 8 | api 鉴权 | `requestRejection` 401/403 短路；服务存在但无方法 → 503；服务缺失 → 503 fail-closed；放行 → 200 | ✅ |
| 9 | api 校验 | GET → 405；未知方法/多级路径 → 404；坏 JSON/缺 `sessionId`/`atSeq` 类型错/`dryRun` 类型错/超 1 MiB body → 400 | ✅ |
| 10 | gitAutoCommit 提交 | 临时 git 仓库 `turn/start` 后产生 `dsh: checkpoint before turn 1` 提交、工作区变干净、无告警 | ✅ |
| 11 | gitAutoCommit 跳过 | 非 git 目录静默跳过（不初始化 `.git`、不告警）；`gitAutoCommit:false` 不提交 | ✅ |
| 12 | 大文件语义 | `trackSizeCap=100/blobSizeCap=10`：小文件可还原；中等文件 `skipped.reason=no-content`；大文件 `skipped.reason=too-large` | ✅ |
| 13 | 并发 | 同会话两次 restore 串行化、按调用序生效；restore 与 turn/end 快照并发不抛错、checkpoint JSON 完整 | ✅ |
| 14 | 安全 | 篡改 `turn-1.json` 注入 `../outside.txt` 与绝对路径，restore 不越界写/删，合法文件仍还原 | ✅ |
| 15 | checkpoints 未跟踪 | 未知会话 → `{tracking:false,hasBaseline:false,checkpoints:[]}` | ✅ |
| 16 | 旧 persistence.inspect 兼容 | 冷会话 + 旧版 `inspect(id)→{meta:{cwd},events}`：可跟踪并还原到 turn1（**修复不得回归**） | ✅ |
| 17 | 真实 0.2.1 live Session | `snapshotEvents()`、无 `.events`：restore(atSeq=1) 应命中 turn1 | ⚠️ XFAIL = **BUG-1** |
| 18 | 真实 0.2.1 persistence | 只有 `stat/open`、无 `inspect`：冷会话应可跟踪/还原 | ⚠️ XFAIL = **BUG-2** |

说明：用例 4/5/6/12/13/14 使用“legacy mock session（带 `.events`）”是为了**把 restore 算法与宿主读取契约分开验证**；用例 17/18 才是 0.2.1 真实契约，当前失败即 BUG-1/BUG-2。修复后 17/18 必须转绿（task-6 `--strict` 通过），用例 16 不得回归。

---

## 4. 客户端静态回归守护（scripts/check-client-static.mjs）

### 4.1 做法（只读 client.js，不改源码）

两段式，互相兜底：

1. **静态扫描**：从 `client.js` 文本提取所有 `ctx.<标识符>` 访问（含 `ctx?.x`、alias（如 `pluginCtx = ctx` 后再访问）、解构 `const { slots } = ctx`、字面量下标 `ctx["sessions"]`）；排除 cordis context 自身成员（`get/set/effect/on/inject/require/logger/fiber/...`）；与插件返回对象的 `inject: [...]` 比对。**访问了但未 inject 的服务 → FAIL**（P0-2 那类 bug 的通用检测）。`ctx.get("x")` 不要求 inject，仅 INFO。
2. **VM 加载 + apply 冒烟**：用 `node:vm` 以浏览器 `window.__ModuleLoader__.load({id, factory})` 方式执行 bundle，stub 最小 React；捕获 factory 并调用 `factory(require)` 得插件对象；再以 ctx stub（`effect/on/get/locale.register/slots.inject+register/uiConversation.events.register/sessions.*/workspaces.*/uiWorkspace.*/document/localStorage`，所有 register 返回 disposer）调用 `apply`。断言：`entry.id`、`factory` 为函数、`plugin.apply` 为函数、`plugin.inject` 为字符串数组、`apply(ctx stub)` 不抛异常。

`--strict`：WARN 也算失败（用于 task-6 硬门槛）。`--json`：CI 机器可读。

降级策略（如实说明）：纯文本扫描不是完整 JS 解析；`ctx[expr]` 非字面量、把 `ctx` 存进数组/对象后跨函数再取、`eval`/字符串拼接访问无法静态归因 → 记 WARN（`--strict` 时失败），不静默放过。

### 4.2 结果

| 对象 | 结果 | 明细 |
|---|---|---|
| 基线 `da034d7` 的 client.js | ❌ FAIL（1 FAIL） | 抓到 **P0-2 类真实缺陷**：`client.js:246` 访问 `ctx.uiWorkspace.openSession(...)`，但 `plugin.inject` 只有 `["slots","sessions","workspaces","locale","uiConversation"]`，缺 `uiWorkspace`。VM 加载 / factory / apply 本身正常。 |
| 当前 in-progress client.js（client-auditor 已把 `uiWorkspace` 加入 inject） | ✅ PASS（strict 也 PASS） | `inject=["slots","sessions","workspaces","uiWorkspace","locale","uiConversation"]`，静态与 VM 一致；`entry.id=@local/dsh-rewind`；`apply(ctx stub)` 通过；0 FAIL / 0 WARN。 |
| 自检：模拟修复副本（inject 补 `uiWorkspace`） | ✅ PASS | 验证检查器不会再误报。 |
| 自检：语法损坏副本 | ❌ FAIL | VM 加载失败被判失败（不会因静态扫描可跑而放过）。 |
| 自检：动态下标副本 | ⚠️ WARN（`--strict` 时 FAIL） | `ctx[expr]` 无法归因，如实降级。 |

> 快照（修复并行进行中，仅作趋势参考）：2026-10-18 晚对 in-progress 代码复跑 —— `check-client-static --strict` PASS、`test-host --strict` 18/18、`e2e-host` 14/14。定稿后由 task-6 重跑为准。

### 4.3 限制

- VM 只验证「bundle 可加载 + apply 挂载不崩」，**不渲染槽位**；槽位运行期崩溃（`slot entry crashed`）仍依赖浏览器人工冒烟。
- 未来若 client.js 新增 `require()` 外部依赖（非 react），检查器会 FAIL 并报出包名（提示需要同步 `package.json`/宿主可解析性）。

## 5. 真机 boot 冒烟（scripts/e2e-host.mjs）

### 5.1 流程（全自动、隔离）

1. 定位 dsh CLI：`$DSH_BIN` → 内置 App CLI → PATH `dsh`；校验 `--version`。
2. `pnpm pack --pack-destination <tmp>` 产出 `local-dsh-rewind-0.1.0.tgz`。
3. `DSH_HOME=<tmp> HOME=<tmp> USERPROFILE=<tmp> dsh plugin --profile web add <tgz>`（初始化隔离 web profile，tarball 安装=真实用户路径）。
   - 同时校验安装落点 `profiles/web/node_modules/@local/dsh-rewind/index.js` 与 `package.json` 的 dependency + `dsh.profile.bundles`。
   - 环境性失败（网络/registry）→ 打 SKIP，不伪装成断言失败；非网络失败 → 致命错误。
4. 自动挑空闲端口，`dsh web --no-open --port <free>`（env 剔除会话继承的 `DSH_PROFILE`/`DSH_PROFILE_DIR`/`DSH_SESSION_ID`/`DSH_WEB_URL`/`DSH_SHELL`，防止误连真实 profile）。
5. 从 boot 日志解析 `dsh web: http://...?token=...` → `GET /?token=` 换 `HttpOnly` cookie（303）→ 再取 `/` 得 200。
6. 断言列表（14 项）。
7. 结束：杀独立进程组、等端口释放、清理临时目录（`--keep` 可保留）。

### 5.2 断言与结果

**结果：14/14 通过（连续 2 次运行一致；boot 约 5–8s，全流程约 20s）。**

| # | 断言 | 结果 |
|---|---|---|
| 1 | `dsh plugin add` 成功 | ✅ |
| 2 | tarball 安装到隔离 profile（index.js + bundle 声明） | ✅ |
| 3 | boot 后 Web shell 返回 200 | ✅ |
| 4 | Web shell HTML 有内容 | ✅ |
| 5 | index HTML 启动预加载列表包含 `@local/dsh-rewind/client.js`（client 半区进了 web 组合） | ✅ |
| 6 | 该 combo bundle 可下载（200 且含本插件代码） | ✅ |
| 7 | combo bundle 在 ModuleLoader 沙箱中可解析、导出插件面（`apply` 函数 + `inject` 含 `slots`） | ✅ |
| 8 | `POST /dsh-rewind/api/checkpoints`（带 cookie，未知会话）→ 200 `{ok:true,value:{tracking:false,...}}`（host `apply()` 真跑了） | ✅ |
| 9 | `GET /dsh-rewind/api/checkpoints`（带 cookie）→ 405 `method-error`（路由已注册，非 fallback 404） | ✅ |
| 10 | 无 cookie `POST` → 401（鉴权 fail-closed） | ✅ |
| 11 | `POST /dsh-rewind/api/nope` → 404（前缀路由生效） | ✅ |
| 12 | 启动日志无 `slot entry crashed` / `client bundles not found` / `failed to compose` | ✅ |
| 13 | 启动日志无 dsh-rewind 报错行 | ✅ |
| 14 | boot 后 web 进程仍存活 | ✅ |

> 与 Lead 手工结论一致（已脚本化复核）：**host 半区在真实宿主上 boot 正常，`webServer` 注册 / `connection.requestRejection` 鉴权 / 路由前缀这一层契约是对的**。真实宿主上 `POST checkpoints` 返回 200 `{"tracking":false,...}`、`GET` 返回 405，均被 e2e 断言覆盖。

### 5.3 e2e 的边界（没验证什么）

- **没有跑真实浏览器**：无法验证 client 半区的槽位渲染、`slot entry crashed` 的运行期行为、快捷控件点击。e2e 只验证“bundle 被宿主组合、能被 ModuleLoader 解析、插件面正确”。
- **没有产生真实 agent 会话**：没有 LLM 调用，因此 e2e 不覆盖“真实 turn/end 后快照落盘 → restore”。restore 语义由 mock-ctx 单测覆盖（含 BUG-1 的真实契约用例）。若要真机覆盖，需要一次真实对话或注入会话，成本高，task-6 视需要再评估。
- e2e 会 `pnpm pack`/`pnpm add`；本机可离线成功（pnpm 用 `/private/tmp/.pnpm-store` 内容寻址缓存）。CI 无缓存/无网络时按设计 SKIP。

---

## 6. 发现的缺陷

### BUG-1（严重，核心功能失效）restore(atSeq) 在真实 0.2.1 宿主上退化为 baseline

- 位置：`index.js:501-509` `eventsOf()`，关键行 `if (live !== undefined) return live.events ?? [];`（第 503 行）。
- 事实：`@deepseek-ai/dsh-session` 的 `Session` 类没有 `.events`，只有 `snapshotEvents()` / `ownEvents()`。
- 后果：`eventsOf()` 恒为 `[]` → `resolveTarget()`（`index.js:262-276`）找不到 `turn/end` → `checkpoint = baseline`。即用户点“回退到此（同时还原文件）”时，工作区被还原成**插件第一次见到该会话时**的状态，而不是**上一轮提问结束**的状态；首轮提问因客户端传 `baseline:true` 而侥幸正确。
- 复现：

  ```bash
  node scripts/test-host.mjs -k "真实 0.2.1 live"
  # 期望 mode=turn / boundary={turn:1,endSeq:1} / a.txt=A2
  # 实际 mode=baseline / a.txt=A1（XFAIL）
  ```

- 修复建议：优先 `live.snapshotEvents()`（返回完整日志快照），兼容旧 `.events`：

  ```js
  const events = typeof live.snapshotEvents === "function" ? live.snapshotEvents() : (live.events ?? []);
  ```

- 修复后：用例 17 转绿；`node scripts/test-host.mjs --strict` 全绿是 task-6 的硬门槛。

### BUG-3（P0-2 类，client 侧）plugin.inject 缺 `uiWorkspace`

- 位置：`client.js:246` `ctx.uiWorkspace.openSession(cut.childId)`；基线 `client.js:747` 的 `inject: ["slots","sessions","workspaces","locale","uiConversation"]` 不含 `uiWorkspace`。
- 后果：客户端在「回退后打开新会话」这条路径上访问未 inject 的服务，取决于宿主 cordis isolate 行为可能拿到 `undefined`/触发 inject 约束；属于“用了没 inject”的 P0-2 类缺陷。
- 复现（基线）：`node scripts/check-client-static.mjs` → FAIL，明细 `client.js:246`。
- 现状：client-auditor 在 task-4 已把 `uiWorkspace` 加入 inject；当前 in-progress 文件 `node scripts/check-client-static.mjs --strict` 已 PASS。task-6 需再次确认且不得回归。

### BUG-2（中）非 live / 冷会话无法建立 store

- 位置：`index.js:424-431` `workspaceRootOf()`（`persistence.inspect(sessionId)).meta.cwd`）与 `index.js:501-509` `eventsOf()`（`persistence.inspect(sessionId)).events`）。
- 事实：0.2.1 的 `sessionPersistence` 只有 `create/open/stat/list/flush`，`inspect` 不存在；异常被 `catch {}` 吞掉。
- 后果：重启后/已归档会话的 `checkpoints` 返回 `tracking:false`，`restore` 返回 `mode:none`（客户端会提示“本会话没有可还原的文件记录”）。
- 复现：`node scripts/test-host.mjs -k "真实 0.2.1 sessionPersistence"`（XFAIL）。
- 修复建议：`header.cwd` 用 `(await persistence.stat(id)).header.cwd`；事件用 `open(id,'read')` → `handle.read()` → `{events}`，读完 `handle.close()`；对旧 `inspect` 保留特性检测兼容（用例 16 兜底）。

### 设计问题（非阻断，已用测试锁定现状）：`trackSizeCap`(5 MiB) > `blobSizeCap`(1 MiB)

- 位置：`index.js:96-142` 跟踪与 `index.js:169-182` 存 blob。
- 现象：1–5 MiB 的文件会带 `sha` 写进 checkpoint，但内容不会进 `blobs/`；restore 时 `skipped.reason=no-content`，文件实际**没有被还原**。
- 影响：用户勾选“同时还原文件”后，这类文件保持现状；客户端只会显示“还原 N 个 / 跳过 M 个”。
- 复现：`node scripts/test-host.mjs -k 大文件语义`。
- 建议：两个 cap 对齐（默认都 1 MiB 或都 5 MiB），或 `saveBlob` 上限跟 `trackSizeCap` 走；至少在 README 里写清“超过 blobSizeCap 的文件只记录不还原”。

### 契约备注（非缺陷）

- `resolveTarget()` 取“`seq >= atSeq` 的第一个 `turn/end`”。客户端只传“上一轮 `turn/end` 的 seq”，因此当前路径正确；若未来有调用方传轮内事件 seq，语义是“还原到该轮结束”而不是“之前”。已用用例 6 锁定，供后续 API 文档化。
- restore 的 `deleted` 只删文件不删空目录；`skipped` 三种原因 `too-large`/`no-content`/`delete-failed`/`write-failed` 已按现状锁定。

---

## 7. 对 task-6（最终验收）的输入

1. 修复落地后跑：
   ```bash
   node scripts/test-host.mjs --strict            # 必须 0 失败、0 XFAIL（18/18 通过）
   node scripts/check-client-static.mjs --strict  # 客户端 inject/挂载回归守护，必须 PASS
   node scripts/e2e-host.mjs                      # 14/14
   git diff --stat && git diff           # 复核修复只动 index.js（按 task-3 范围）
   ```
2. 重点复核：BUG-1 修复后，用例 17 必须转绿；用例 16（旧 `inspect` 兼容）不得回归；用例 4/5 的 restore 结果字段（`mode/boundary/restored/deleted/skipped`）不得改变。
3. restore 语义验收：单测已覆盖核心语义与安全边界；真实宿主侧可复跑 e2e 的 `/dsh-rewind/api/*` 断言。
   客户端静态守护：task-4 若改 `client.js`（新增服务访问/改 inject），`check-client-static --strict` 必须保持 PASS。真实“对话回退 + 文件还原”若无法在不调 LLM 的情况下驱动，将在 `docs/final-verify.md` 中如实标注为 mock-ctx 覆盖 + 真机路由/鉴权覆盖的组合结论。
4. 若 client.js 被 task-4 改动：e2e 的 combo bundle 沙箱解析检查（断言 5–7）会重新验证发布物里的 client bundle 可加载且导出面正确；但槽位渲染仍需人工 UI 冒烟（本环境无浏览器自动化依赖，未引入）。

---

## 8. 附：测试产物

| 文件 | 说明 |
|---|---|
| `scripts/test-host.mjs` | 18 个 mock-ctx 单测；`--strict/-k/--list`；零依赖 |
| `scripts/e2e-host.mjs` | 真机 boot 冒烟；隔离 DSH_HOME/HOME；`--fail-on-skip/--keep/--port`；零依赖 |
| `scripts/check-client-static.mjs` | 客户端静态回归守护：ctx 服务访问 vs `plugin.inject` 比对 + VM 加载/apply 冒烟；`--strict/--json/--file`；只读 client.js；零依赖 |
| `docs/test-report.md` | 本报告 |
