# DSH 运行时契约守卫（`check-runtime-contract`）

> 目标：把「每次 DSH 升级都要人肉 grep 一遍宿主/客户端内部契约」固化成一条可执行门禁。
> 当前基线：**DSH 0.2.1-rc.5**（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，17 项全 PASS）。

## 1. 为什么需要

dsh-rewind 的宿主半区与客户端半区都依赖 DSH **未公开的内部契约**：

- 宿主：`Session.snapshotEvents()`（同步读事件）、`sessionPersistence.open/stat`、`webServer` 的 prefix 路由、`connection.requestRejection`、Fork/Create RPC 的字段。
- 客户端：`conversation.chat.node` slot 的 props 形状、Event Definition 的 `kind/seq` 约定、`uiConversation` / `uiWorkspace` 服务名与方法签名、`dsh.client` 声明解析、主题 CSS 变量。

`scripts/test-host.mjs` 跑在**假 ctx** 上——它证明插件在“契约成立时行为正确”，但抓不到“宿主把契约改了”。
0.2.1-rc.2 → rc.5 这次升级正是靠手工复核才确认没变。本脚本把那份复核变成断言：

- 契约符号消失 / 改名 / 形状改变 → **FAIL，退出码 1**，并打印「缺哪条断言、查过哪些文件」。
- 脚本只读：不写文件、不启动 DSH、不碰 `~/.dsh`、不需要网络与第三方依赖。

## 2. 用法

```bash
node scripts/check-runtime-contract.mjs            # 人类可读；末行汇总 PASS=x FAIL=y SKIP=z
node scripts/check-runtime-contract.mjs --strict   # CI 用：SKIP（找不到运行时）也算失败
node scripts/check-runtime-contract.mjs --json     # 机器可读（含 target.version、逐条 evidence）
node scripts/check-runtime-contract.mjs --list     # 只列契约清单
node scripts/check-runtime-contract.mjs --asar /path/to/app.asar
node scripts/check-runtime-contract.mjs --checkout /path/to/dsh-checkout
```

退出码：`0` 全 PASS（或非 strict 下 SKIP）；`1` 有 FAIL / strict 下 SKIP / 目标损坏；`2` 用法错误。

## 3. 检查目标与解析

解析顺序（**显式指定的路径不回退**，指错就报错，避免“以为检查了新版，实际读了旧路径”）：

1. `--asar <path>`
2. 环境变量 `DSH_ASAR`
3. 默认安装路径 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`
4. `--checkout <dir>`
5. 环境变量 `DSH_CHECKOUT`

优先级细节：`--asar`/`DSH_ASAR` 命中即用；否则 `--checkout` 优先于默认 app.asar（方便对着源码工作）；再否则用默认安装；最后 `DSH_CHECKOUT`。全都没有 → `SKIP`（`--strict` 下 `exit 1`）。

### 3.1 最小 asar 读取（脚本内自带，零依赖）

Electron asar 头布局（rc.5 实测数值）：

| 字段 | 偏移 | rc.5 实测 |
|---|---|---|
| pickle 魔数 | `u32@0` | `4` |
| headerBlockSize | `u32@4` | `4761012` |
| 头的 pickle 载荷 | `u32@8` | `4761008` |
| JSON 头长度 | `u32@12` | `4761003` |
| JSON 头起点 | 从 8 起第一个 `{` | `16` |
| 数据基址 | `8 + headerBlockSize` | `4761020` |

文件的 `offset` 相对数据基址；`unpacked: true` 的条目直接跳过（脚本不需要，也没去读 `app.asar.unpacked`）。
归档内包前缀：`dsh/node_modules/@deepseek-ai/<pkg>/lib/*.js`。
`dsh/package.json` 的 `version` 用作「运行时版本」展示（rc.5 读到 `0.2.1-rc.5`）。

### 3.2 checkout 模式

不是 asar 时的兜底：在下列布局里按包内相对路径查找（第一个存在的即用）：

- `<root>/dsh/node_modules/@deepseek-ai/<pkg>/lib/...`
- `<root>/node_modules/@deepseek-ai/<pkg>/lib/...`
- `<root>/packages/<pkg>/lib/...`
- `<root>/<pkg>/lib/...`

## 4. 契约清单（17 条）

匹配一律用**宽松文本断言**（如 `/snapshotEvents\s*\(\s*fromSeq/`），不绑行号——压缩产物行号会漂；行号只作证据展示。

### 4.1 宿主侧（H1–H7）

| ID | 契约点与断言 | 插件用途 | 失效后果 | rc.5 证据（file:line） |
|---|---|---|---|---|
| **H1** | `Session.snapshotEvents(fromSeq,toSeqExclusive)`、`ownEvents()`、`eventAt(seq)` | live 会话的事件读取：生成 checkpoint、`restore(atSeq)` 取到轮次边界 | restore 退化为 baseline（P0 级回归；rc.2 的 bug 就是这条） | `dsh-session/lib/index.js:1452` / `:1465` / `:1439` |
| **H2** | `async open(id, access, options)`、`async stat(id, options)`、`async read(offset,length)` 返回 `{eventState, events}`、服务名 `sessionPersistence` | 冷会话（未 attach）的 tracking 与还原：`stat()` 取 cwd、`open(id,"read")→read()` 取事件 | 冷会话不可跟踪/不可还原（静默跳过） | `dsh-session-persistence-jsonl/lib/index.js:2488` / `:2570` / `:63` / `:99` / `:80`；`dsh-session-persistence/lib/index.js:265` |
| **H3** | `requestRejection(request)` | API 路由对每个请求判 401/403（fail-closed） | 插件路由丢失宿主鉴权语义（要么全拒要么裸奔） | `dsh-client-connection/lib/index.js:737` |
| **H4** | `register(route)` 支持 `kind:"prefix"`：`route.kind === "exact" ? this.exact : this.prefixes`，前缀按 `prefix/` 边界匹配 | 以 prefix 挂 `/dsh-rewind/api/*` | 只有 exact 路由 → 插件的 API 全部 404 | `dsh-host-webserver/lib/index.js:327` / `:326` / `:500` |
| **H5** | Fork RPC 的 `atSeq`：zod 字段、`jsonSchema` 属性、`SessionForkRequest.atSeq`、语义描述「inclusive source event seq」 | 「回退到此」用 `fork(atSeq)` 精确切到某轮边界 | 只能 fork 到最新 → 回退到“当前”，功能失效 | `dsh-api-session-controller/lib/typert.host.js:509` / `:1601` / `:2823` |
| **H6** | Create RPC 同时接受 `workspaceId` 与 `cwd`（`SessionCreateRequest` 两个字段都在） | 建/复用会话时二选一定位工作目录 | 某一模式无法建会话 | `dsh-api-session-controller/lib/typert.host.js:229` / `:230` / `:2791` |
| **H7** | `async archiveSession(sessionId, options = {})` 转发 `workspaces.archiveSession(sessionId, options)`；`openSession(target)` | 回退后归档旧会话、打开新会话 | 归档错对象 / 抛错（P0-3 家族） | `dsh-client-ui-workspace/lib/client.js:1542` / `:1543` / `:1471` |

### 4.2 客户端侧（C1–C10）

| ID | 契约点与断言 | 插件用途 | 失效后果 | rc.5 证据（file:line） |
|---|---|---|---|---|
| **C1** | `renderSlot("conversation.chat.node", routedOwner, {...})` 且 `routedOwner` 含 `node: routedNode` | 每问操作行从 `props.node` 拿该节点 seq | 操作行整体不渲染（P0-1 家族） | `dsh-client-ui-chat/lib/client.js:3815` / `:3799` |
| **C2** | user 定义产出 `kind:"user", seq: event.seq`；节点由 `chatNode(context, kind, anchorSeq, data, options)` 生成 | 按 `kind==="user"` + `data.seq` 反查提问节点 | 操作行挂错位置或消失 | `dsh-client-ui-chat/lib/client.js:9909` / `:7718` |
| **C3** | `isAppendSurfaceEvent(event)` 体内 `surfaceOp === "append"` | 只渲染 append-origin 事件，避免回退后重复渲染 replacement 副本 | 回退后出现重复/幽灵消息行 | `dsh-client-ui-chat/lib/client.js:9508` |
| **C4** | `renderSlot("conversation.input.left", …)` 且 slot 类型声明存在 | 快捷短语 / 提示词面板的挂载点 | 整块输入区扩展 UI 消失 | `dsh-client-ui-conversation/lib/client.js:19270` / `:20108` |
| **C5** | `assertDefinitionTarget(definition)`：`target` 与 `buildViewNode` 的 XOR 校验 | 插件注册 Event Definition 必须遵守该不变量 | 插件定义被静默丢弃（行不显示且无报错） | `dsh-client-ui-conversation/lib/client.js:3437` / `:3438` |
| **C6** | 服务名 `super(ctx, "uiConversation")` | `inject` 列表与 `ctx.uiConversation.events.register` | apply 阶段缺服务 → 定义注册失败 | `dsh-client-ui-conversation/lib/client.js:4041` |
| **C7** | `uiWorkspace.archiveSession(sessionId, options = {})`、`uiWorkspace.openSession(target)` | 客户端半区的归档/打开会话 | 回退流程中断（点按钮无反应或抛错） | `dsh-client-ui-workspace/lib/client.js:1542` / `:1471` |
| **C8** | `hooks: ["session"]`（ui-session）、`hooks: ["chat"]`（ui-chat） | 渲染回调里 `useChat`/`useSession` 可用 | 快照读取退化（我们已做降级，不崩但功能受限） | `dsh-client-ui-session/lib/client.js:756`；`dsh-client-ui-chat/lib/client.js:13141` |
| **C9** | `--dsw-alias-bg-layer-1`（token 注册）与 `--dsw-alias-interactive-bg-hover`（CSS） | 插件独立渲染上下文对齐宿主主题 | 样式错位（不影响功能） | `dsh-client-ui-theme/lib/client.js:1540` / `:27` |
| **C10** | 解析 `dsh.client.inject` / `dsh.client.external` / `dsh.client.immediately`，且 `immediately` 必须是 boolean | 客户端 bundle 的注入声明与 eager 预取 | bundle 不进 ModuleLoader（整块 UI 消失） | `dsh-client-modules/lib/client.js:66` / `:67` / `:68` |

## 5. 当前结果（0.2.1-rc.5，全部 PASS，exit 0）

```
[check-runtime-contract] 目标: asar /Applications/DeepSeek Harness.app/Contents/Resources/app.asar（来源 默认安装路径）
[check-runtime-contract] 运行时版本: 0.2.1-rc.5
✅ PASS H1 dsh-session: Session 提供 snapshotEvents/ownEvents/eventAt（同步事件读取）
         ↳ dsh-session/lib/index.js:1452  snapshotEvents(fromSeq = SessionLogOffset(0), toSeqExclusive = this.seq) {
         ↳ dsh-session/lib/index.js:1465  ownEvents() {
         ↳ dsh-session/lib/index.js:1439  eventAt(seq) {
✅ PASS H2 dsh-session-persistence: async open(id, access) / async stat(id)，handle.read() 返回 {eventState, events}
         ↳ dsh-session-persistence-jsonl/lib/index.js:2488  async open(id, access, options) {
         ↳ dsh-session-persistence-jsonl/lib/index.js:2570  async stat(id, options) {
         ↳ dsh-session-persistence-jsonl/lib/index.js:63  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options) {
         ↳ dsh-session-persistence-jsonl/lib/index.js:99  events: source.events.slice(offset, offset + length)
         ↳ dsh-session-persistence-jsonl/lib/index.js:80  eventState: "detached",
         ↳ dsh-session-persistence/lib/index.js:265  super(ctx, "sessionPersistence");
✅ PASS H3 dsh-client-connection: requestRejection(request)（HTTP 鉴权 fail-closed 判定）
         ↳ dsh-client-connection/lib/index.js:737  requestRejection(request) {
✅ PASS H4 dsh-host-webserver: register({kind}) 支持 prefix 路由（最长前缀优先）
         ↳ dsh-host-webserver/lib/index.js:327  const table = route.kind === "exact" ? this.exact : this.prefixes;
         ↳ dsh-host-webserver/lib/index.js:326  register(route) {
         ↳ dsh-host-webserver/lib/index.js:500  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
✅ PASS H5 dsh-api-session-controller: Fork RPC 接受 atSeq（SessionForkRequest.atSeq）
         ↳ dsh-api-session-controller/lib/typert.host.js:509  'atSeq': z.number().readonly().optional().describe('Exact inclusive source event seq; omission selects the latest completed-turn prefix.'),
         ↳ dsh-api-session-controller/lib/typert.host.js:1601  jsonSchema: {"type":"object","properties":{"sessionId":{"type":"string"},"atSeq":{"type":"number","description":"Exact inclusive source event seq; ...
         ↳ dsh-api-session-controller/lib/typert.host.js:2823  "declaration": "export interface SessionForkRequest {\n    readonly sessionId: SessionId;\n    readonly atSeq?: number;\n    readonly allowMigratio...
✅ PASS H6 dsh-api-session-controller: Create RPC 同时接受 workspaceId 与 cwd（SessionCreateRequest）
         ↳ dsh-api-session-controller/lib/typert.host.js:229  'workspaceId': z.string().readonly().optional().describe('Workspace the Session joins; exclusive with `cwd`.'),
         ↳ dsh-api-session-controller/lib/typert.host.js:230  'cwd': z.string().readonly().optional().describe('Directory the Session owns when no Workspace is named.'),
         ↳ dsh-api-session-controller/lib/typert.host.js:2791  "declaration": "export interface SessionCreateRequest {\n    readonly workspaceId?: WorkspaceId;\n    readonly cwd?: string;\n    readonly sessionI...
✅ PASS H7 dsh-client-ui-workspace: archiveSession(sessionId, options = {}) 取字符串 id；uiWorkspace.openSession(target)
         ↳ dsh-client-ui-workspace/lib/client.js:1542  async archiveSession(sessionId, options = {}) {
         ↳ dsh-client-ui-workspace/lib/client.js:1543  await this.workspaces.archiveSession(sessionId, options);
         ↳ dsh-client-ui-workspace/lib/client.js:1471  openSession(target) {
✅ PASS C1 dsh-client-ui-chat: 渲染 conversation.chat.node 时把 chat 节点作为 props.node 传给 slot
         ↳ dsh-client-ui-chat/lib/client.js:3815  children: renderSlot("conversation.chat.node", routedOwner, {
         ↳ dsh-client-ui-chat/lib/client.js:3799  node: routedNode
✅ PASS C2 dsh-client-ui-chat: user 事件定义产出 kind:"user" 且 seq = event.seq，节点经 chatNode(context,kind,anchorSeq,data) 生成
         ↳ dsh-client-ui-chat/lib/client.js:9909  kind: "user",
         ↳ dsh-client-ui-chat/lib/client.js:7718  function chatNode(context, kind, anchorSeq, data, options = {}) {
✅ PASS C3 dsh-client-ui-chat: isAppendSurfaceEvent(event) ⟺ surfaceOp === "append"
         ↳ dsh-client-ui-chat/lib/client.js:9508  function isAppendSurfaceEvent(event) {
✅ PASS C4 dsh-client-ui-conversation: 渲染 conversation.input.left slot（并声明该 slot 类型）
         ↳ dsh-client-ui-conversation/lib/client.js:19270  input === void 0 || sessionId === void 0 ? null : renderSlot("conversation.input.left", {})
         ↳ dsh-client-ui-conversation/lib/client.js:20108  "conversation.input.left": {
✅ PASS C5 dsh-client-ui-conversation: Definition target 与 buildViewNode 必须同生共死（assertDefinitionTarget）
         ↳ dsh-client-ui-conversation/lib/client.js:3437  function assertDefinitionTarget(definition) {
         ↳ dsh-client-ui-conversation/lib/client.js:3438  if (definition.target === void 0 !== (definition.buildViewNode === void 0)) throw new Error(`conversation Definition "${definition.kind}" must decl...
✅ PASS C6 dsh-client-ui-conversation: 服务名为 "uiConversation"
         ↳ dsh-client-ui-conversation/lib/client.js:4041  super(ctx, "uiConversation");
✅ PASS C7 dsh-client-ui-workspace: uiWorkspace.archiveSession(sessionId, options) 与 uiWorkspace.openSession(target)
         ↳ dsh-client-ui-workspace/lib/client.js:1542  async archiveSession(sessionId, options = {}) {
         ↳ dsh-client-ui-workspace/lib/client.js:1471  openSession(target) {
✅ PASS C8 dsh-client-ui-session / dsh-client-ui-chat: provide hooks 覆盖 "session" 与 "chat"（useChat 可用）
         ↳ dsh-client-ui-session/lib/client.js:756  hooks: ["session"],
         ↳ dsh-client-ui-chat/lib/client.js:13141  hooks: ["chat"],
✅ PASS C9 dsh-client-ui-theme: 主题 CSS 变量 --dsw-alias-bg-layer-1 与 --dsw-alias-interactive-bg-hover 存在
         ↳ dsh-client-ui-theme/lib/client.js:1540  name: "--dsw-alias-bg-layer-1",
         ↳ dsh-client-ui-theme/lib/client.js:27  const css$3 = ".RrNL-q_group{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:16px 0;display:flex}.RrNL-q_...
✅ PASS C10 dsh-client-modules: 仍解析 dsh.client 的 inject/external/immediately，且 immediately 必须是 boolean
         ↳ dsh-client-modules/lib/client.js:66  const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
         ↳ dsh-client-modules/lib/client.js:67  const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
         ↳ dsh-client-modules/lib/client.js:68  if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must b...
[check-runtime-contract] 汇总: PASS=17 FAIL=0 SKIP=0
```

`--json` 摘要（同一目标）：

```json
{"skip":false,"target":{"kind":"asar","path":"/Applications/DeepSeek Harness.app/Contents/Resources/app.asar","source":"默认安装路径","version":"0.2.1-rc.5","package":"@deepseek-ai/dsh-desktop-runtime"},"summary":{"pass":17,"fail":0,"skip":0},"elapsedMs":15}
```

## 6. 反向验证：守卫自己会不会“永远绿”

只证明「rc.5 全 PASS」不够，还要证明**契约被改时会红**。以下都在临时目录/假目标上做过（不碰真实安装）：

| 场景 | 做法 | 结果 |
|---|---|---|
| 候选文件缺失 | 从 checkout 副本删掉 `dsh-session/lib/index.js` | `❌ FAIL H1 … 候选文件全部缺失`，`PASS=16 FAIL=1`，**exit 1** |
| 符号被改名（模拟升级改契约） | 副本里把 `snapshotEvents` 全量改成 `snapshotEventsRenamed` | `❌ FAIL H1 … 缺失: snapshotEvents(fromSeq, toSeqExclusive) —— 未命中`，其余 16 条仍 PASS，**exit 1** |
| 路径不存在 + `--strict` | `--asar /nonexistent --strict` | 打印 `SKIP: 指定的 asar 不存在或不是文件`，**exit 1**（非 strict 下 exit 0） |
| 目标不是合法 asar + `--strict` | `--asar ./package.json --strict` | `SKIP: 目标不可用：asar 头魔数不符（u32@0 应为 4）`，**exit 1** |
| checkout 模式可用性 | 把 rc.5 的 12 个包拷成 `node_modules/@deepseek-ai/...` 布局 | 17 条全 PASS，`--checkout` 生效 |
| `--json` / `--list` | 见上 | 均正常输出，`--list` 17 行 |

## 7. DSH 升级后的标准动作

1. 升级 DSH（桌面 app 或 CLI）。
2. `node scripts/check-runtime-contract.mjs`（CI/发布前用 `--strict`）。
3. 全 PASS → 继续跑既有门禁：`node scripts/test-host.mjs --strict`、`node scripts/check-client-static.mjs --strict`、`node scripts/e2e-host.mjs`。
4. 出现 FAIL → 先看它是哪条契约：
   - **H1/H2**：事件读取接口变了 → 插件 live/冷会话路径要跟着改，最坏退化 baseline，属 P0 级。
   - **H3/H4**：路由/鉴权行为变了 → API 可能全部 404 或 401，属 P0 级。
   - **H5/H6/H7**：Fork/Create/归档签名变了 → 回退与归档流程失效，属 P1 级。
   - **C1–C10**：客户端 UI 契约变了 → 操作行/输入区扩展/定义注册可能整块消失，属 P0–P1 级。
5. 官方**有意**变更契约时：先改插件代码，再更新本文档与 `CONTRACTS` 数组里的断言（两者必须同一次提交）。

## 8. 已知局限

- **静态文本断言 ≠ 行为验证**：只证明符号/形状在位，不证明语义没变（例如 `atSeq` 从 inclusive 改成 exclusive）。语义靠 `scripts/test-host.mjs` 的 mock 语义用例 + `scripts/e2e-host.mjs` 的真机行为断言兜底。
- **压缩产物**：断言按宽松正则匹配，能容忍 minify 与重排；但若命名被整体混淆（变量名改写），会 FAIL——那也确实说明契约不稳，应当人工复核。
- **`unpacked` 条目跳过**：当前用到的文件都在 asar 归档内；若未来某包改为 unpacked，需要扩展读取 `app.asar.unpacked/`。
- **版本号只展示不判定**：脚本不比较 `0.2.1-rc.5` 这类字符串，报警来自符号断言（比版本号更精确）。升级后即使版本号没变（热修）也能发现问题。
- **`snapshotEvents/ownEvents/eventAt` 已被官方标 `@deprecated`**（见 `dsh-session/lib/index.js:1434/1446/1461`，Agent Note `2026-09-09-deprecate-synchronous-session-event-reads.md`）。但官方自身仍在用（如 `dsh-api-session-controller/lib/index.js:1092/1534`），插件**跟随现状**使用，并由 H1 守住它不消失。将来官方彻底移除时，H1 会红——这正是我们要的早期预警，届时再迁移到异步读接口。
- **不覆盖平台差异**：只读当前安装的运行时；Electron 端与 CLI 端共用同一份 asar，故覆盖两者。不同架构（arm64/x64）的 asar 布局一致。

## 9. 维护

- 契约清单是一个数组 `CONTRACTS`（`scripts/check-runtime-contract.mjs`），新增契约 = 加一条对象（`id/title/why/files/needs`），无需改其它代码。
- 断言写法约定：`needs[].re` 用「符号出现」级正则，不写行号、不写大段上下文；`files` 按优先级列候选（命中可跨候选，用于兼容包拆分/重命名）。
- 判据：**契约点消失 = FAIL**；插件的降级路径（如快照缺失时不崩）不改变契约本身，不进本清单，由 `check-client-static.mjs` 的渲染降级冒烟覆盖。
