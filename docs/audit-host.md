# Host 半区契约审计：index.js vs DSH 0.2.1-rc.2

- 审计对象：`/Users/xiao/Desktop/dsh/dsh-rewind/index.js`（567 行，初始提交 `da034d7`）
- 目标宿主：DeepSeek Harness **0.2.1-rc.2**
  - 官方源码：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`（下称 `app.asar/dsh/...`；本文引用的 `@deepseek-ai/<pkg>/lib/index.js:行` 均指该 asar 内文件）
  - 版本核对：`app.asar/dsh/package.json` → `"@deepseek-ai/dsh-desktop-runtime": "0.2.1-rc.2"`；`runtime/cli/bin/dsh --version` → `0.2.1-rc.2`
- 审计方法：
  1. 逐行读 `index.js`，把每个宿主 API 使用点映射到 asar 内官方 `lib/*.js` 与 `README.md`；
  2. 用最小 mock ctx（真实 0.2.1 形状：Session 只有 `snapshotEvents()`、persistence 只有 `stat/open`）实际跑 `apply()`，复现关键缺陷；
  3. 在 `/tmp` 建临时 git 仓库验证 `git add -A` 的作用域语义。
- 所有结论均给出证据；无法确认的写「未能确认」。
- 结论摘要：**P0 × 1，P1 × 3，P2 × 14**。P0 会让「回退并还原工作区」这个核心功能在真实宿主上必然退化成本地初始状态（已复现）。

---

## 1. API 使用点核对

### 1.1 插件加载与依赖装配（`inject` / `name` / `apply`）

| 使用点 | 官方契约 | 判定 |
|---|---|---|
| `index.js:14` `inject = ["webServer", "sessions", "connection"]` | Cordis 插件 `inject` 数组 = 必需服务；Loader entry 的 `inject` 字段"Adds required services"（`app.asar/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/README.md:35`）；官方 bundle 同款写法：`dsh-web-app/lib/index.js:30` `const inject = ["webServer"]` | **OK** |
| 服务名 `webServer` | `dsh-host-webserver/lib/index.js:250,253` `class WebServer extends Service` + `super(ctx, "webServer")` | **OK** |
| 服务名 `sessions` | `dsh-session/lib/index.js:1715,1740` `class SessionStore extends Service` + `super(ctx, "sessions")` | **OK** |
| 服务名 `connection` | `dsh-client-connection/lib/index.js:692,710` `HostConnectionService` + `super(ctx, "connection")` | **OK** |
| 三个服务在 desktop profile 是否都存在 | 真实 profile `~/.dsh/profiles/desktop/package.json` 的 bundles 含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`；`dsh-web-app/cordis.patch.yml:181` 挂 `dsh-host-webserver`、`:236` 挂 `dsh-client-connection`；desktop-host 自身也直接用 `ctx.webServer`/`ctx.connection`（`dsh-desktop-host/lib/index.js:343`） | **OK** |
| `index.js:13` `name = "dsh-rewind"`、`index.js:567` `export { apply, inject, name }` | 与官方/参考插件一致（`dsh-backup/lib/index.js:76-77,905`） | **OK** |
| 无 `Config` 导出、`apply(ctx)` 接收 config 但忽略 | 宿主把 bundle patch 里的 `config: {}` 作为第二参传入；不声明 Config 合法 | **OK** |

结论：插件可以正常装配，无 P0 级加载阻塞。

### 1.2 `ctx.webServer.register`（`index.js:536-564`）

- 使用：`kind:"prefix"`, `path:"/dsh-rewind/api"`, `handler(req,res) async`，包在 `ctx.effect` 里。
- 官方契约：
  - `register(route)` 接受 `{kind:"exact"|"prefix", path, handler}`，**返回 disposer**；同表重复 path 抛错（`dsh-host-webserver/lib/index.js:327-334`；README.md:62）。
  - HTTP 匹配：先整张 exact 表，再最长 prefix，再 fallback；prefix 匹配要求 `pathname === prefix || pathname.startsWith(prefix + "/")`（`dsh-host-webserver/lib/index.js:496-506`）。
  - handler 自己拥有完整 response 生命周期；handler 抛错时 host 记 warn 并回 400/销毁 socket（README.md:70-72）。
  - 路由在激活后注册即可，与 listen 先后无关（README.md:60-62）。
- 判定：**OK**。
  - `/dsh-rewind/api/restore` 能命中 prefix（不是 `/dsh-rewind/apix` 这种误命中）；
  - handler 内自行 catch，不会把异常抛给 host；
  - `ctx.effect(() => ctx.webServer.register(...), label)` 返回 disposer 的写法正确（见 1.6）。
- 备注（P2）：路由挂在 `/dsh-rewind/api`，不经过 `/api` 桥；官方对插件 HTTP 端点的文档化通路是 `ctx.connection.fetch.register({path:"/api/...", methods, requestBody, fetch(Request)=>Response})`（`dsh-client-connection/lib/index.js:732-735,840-860,973-977`；README.md:35）。当前方案可用（见 1.3），但 `requestRejection` 不在 README 承诺的契约里，升级时需要复核。

### 1.3 `connection.requestRejection(req)`（`index.js:540-546`）

- 使用：`Reflect.get(ctx,"connection")` 取服务；缺服务或方法 → 503；`const rejection = connection.requestRejection(req); if (rejection !== undefined) { res.statusCode = rejection; res.end(); }`。
- 官方契约（`dsh-client-connection/lib/index.js`）：
  - `requestRejection(request)` 存在：`const admission = this.admit(request); return "rejection" in admission ? admission.rejection : void 0;`（`:737-740`）。
  - `admit()`：Host/Origin fence 失败 → `403`；服务已 dispose → `401`；浏览器 cookie 未认证 → `401`；成功 → `{peer}`（`:742-748`）。
  - 因此返回值类型是 **number（401/403）或 undefined**，`res.statusCode = rejection` 合法。
  - Host/Origin 判定：Host 必须是 loopback / 监听地址 / trustedHosts；Origin 必须同 authority；`sec-fetch-site:cross-site` 拒绝（README.md:48；实现 `:225-260`）。
  - 浏览器 cookie 由 `authorizeIndex` 在 `GET /` 时种下（README.md:44），desktop 用 `ctx.connection.authenticatedUrl(...)` 打开页面（`dsh-desktop-host/lib/index.js:343`），页面同源 `fetch('/dsh-rewind/api/...')` 会带 cookie，因此正常路径可放行。
- 判定：**OK（存在且语义正确，fail-closed 成立）**。
  - 缺 `connection` → 503；有服务无方法 → 503；401/403 → 直接结束且不执行 handler。
  - P2：`requestRejection` 未出现在 README 的方法清单里，属于"公开方法但非文档化契约"；建议加保护：仅当返回值为 number 时用作 status，否则按 503 处理（避免未来返回对象时 `res.statusCode = {}` 抛 RangeError，虽然仍是拒绝而非放行）。

### 1.4 `ctx.on("session/event", (session, event) => ...)`（`index.js:449-467, 489-499`）

- 使用：根 ctx 上订阅；回调参数 `(session, event)`；`session.header?.id ?? session.id`、`session.header?.origin === "subagent"`；`event.type === "turn/start"|"turn/end"`；`event.seq`；`event.data.turn`。
- 官方契约：
  - Session 提交时 `callbackArgs = [this, event]`，以 `"session/event"` 派发（`dsh-session/lib/index.js:1580-1594`）。官方插件同款订阅：`dsh-agent-loop/lib/index.js:320` `ctx.on("session/event", (subject, event) => {...})`。
  - 事件词表含 `"turn/start"`、`"turn/end"`（`dsh-session/lib/index.js:137-138`）。
  - `turn/start` 载荷 `{ turn }`（`dsh-agent-loop/lib/index.js:946`）；`turn/end` 载荷 `{ turn, reason }`（`:1030-1033`），崩溃恢复的合成 `turn/end` 同样带 `data.turn`（`dsh-session/lib/index.js:742-800`）。
  - `event.seq` 为整数（`SessionSeq` 运行时是 number，`dsh-session/lib/index.js:1478-1481`）。
  - 根 ctx（未打 scope tag）的监听器会收到所有 scope 的事件：`scopeTarget` 的 filter 对 `scopeOf(ctx) === undefined` 直接返回 true（`dsh-scope/lib/index.js:328-340`，注释 `:320-327`）。
  - `session.header` 恒存在且深冻结；字段含 `id`、`cwd`、`origin`（唯一合法值 `"subagent"`）、`isSeeded` 等（`dsh-session/lib/index.js:1041-1066`，origin 校验 `:1054`）。
- 判定：**OK**（事件名、参数、字段、subagent 过滤都符合）。
- 备注（P2）：当前对**所有**事件都入队一次（只为了 `ensureBaseline()`），高频事件下会产生大量微任务，建议只在首事件/`turn/start`/`turn/end` 处理。

### 1.5 `ctx.sessions.get(id)` 返回的 live session 形状（`index.js:425-427, 502-503`）

- 使用：`live?.header?.cwd`（OK）；`live.events ?? []`（**错误**）。
- 官方契约：`ctx.sessions.get(id)` 返回 `Session` 实例（`dsh-session/lib/index.js:1981-1983`）。`Session` 类公开成员为：`log`、`surfaceManager`、`surface`、`header`、`inheritedEventCount`、`firstLiveSeq`、`firstLifecycleSeq`、`eventsSnapshot`（内部缓存）、`id`/`seq` getter、`eventAt()`、`snapshotEvents()`、`ownEvents()`、`isOwnSeq()` 等（`dsh-session/lib/index.js:1325-1485`）。**没有 `events` 属性**（全文无 `get events` / `this.events`）。
- 判定：**错误 → P0-1**。`live.events ?? []` 恒为 `[]`，`eventsOf()` 对活会话永远返回空数组。
- 其次：官方把 `eventAt/snapshotEvents/ownEvents` 标为 deprecated（"new production calls are prohibited"），但 0.2.1 仍可用；外部插件没有替代的整段读取 API。修复采用 `snapshotEvents()`，并在文档标注 deprecated 风险（升级时复核）。

### 1.6 `ctx.effect(fn, label)` 与 disposer 注册（`index.js:449, 489, 536`）

- 官方契约：`ctx.effect(execute, label)` 执行 `execute`，**返回函数则收集为 disposer**；异步返回也支持（`cordis/lib/index.js:1143-1146`）。`ctx.on` 返回 disposer（`:372-386`）。参考插件同款写法：`dsh-backup/lib/index.js:6155-6163`。
- 判定：**OK**。`ctx.effect(() => ctx.webServer.register(...))`、`ctx.effect(() => { const off = ctx.on(...); return off; })` 都在卸载时正确回收；`off` 被 `ctx.on` 外层 effect 与 `ctx.effect` 双重持有，只是冗余，不重复触发。

### 1.7 `ctx.get("sessionPersistence")` 与 `inspect(id)`（`index.js:428-430, 504-506`）

- 使用：`await persistence.inspect(sessionId)).meta.cwd`、`.events`。
- 官方契约：
  - 服务名 `sessionPersistence`：`dsh-session-persistence/lib/index.js:262-267` `SessionPersistence extends Service` + `super(ctx, "sessionPersistence")`。
  - **0.2.1 的服务方法只有 5 个**：`create(header)`、`open(id, 'read'|'write')`、`stat(id)`、`list()`、`flush()`（`dsh-session-persistence/README.md:37-48`）。README 第 13 行的 "inspect" 是动词描述，不是方法名；`lib/index.js` 全文没有 `inspect` 符号。
  - `stat(id)` 返回 `{ header, revision, sizeBytes? }` 或 `undefined`（JSONL 实现 `dsh-session-persistence-jsonl/lib/index.js:2571-2600`），cwd 在 `snapshot.header.cwd`。
  - `open(id,'read')` 返回 `SessionHandle`，`handle.read(offset=0, length=MAX_SAFE_INTEGER)` → `{ eventState, events }`，`handle.close()` 幂等（README.md:40-54；JSONL 实现 `:64, :2489`）。
- 判定：**错误 → P1-1**。`inspect` 不存在，两处调用都被 `catch` 吞掉：
  - `workspaceRootOf`：非 live（归档/冷）会话永远拿不到 cwd → `storeFor` 返回 undefined → `checkpoints` 返回 `tracking:false`、`restore` 返回 `mode:"none"`；
  - `eventsOf` 的 persistence 分支是死代码（而且活会话分支已经先返回空数组）。

### 1.8 `ctx.logger`

- `ctx.logger` 是 LoggerService（`cordis/lib/index.js:583-...`），带 `warn/info/error/debug`（`this.warn = this._method("warn", 2)`，`:460`）。`ctx.logger?.warn?.(...)` 用法 **OK**。

### 1.9 存储目录约定（`index.js:322-327, 442`）

- 使用：`$DSH_HOME/storages/dsh-rewind/<sessionId>/{baseline.json,turn-N.json,blobs/}`；配置 `$DSH_HOME/storages/dsh-rewind/config.json`；`DSH_HOME` 空则 `~/.dsh`。
- 官方事实：
  - `storages` 是 **storage-json 后端的 root**：`dsh-base/cordis.patch.yml:186` `root: !!js dshHomePath('storages')`；该后端把 domain 数据写成 `<root>/<unit>.json` 或 `<root>/<unit>/<table>/<key>.json`（`dsh-storage-json/README.md:37,89`）。
  - 官方插件配置走 Cordis 配置/profile patch，或经 `ctx.settings`（`dsh-settings/README.md:15-29`）；`dsh-backup` 的配置就是 `ctx.settings`（`dsh-backup/lib/index.js:909`），数据目录是用户桌面目录。
- 判定：**存疑（P2-1）**。`storages/dsh-rewind` 恰好落在 storage-json 的 `<root>/<unit>/` 布局里，属于"看起来像 storage unit、实际绕过 storage 域层（无锁、无版本、无原子域语义）"的私有目录；不保证被宿主清理/备份策略识别，也存在与未来同名 domain 冲突的可能。0.2.1 没有文档化的"插件私有数据目录"，保持现状可工作。
- 未能确认：`DSH_HOME` 的"显式配置路径"（`resolveDshHome` 的 configured path，`dsh-home-paths/README.md:30-40`）是否会通过环境变量传给插件进程；插件只读 env + `~/.dsh` 兜底，与默认路径一致，但显式配置的非默认 home 无法感知。**未能确认**（不引入依赖的前提下无解）。

---

## 2. restore 语义专项

### 2.1 目标解析链路（现状）

- 客户端传参：`restore` 的 `atSeq` = **上一轮 `turn/end` 事件的 seq**（`client.js:354` 取 `turn.end.seq`；客户端 turn.end 就是 `turn/end` 事件，`dsh-client-ui-conversation/lib/client.js:2188,2306`）；首轮提问传 `baseline:true`（`client.js:236-238`）。
- 宿主解析：`resolveTarget()`（`index.js:262-276`）在 events 中找**第一个 `seq >= atSeq` 的 `turn/end`**，取其 `data.turn`，再取该 turn 的 checkpoint；缺失则向前找更早 turn，最后退回 baseline。
- 正确性推演（假定 events 读得到）：
  - atSeq = turn N 的 `turn/end.seq` → 命中同一事件 → checkpoint turn N = 第 N 轮结束时的文件状态 = 第 N+1 个提问发出**之前**的状态。与「回退到此提问之前并还原文件」自洽。✔
  - 边界：`atSeq` 落在 turn N 内部（非 turn/end seq）→ 命中 turn N 的 turn/end → 还原到该轮结束状态（测试锁定的契约）。
  - fork 子会话：`snapshotEvents()` 含 inherited 前缀，inherited 的 `turn/end` 也能被解析；但子会话通常没有对应 turn 号 checkpoint（自己的 turn 号从 1 重新计），会退回更早/baseline。turn 号跨 inherited/own **可能撞号**（继承事件里 turn 3 与子会话自己的 turn 3），`resolveTarget` 只按 turn 号取 checkpoint，理论上会取到"更新"的错快照。P2-2（建议按 `cp.endSeq` 二次校验：`cp.endSeq <= boundaryEvent.seq` 才采用）。
- **实际结果：P0-1 导致 events 恒为空 → `boundaryEvent === undefined` → 永远返回 baseline。**已复现：两轮会话回退 `atSeq=9`（turn 2 结束）返回 `{mode:"baseline"}`，把 turn1/turn2 期间新建的 `b.txt/c.txt/d.txt` 全删、`a.txt` 退回 `hello`。

### 2.2 baseline（`index.js:186-218`）

- 行为：首次观察到该会话的任意 `session/event` 时，遍历工作区、把 ≤`trackSizeCap` 的文件内容存入 `blobs/`，写 `baseline.json`（`startSeq` 语义上为 -1）。`restore({baseline:true})` 直接取它。
- 判定：**基本 OK，有 2 个语义缺口**：
  1. baseline 是"插件首次见到会话时"的状态，不是"会话创建时"。插件若在会话中途启用/重启，baseline = 中途状态；此时"回退到第一个提问"只会还原到中途。**P2-3**（建议：baseline 只在 `turn/start`（或首个事件）建立并记录 `firstSeenSeq`，并在响应里暴露该事实，或干脆按"追踪起点"文案说明）。
  2. baseline 建立与 `recordTurn` 都在事件回调里异步执行（`index.js:453-464`），不是"事件 seq 那一刻"的精确快照；若后续事件先于 walk 完成就改了文件，checkpoint 会混入下一轮内容。**P2-4**（窗口通常很小；不改结构无法彻底消除）。

### 2.3 dryRun（`index.js:289, 298-310`）

- 行为：只收集 `restored/deleted/skipped`，不落盘；不写 blob、不删文件、不建目录。有测试锁定（`scripts/test-host.mjs:567`）。
- 判定：**OK**。注意 dryRun 仍会 `walkWorkspace` 全量 hash，大仓库有 CPU 开销（P2）。

### 2.4 路径穿越 / 符号链接（`index.js:290-313`）

- 入参只有 `sessionId`/`atSeq`/`baseline`/`dryRun`，restore 的路径全部来自本地 checkpoint / 本地 walk，不接受调用方路径。
- 防护：`within(rel)` 用 `resolve(root, rel)` 后判断 `abs === root || abs.startsWith(root + sep)`（`:291-294`），被篡改的 checkpoint 里的 `../` 或绝对路径会被跳过（`scripts/test-host.mjs:866` 覆盖）。
- 缺口：
  - 只做**文本**边界判断，不做 `realpath`。若工作区内某目录在快照后被替换成指向外部的符号链接，`writeAtomic` 会沿链接写出工作区。**P2-5**（walk 本身 `entry.isSymbolicLink()` 直接跳过，`:122`，所以链接目录不会进快照；风险只在快照后目录被替换）。
  - `sessionId` 未做字符校验就 `join(storageRoot(), sessionId)`（`:442`）。当前 cwd 解析链对非法 id 会失败，实际上够不着；属**纵深防御 P2-6**（建议 `/^[A-Za-z0-9._-]{1,128}$/`）。

### 2.5 并发队列（`index.js:410-422`）

- 每个 sessionId 一条 promise 链：checkpoint 写入与 restore 串行；`next.catch(()=>void 0)` 作为链尾，避免断链/未处理拒绝。
- 判定：**OK（单会话）**。缺口：
  - `stores`/`chains`/`gitChains` Map 永不清理（`:406-407, 416`），每个会话一条，长进程内存缓慢增长；未监听 `session/disposed`。**P2-7**。
  - 两个不同会话共用同一 cwd 时无跨会话锁，互相 restore/turn 会踩。**P2-8**（设计上 workspace 通常 1 会话；团队/子代理场景存在）。
  - `storeFor` 并发首次调用会建两个 CheckpointStore（后写覆盖），重复 walk；无害。**P2-9**。

### 2.6 CAS / 存储层（`index.js:144-185`）

- blob 按 sha256 内容寻址、`writeAtomic` 临时文件+rename、原子写 checkpoint。判定：**OK**。
- 缺口：
  - `totalBlobBytes` 只统计本进程新增（`:162,179`），不读磁盘已有 blob → `maxTotalBlobBytes` 跨重启失效；**没有任何 GC/保留策略**，blob 与 `turn-N.json`（每轮一份完整文件表）随轮次单调增长。**P2-10**。
  - 读取 blob 时不做校验（sha 只用于寻址），磁盘损坏会原样写回。**P2-11**。
  - `writeAtomic` 的 `.tmp` 后缀属于默认忽略模式 `*.tmp`（`:21,92`），不会被误跟踪；但崩溃遗留的 tmp 文件不会被清理。
  - `trackSizeCap=5MB` 与 `blobSizeCap=1MB` 不一致（`:99,152`）：1–5MB 文件记录 sha 但**不存内容**，restore 只能报 `skipped(no-content)`，被删掉也救不回来；UI 侧计入 skipped 并提示"部分"（`client.js:464-473`）。**P2-12**（建议：>blobSizeCap 的文件只记 size/mtime 不记 sha，让语义与 `too-large` 一致；或把默认 trackSizeCap 降到 blobSizeCap。测试当前锁定"记 sha 但 no-content"的现状，改语义需同步测试）。

### 2.7 存储删除/写回的文件属性

- 只存内容，不存 mode/uid/mtime；restore 用默认权限写回（可执行位丢失、mtime 变 now），符号链接不跟踪。**P2-13**。
- 删除文件后不清理空目录（cosmetic）。

### 2.8 restore 的破坏性

- 语义本身就是"把工作区还原到快照状态"：快照之后**用户手工新建**的文件也会被删除（只要不被 ignore）。README 有确认框，但**没有恢复前安全快照/撤销**。**P2-14**（建议 restore 前把将被覆盖/删除的文件先写一份 `pre-restore-<ts>/`，成本可控）。

---

## 3. 健壮性静态检查

### 3.1 git auto-commit（`index.js:469-499, 348-359`）→ **P1-2**

- 触发：每个 `turn/start`（非 subagent、cwd 不在 DSH home）执行：
  1. `git rev-parse --is-inside-work-tree`
  2. `git status --porcelain`（整个仓库）
  3. `git add -A`（**整个仓库**）
  4. `git commit -m "<prefix> <turn>"`
- 实测（macOS git 2.x，`/tmp/gitlab`）：在仓库子目录执行 `git add -A`，暂存区出现**子目录之外**的 `top.txt`。Git 2.0 起无 pathspec 的 `git add -A` 等价于 `git add -A :/`，作用于整个工作树。
- 误伤面：
  1. 会话 workspace 是某个大仓库的子目录时，会把**仓库其他位置**的用户改动一起提交；
  2. 用户已 `git add` 的暂存内容会被扫进 checkpoint commit；
  3. 用户正处于 merge/rebase/cherry-pick 时，`git commit -m` 会**结束 merge**（生成 merge commit）；
  4. 未跟踪且未被 .gitignore 的敏感文件（.env、密钥）会被永久写进历史；
  5. 默认开启（`config.json` 缺失时 `cfg.gitAutoCommit !== false`，`:471`；README 也写默认开）。
- 最小修复（本次做 1/2/3/5，4/默认值留风险）：
  - `git add -A -- .` + `git commit -m <msg> -- .`：把提交范围钉死在 workspace（pathspec）；实测不会带上用户在工作区外的暂存，也不会把工作区外改动写入 commit；
  - merge/rebase/cherry-pick 进行中跳过（`rev-parse -q --verify MERGE_HEAD` / `REBASE_HEAD` / `CHERRY_PICK_HEAD`）；
  - `runGit` 的 env 移除 `GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE`，避免继承宿主环境指向别的仓库；
  - 默认 ON 与"未跟踪敏感文件入历史"属产品决策，改默认需要同步 README（本次不动 README，记为遗留风险）。

### 3.2 `.gitignore` 解析（`index.js:23-64`）

- 只读根 `.gitignore`，不支持嵌套 `.gitignore`、`.git/info/exclude`、全局 excludes；`**`、否定、目录规则的实现是近似；`trim()` 破坏行首空格语义。判定：**P2**（够用，但需在文档写明是近似实现；否则用户会以为 restore 严格尊重 git 语义）。

### 3.3 忽视名单 / DSH home 泄漏 → **P1-3**

- `storeFor` 只在 `cwd` **位于** DSH home 内时跳过（`:439`）。若用户把 workspace 选成 home 目录（`~`）——它是 `~/.dsh` 的**祖先**——检查通过，`walkWorkspace` 会把 `~/.dsh/**` 全部纳入快照（`DEFAULT_IGNORE_NAMES` 不含 `.dsh`，`:16-20`）：
  - `$DSH_HOME/.credentials.yaml`（浏览器 session 签名密钥，`dsh-client-connection/README.md:44`）、会话日志、插件配置等会被复制进 `blobs/`；
  - 之后 restore baseline/turn 时可能**覆盖/删除**这些文件。
- 最小修复：`walkWorkspace` 增加 `excludeRoots`（= `[dshHome()]`），对绝对路径做前缀判断后跳过（同时覆盖"workspace 是 DSH home 祖先"的情形；`storeFor` 现有跳过逻辑保留）。
- 判定：**P1**（敏感文件被纳入快照 + 可被回写）。

### 3.4 异常兜底

- 事件回调、git、blob 写入均有 catch + `logger.warn`；`enqueue` 的链尾 `.catch` 防未处理拒绝；HTTP handler 自己 catch 并区分 400/500。判定：**OK**。
- 缺口：`walk()` 的 `readdir` 失败被静默吞掉（`:113`），会生成"不完整快照"且无告警；恢复时可能按不完整快照删文件。**P2**（建议 warn，并在 baseline/checkpoint 里记 `complete` 标志）。

### 3.5 配置读取（`index.js:329-346`）

- 只校验顶层类型，不校验数组元素类型。用户把 `ignorePatterns:[1]` 写进配置 → `patternToRegExp` 抛 TypeError → 每次 checkpoint 静默失败（被外层 catch）。**P2**（建议 `filter(v=>typeof v==="string")`）。配置只读一次（进程内缓存），改配置需重启，与 README 一致。

### 3.6 API 输入/输出

- body ≤1MB、JSON 解析、`sessionId` 必填字符串、`atSeq` 有限数字、`dryRun/baseline` 布尔：**OK**（400 语义正确）。
- `api[method]` 直接查对象原型链（`:551`）：`POST /dsh-rewind/api/constructor` / `toString` 会命中 `Object` 原型函数而返回 200。**P2**（建议 `Object.hasOwn(api, method)`）。
- 405 先于 body 解析、404 未知方法：OK；401/403 返回空 body，客户端会退化成通用错误提示（可接受）。

---

## 4. 缺陷清单

### P0（核心功能失效 / 数据风险）

**P0-1 `index.js:503` 读不存在的 `live.events`，restore(atSeq) 必然退化为 baseline。**
- 证据：`dsh-session/lib/index.js:1325-1485`（Session 类无 `events`，只有 `snapshotEvents():1453` / `ownEvents():1466` / `seq:1478`）。
- 后果：任何非首轮回退都会把工作区还原到插件首次见到会话时的状态，并删除之后所有新文件——用户会丢工作区改动。
- 复现：`node /tmp/mock-rewind-smoke2.mjs`（本轮审计脚本）→ `restore atSeq=9` 返回 `mode:"baseline"`，`b.txt/c.txt/d.txt` 被删。
- 最小修复：`eventsOf()` 优先 `session.snapshotEvents()`（全量，含 inherited 前缀），其次 `ownEvents()`，再兼容旧 `live.events`；非 live 会话走 `persistence.open(id,"read") → read() → close()`（见 P1-1）。保持 `resolveTarget` 的"第一个 seq>=atSeq 的 turn/end"语义不变。

### P1（功能受损 / 用户仓库或敏感数据风险）

**P1-1 `index.js:430,506` 调用不存在的 `sessionPersistence.inspect(id)`。**
- 证据：服务只有 `create/open/stat/list/flush`（`dsh-session-persistence/README.md:37-48`；`lib/index.js:262-267` 无 inspect）；`stat` 返回 `{header,revision,...}`（`dsh-session-persistence-jsonl/lib/index.js:2571-2600`）；`open(id,'read')`+`read()`+`close()` 见 README.md:40-54 / JSONL `:64,:2489`。
- 后果：冷会话/归档会话 cwd 与 events 都拿不到 → 不跟踪、restore 返回 `mode:none`。
- 最小修复：`workspaceRootOf` 用 `(await persistence.stat(id))?.header?.cwd`；`eventsOf` 用 `open(id,"read")` + `read()`（默认全量）+ `finally close()`，失败一律返回 `[]`。

**P1-2 `index.js:481,485` git auto-commit 作用于整个仓库，且可能结束用户 merge。**
- 证据：`git add -A` 无 pathspec 作用于整树（Git 2.0 语义，实测见 §3.1）；`git commit -m` 在 merge 中会结束 merge。
- 后果：把工作区外改动/用户暂存内容提交；用户 merge 被 checkpoint commit 提前终结；未跟踪敏感文件可能入历史。
- 最小修复：`add -A -- .`、`commit -m <msg> -- .`、merge/rebase/cherry-pick 时跳过、清理 `GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE`。

**P1-3 `index.js:96-142,439` workspace 是 DSH_HOME 祖先时，`~/.dsh/**` 被纳入快照。**
- 证据：仅判断 `root` 是否在 home 内（`:439`）；ignore 名单不含 `.dsh`（`:16-20`）；`storages` 与 `.credentials.yaml` 都在 `$DSH_HOME`（`dsh-base/cordis.patch.yml:186`；`dsh-client-connection/README.md:44`）。
- 后果：凭据/会话日志进入 blobs，restore 可能回写/删除。
- 最小修复：`walkWorkspace` 增加 `excludeRoots`（DSH home），按绝对路径前缀跳过。

### P2

1. `index.js:322-327,442` 存储目录放在 storage-json 的 root 下，非文档化插件数据位置。
2. `index.js:262-276` turn 号跨 inherited/own 可能撞号，建议用 `cp.endSeq <= boundaryEvent.seq` 校验。
3. `index.js:205-218` baseline = 插件首次见到会话的状态，不是会话/首问状态。
4. `index.js:453-464` checkpoint 在事件回调里异步 walk，非事件 seq 时刻的精确快照。
5. `index.js:291-313` 只做文本边界判断，未 realpath 防符号链接换目录。
6. `index.js:442` `sessionId` 未做字符白名单（纵深防御）。
7. `index.js:406-416` stores/chains/gitChains 无清理，未监听 `session/disposed`。
8. 跨会话同 cwd 无锁，restore/checkpoint 可能互踩。
9. `storeFor` 并发首调建两个 store（重复 walk，无害）。
10. blob 预算不读磁盘、无 GC/保留策略；`turn-N.json` 每轮全量文件表单调增长。
11. blob 读取不校验 sha（磁盘损坏会原样写回）。
12. `trackSizeCap(5MB) > blobSizeCap(1MB)`：1–5MB 文件有 sha 无内容，restore 只能 `no-content` 跳过。
13. 不保存/恢复文件 mode（可执行位）、mtime；不跟踪符号链接。
14. restore 无恢复前安全快照/撤销；快照后用户手工新建的文件会被删除。

---

## 5. 修复优先级与验证方法

1. 先修 P0-1（否则一切 restore 行为错误），再修 P1-1（冷会话），两者一起改 `eventsOf`/`workspaceRootOf`。
2. P1-2 / P1-3 独立小改（git pathspec + excludeRoots），不影响 restore 逻辑。
3. P2-12 是唯一会误导用户"已还原"的数据类问题，若时间允许顺手把语义对齐（或仅在文档写明）。
4. 验证：
   - `node --check index.js`；
   - 既有测试：`node scripts/test-host.mjs`（P0-1/BUG-1、P1-1/BUG-2 两个 XFAIL 用例应转绿）；
   - 自建真实形状复现：`node /tmp/mock-rewind-smoke2.mjs`（修复后 `restore atSeq=9` 应为 `mode:"turn"` 且 `a.txt=world`、`b/c` 存在、`d` 删除）；
   - git 误伤：在 `/tmp` 两目录仓库复跑 §3.1 场景，确认提交只含 workspace 内路径；
   - DSH home 祖先：workspace=home 的 mock 场景，确认 blobs 不含 `.dsh` 下文件。

## 6. 未能确认项

- 桌面版实际把浏览器页面从 `http://127.0.0.1:<port>` 提供（runtime context 的 GUI URL 与 `dsh-desktop-host/lib/index.js:343` 均指向 HTTP），但 `requestRejection` 需要的浏览器 cookie 在该页面已种下这一点是**推断**（依据 `authorizeIndex` 流程），未在真机桌面窗口抓包确认。
- `connection.requestRejection` 未出现在 README 的公开方法清单，未来版本可能调整；属**契约风险**，已按 fail-closed 设计兜底。
- `resolveDshHome` 的"显式配置 home"是否注入插件进程环境：**未能确认**（见 1.9）。
- 真实用户仓库的 Git 版本/配置（hooks、alias、`commit.gpgsign`）对 auto-commit 的影响：**未能确认**（失败只记 warn，不会中断会话）。
