# Client 半区契约审计（client.js vs DSH 0.2.1-rc.2）

审计对象：`client.js`（826 行，全部 `React.createElement`）。
官方依据：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内包，用 `/tmp/asar-tool.mjs cat` 抽取后按 `文件:行号` 引用；README 同为 asar 内文件。
审计日期：2026-10-18。结论只覆盖 Client 半区；host（index.js）契约不在本文范围（见 docs/audit-host.md）。

## 0. 证据文件（路径简称）

| 简称 | asar 内路径 | 本机抽取副本（只读） |
|---|---|---|
| `[C]` | 本仓库 `client.js` | `/Users/xiao/Desktop/dsh/dsh-rewind/client.js` |
| `[UC]` | `dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` | `/tmp/dshx3/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js` |
| `[CHAT]` | `dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js` | `/tmp/dshx3/.../dsh-client-ui-chat/lib/client.js` |
| `[REN]` | `dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js` | `/tmp/dshx3/.../dsh-client-ui-renderer/lib/client.js` |
| `[UISESS]` | `dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js` | `/tmp/dshx3/.../dsh-client-ui-session/lib/client.js` |
| `[CTRL]` | `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js` | `/tmp/dshx3/.../dsh-api-session-controller/lib/client.js` |
| `[WSCTRL]` | `dsh/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/client.js` | `/tmp/dshx3/.../dsh-api-workspace-controller/lib/client.js` |
| `[WS]` | `dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js` | `/tmp/dshx3/.../dsh-client-ui-workspace/lib/client.js` |
| `[LOCALE]` | `dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js` | `/tmp/dshx3/.../dsh-client-locale/lib/client.js` |
| `[CORDIS]` | `dsh/node_modules/@deepseek-ai/cordis/lib/index.js` | `/tmp/dshx3/.../cordis/lib/index.js` |
| `[MOD-README]` | `dsh-client-modules/README.md` | `/tmp/dsh-pkgs/.../dsh-client-modules/README.md` |
| `[UC-README]` | `dsh-client-ui-conversation/README.md` | `/tmp/dsh-pkgs/.../dsh-client-ui-conversation/README.md` |
| `[REN-README]` | `dsh-client-ui-renderer/README.md` | `/tmp/dshx3/.../dsh-client-ui-renderer/README.md` |
| `[LOCALE-README]` | `dsh-client-locale/README.md` | `/tmp/dshx3/.../dsh-client-locale/README.md` |

## 1. 结论摘要

- 插件装配（`__ModuleLoader__.load` → `{inject, apply}`）**契约正确**。
- 槽位 API 用法（`ctx.slots.inject` + `ctx.slots.register({ name, key | id, order, locale, inject }, Component)`）**契约正确**；`conversation.chat.node`、`conversation.input.left` 两个槽位**真实存在**，scope/entryKey 匹配方式正确。
- 自定义 Conversation Event Definition（`ctx.uiConversation.events.register`，`target:"chat"` + `buildViewNode`）**被官方支持**，不是不可行方案；node 形状（key/target/kind/id/anchorSeq/location/visibility/data）**符合**。
- `useChat` **是** node 槽位组件的标准 hook（属 session scope 标准 props），不是缺失项；**不要**改成 `uiConversation.binding().target()` 的降级方案。
- 真正阻断功能的是三处 P0：动作行拿到的 `node` 是它自己的动作节点（永远渲染 null）；`inject` 缺 `uiWorkspace`（回退后子会话永不打开）；`workspaces.archiveSession` 传参形状错误（父会话永不归档）。
- P1 四类：复制 Markdown 的 assistant 文本字段名错误（`type` vs `kind`）；硬编码中文 3 处；archive 时机未与 cut 成功绑定；Definition `match` 缺 `surfaceOp==="append"` 过滤。
- P2 五类：两个不存在的 CSS 变量、`anchorSeq` 小数会切技能名批次、收藏 turn 号在回退后失效、历史包装只在 HistoryButton 挂载后才生效、`setDraftOn` 轮询存在可接受的竞态。

## 2. 逐契约审计

### 2.1 `window.__ModuleLoader__.load({ id, factory })`

- 使用点：`[C]:13-15` `window.__ModuleLoader__.load({ id: "@local/dsh-rewind", factory(require) {...} })`；`[C]:746-748` 返回 `{ inject: [...], apply(ctx) }`。
- 官方契约：
  - 每个 client bundle 以 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` 注册，执行时只注册工厂，`factory(require)` 在物化时运行并返回 exports（`[MOD-README]:22-24`「Executing a plugin bundle only registers its factory… `factory(require)` → exports」）。
  - 浏览器装载的插件是 Cordis 插件形态：exports 提供 `inject`/`apply`。同类官方 bundle 见 `[CHAT]` 文件头 `window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-chat", factory: (require) => {... exports.apply = apply; exports.inject = inject; ...}`（`[CHAT]` 文件末尾区域），以及 `[UISESS]:1100-1141` 的 `function apply(ctx)` 导出。
  - `require("react")` 属平台 seed 表（`[MOD-README]:50-52`「shell seeds a frozen module table… every dynamic bundle resolves its externals against exactly that baseline」）。
- 判定：**OK**。`package.json` 的 `exports["./client"]` 与 `dsh.client.platform/immediately` 也在（`package.json:1` 内容），无需改。
- 最小修复：无。

### 2.2 locale 注册与 `t()` 插值

- 使用点：`[C]:20` `NS="dsh-rewind"`；`[C]:22-101` `ZH`/`EN`；`[C]:751` `ctx.locale.register(NS, { zh, en })`（包在 `ctx.effect` 内）；渲染处 `[C]:452,458,462,469-473,506,510,542-546,592-604,617,623,636,652,654,690,695,704` 用 `t(...)`；插值调用 `[C]:471-473` `t("rollbackDone", { restored, deleted })`。
- 官方契约：
  - `ctx.locale.register(ns, { zh, en })` 是公开字典注册方式，注册后立即生效、无需重挂（`[LOCALE-README]:37-39`）。
  - `t(key, params)` 插值语法为 `{name}`，实现见 `[LOCALE]:1428` `template.replace(/\{(\w+)\}/g, ...)`；未提供的占位符保留原样。官方示例 `t('export', { title: displayTitle })`（`[WS]:123-171` 的 README 示例）。
  - 槽位组件的 `t` 由注册项 `locale: NS` 注入（`[REN]:737-760` `standardKit` → `localeSeat`，`[REN]:543-558`）。
- 判定：**OK**（键覆盖完整：脚本比对 `t("…")` 全部 29 个键在 ZH/EN 中都存在；`mood.*` 走变量下标，6 个键亦存在）。
- 遗漏：硬编码中文/英文混排（见 P1-2），以及缺少 3 个应新增的键。

### 2.3 槽位注册 API 与 props 投影

- 使用点：
  - `[C]:767-772` `ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name, key:"dsh-rewind-actions", locale, inject:(sessionId)=>({sessionId}) }, p => guardSlot(... QuestionActions({...p, ctx})))`。
  - `[C]:774-792` 六个 `conversation.input.left` 注册：`{ name, id, order, locale, inject:(sessionId)=>({sessionId}) }`。
- 官方契约：
  - `ctx.slots.inject(name, cb)` 等待声明、声明消失时撤下贡献、恢复后重注册；`cb` 内 `ctx.slots.register(options, Component)`（`[WS]:160-172` 的 README 示例，`[UC]:19771-19812` 实际调用）。
  - `options` 字段：`name`（必填）、keyed 槽位用 `key`、list 槽位用 `id` 与 `order`、`priority`、`locale`、`inject`（可为 `(sessionId, actions) => face`）、`children`、`store`（`[WS]:156-171`、`[CHAT]:7186-7260`、`[CHAT]:13207-13217`、`[UC]:19802-19895`）。
  - 注册项 component props = 标准 scope props + 注册 `inject` 返回值 + 槽位声明级 `inject` + owner props；`hooks`/`keyedHooks` 以 `use<Name>` 形式展开（`[REN]:437-445` `runInject`；`[REN]:667-690`；`[REN]:737-790` `standardKit`；`[REN]:793-811` `renderEntry`）。
  - session scope 的标准 props 由 `ctx.uiSession` 合并提供（`[UISESS]:756-763` `BUILTIN_SOURCE`：`hooks:["session"]`、`keyedHooks:["projection"]`、`props:["sessionId"]`；`[UISESS]:1105-1115` `provideRoot` + `installScope("session", …)`），因此 `sessionId` **本来就是标准 prop**；`inject:(sessionId)=>({sessionId})` 属于冗余但无害（`renderEntry` 展开顺序 owner 后到，无重叠断言）。
  - `inject` 的第一个实参是当前 binding 的 sessionId，第二个是 `actions`（`[REN]:437-445`：`if (binding !== void 0) args.push(binding.key); if (actions !== void 0) args.push(actions)`）。官方同样写法的注册项很多：`[CHAT]:7246-7254`（turn-tail）、`[CHAT]:13207-13217`。
- 判定：**OK**（`key`/`id`/`order`/`locale`/`inject` 用法都正确；`inject:(sessionId)=>…` 拿到的是 sessionId，不是 owner props）。
- 说明：`ctx.slots.inject` 的返回值未保存、也未包在 `ctx.effect` 里，与官方写法一致（`[CHAT]:7186` 起、`[UC]:19802`），生命周期由 ctx 纤维持有，不是缺陷。

### 2.4 `conversation.chat.node` 槽位与“自定义节点身份”（P0-1）

- 使用点：`[C]:767-772` 注册 key=`dsh-rewind-actions`；`[C]:422-424` `QuestionActions({ node, sessionId, useChat, t, ctx })`；`[C]:424-429` `useSnapshot(useChat, …, snap => analyzeQuestion(snap, node.key))`；`[C]:346-348` `analyzeQuestion` 内 `chatSnap.nodes.get(nodeKey)` 并断言 `node.kind !== "user"` 返回 null；`[C]:441` `if (info === null) return null`。
- 官方契约：
  - 槽位真实存在：由 ui-chat 的 `conversation.chat.flow` 注册项声明为其 keyed children：`{ kind:"keyed", scope:"session", inject: CHAT_NODE_INJECT }`（`[CHAT]:13207-13217`）。
  - 渲染位置与 owner props：`const routedOwner = { ...owner, node: routedNode }`，`renderSlot("conversation.chat.node", routedOwner, { entryKey: routedNode.kind, … })`（`[CHAT]:3798-3819`）。`entryKey` 用 `routedNode.kind` 选注册项 ⇒ 本插件的行渲染时 `props.node` 就是**本插件 kind 的动作节点**（`kind:"dsh-rewind-actions"`、`data:{seq,time,content}`，`[C]:729-743`），不是 user 节点。
  - 官方自定义/扩展节点同样语义：`node` 是当前被渲染的节点（官方 `TurnTailNodeView({ node, … })` 拿到的是 `turn-tail` 节点，`[CHAT]:6964-6974`）。
  - user 节点身份：官方 `input-message` Definition 的 `buildViewNode` 返回 `chatNode(context, context.state.kind, context.state.seq, context.state)`，`state.seq = event.seq`、`state.content = event.data.content`、`state.source = event.data.source`（`[CHAT]:9845-9900`；`chatNode` 形状 `[CHAT]:7686-7697`）。
- 判定：**错误（P0）**。`analyzeQuestion(snap, node.key)` 用动作节点自己的 key 查回动作节点，`kind !== "user"` 恒成立 ⇒ `info === null` ⇒ `QuestionActions` 永远渲染 null。**整条“每问操作行”功能从未运行**，与 `useChat` 无关。
- 最小修复：`analyzeQuestion` 改为接收动作节点的 `node.data.seq`（user/message 事件 seq），在快照里反查真正的 user 节点：
  ```js
  const userNode = safeCompute(undefined, () => {
    const seq = node.data?.seq;
    for (const n of chatSnap.nodes.values()) {
      if (n?.kind === "user" && (n.data?.seq === seq || n.anchorSeq === seq)) return n;
    }
    return undefined;
  });
  ```
  随后 `turn`/`userText`/`isLastQuestion` 全部基于该 user 节点；`key` 不得用于反查（动作节点 key 是 assembler 生成的 `${kind.length}:${kind}${id}` 形式，`[UC]:1746-1748`）。
- 附加约束（P1-4）：修好后 selector 仍**不能返回新对象**。`[REN]:156-161` 的 `bindSnapshotSelector` 直接使用 `useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)`；`standardKit`/`useSnapshot` 每次渲染都会新建箭头 selector，导致其 `useMemo` 依赖（含 selector 身份）重置、选中对象每次 render 都是新引用 ⇒ 触发 React 的 snapshot-changed 重渲染循环。官方所有 `useChat` selector 都返回基本量或稳定引用（`[CHAT]:6968-6971`、`[CHAT]:166-176`）。**修复必须拆成返回基本量的多个 selector**，不要整体返回 `{turn, boundarySeq, …}` 对象。

### 2.5 `useChat` 是否是 chat.node 组件 prop（推翻上一版猜测）

- 使用点：`[C]:423-424` 解构 `useChat`；`[C]:416-419` `useSnapshot` 在 `useHook` 非函数时返回 fallback。
- 官方契约链：
  1. ui-chat 用 `ctx.uiSession.provide({ hooks: ["chat"], resolve: … })` 把 `chat` 注册为 session scope 标准 hook（`[CHAT]:13106-13111`）。
  2. session scope 标准 props 生成：`materializeStandardBinding(binding, …)` 把 `binding.hooks` 的每个名字以 `standardHookPropName(name)`（即 `use` + 首字母大写，`[REN]:494290` 区域 / `[REN]` 见 `standardHookPropName` 调用）挂到 props（`[REN]:667-690`）。
  3. 槽位渲染按声明 scope 分派：`spec.scope === "session"` → `SessionEntry` → `standardKit(host, entry, "session", …)`（`[REN]:812-818`、`[REN]:1130-1165`）。
  4. chat.node 声明 scope 为 session（`[CHAT]:13208-13213`）；同槽位官方注册项 `TurnTailNodeView` 直接解构 `useChat` 且其注册未 inject 它（`[CHAT]:6964-6974`、`[CHAT]:7267-7281`）。
- 判定：**OK，`useChat` 可用**，本槽位动作组件是 session scope entry，会拿到 `useChat`/`useSession`/`useConversation`/`useInput` 等标准 hook 与 `sessionId` 标准 prop。**不要**为此改走 `ctx.uiConversation.binding(...).target("chat")` 降级方案（该 API 确实存在，见 2.6，但无必要）。
- 最小修复：无。

### 2.6 chat 快照结构 `nodes/timeline/locations`

- 使用点：`[C]:327-377`：`chatSnap.timeline?.turns` 迭代 `.values()` 取 `turn.end.seq`；`chatSnap.timeline?.turnOrder` 数组；`chatSnap.locations.getTurn(turn)` 返回 key 数组；`chatSnap.nodes.get(key)`、`[..chatSnap.nodes.values()]`；`node.kind`、`node.anchorSeq`、`node.data.content`、`node.data.blocks`。
- 官方契约（ChatSnapshotBuilder 及其 store / location index）：
  - `ChatSnapshotBuilder` 注册为 target `"chat"` 的 view（`[CHAT]:9434-9438`、`[CHAT]:9307`），快照形状 `{ order, nodes, locations, navigation, timeline, legacy }`（`[CHAT]:9368-9377`）。
  - `timeline = { turnOrder: number[], turns: Map<turn, Turn> }`；Turn 含 `start/end/status/steps`，`end` 是 `turn/end` 事件（有 `.seq`）（`[UC]:2100-2200` 区域 `rebuild` 构造，`[CHAT]:9138-9190` 的 `updateTimeline` 读 `turn.end.seq`）。
  - `locations.getTurn(turn)` 存在并返回该 turn 的 node key 数组（`[CHAT]:8649-8657`；官方用法 `[CHAT]:6956, 8342`）。
  - `nodes.get(key)` / `nodes.values()` 存在（`[CHAT]:8517-8585` `MutableChatNodeStore`）。
  - node 形状：`{ key, kind, id, target, anchorSeq, location, visibility, groupTree?, data }`（`[CHAT]:7686-7697`）；可见性判定 `visibility === "visible"`（`[CHAT]:8201-8203`）。
  - 排序按 `anchorSeq` 数值（`[CHAT]:8853-8861` `orderedVisibleChatNodes` → `presentationPosition`），无整数校验。
  - user 节点 `data.content` 是 `{type:"text", text}` 形状（`[CHAT]:8318` `node.data.content.flatMap(block => block.type === "text" ? …)`）。
  - assistant-step 节点 `data.blocks` 的文本块字段是 **`kind`**（`[CHAT]:6920-6922` `assistantText`: `block.kind === "text"`；`[CHAT]:6931-6936` 同理）。
- 判定：
  - `timeline.turns` / `turnOrder` / `turn.end.seq` / `locations.getTurn` / `nodes.get` / `nodes.values` / `anchorSeq` / `visibility`：**OK**。
  - `textOfContent`（user 侧，`[C]:323-326`）：**OK**（块字段 `type` 正确）。
  - `assistantTextOfTurn`（`[C]:365-377`）用 `b?.type === "text"`：**错误（P1-1）**，assistant 块字段是 `kind`，导致“复制本轮问答为 Markdown”的 `## A` 段恒为空。
- 最小修复：`assistantTextOfTurn` 内改为 `(b?.kind === "text" || b?.type === "text") && typeof b.text === "string"`（兼容两代形状，最小改动）。

### 2.7 `ctx.uiConversation.binding(...).target("chat")`（备选方案，不使用）

- 官方契约：`UiConversation.binding(source)` 返回稳定 Conversation binding（`[UC]:4073-4101`）；`BoundConversation.target(target)` 返回 `{ getSnapshot, subscribe }`，`getSnapshot = views.get(target)`，`subscribe` 时激活 target（`[UC]:3938-3952`）。ui-chat 内部正是用它在 session 标准 hook 里包出 `useChat`（`[CHAT]:13073-13103`）。
- 判定：**API 真实存在**，可作为降级方案（例如需要 keyed source 时）。但本插件已有 `useChat` 标准 prop，无需使用；若将来要拿“某节点的 bottom/process 源”，可 `ctx.uiConversation.binding(sessionId).target("chat")` 在 `inject` 的 `hooks` 面里注册（注意 `inject` 只对已保留 binding 有效，且 `[UC]:4083-4085` 对未知 session 会抛错，需包 try/safeCompute）。
- 最小修复：无（仅记录备选）。

### 2.8 Event Definition 契约（`ctx.uiConversation.events.register`）

- 使用点：`[C]:715-744` `rewindDefinition`：`kind/target/match/start/update/buildViewNode`；`[C]:765` 注册。
- 官方契约：
  - 注册入口 `ctx.uiConversation.events.register(definition)`；`kind` 为唯一键；`assertDefinitionTarget` 要求 `target` 与 `buildViewNode` 必须同时声明（`[UC]:3355-3360`、`[UC]:3439-3441`），仅此校验，**第三方 Definition 合法**（与 `[UC-README]:32,52` 一致）。
  - `match(event)` 收到内部 `SessionEventLike`（`type/seq/time/data`），返回 `{ id, role:"start"|"update", exclusive? }` 或 null（`[UC]:2789-2830` 的 `dispatchInput`）。
  - `start(contextSnapshot, startMatch, reader)`、`update(contextSnapshot, match)`；返回 State 必须非 undefined（`[UC]:2966-2972`、`[UC]:3280-3283`）；`contextSnapshot` 字段仅 `key/kind/id/matches/start/state/current`（`[UC]:2481-2490`）。
  - `startMatch = { event, role, location }`，`location` 为 resolved Location：`{kind:"session"}`、`{kind:"unresolved"}`、`{kind:"turn",turn}`、`{kind:"step",turn,step}`（`[UC]:2799-2805`、`[UC]:2000-2001`、`[UC]:2424-2435`、`[UC]:2124-2126`）。
  - `buildViewNode(contextSnapshot)` 返回 node；必须满足 `node.key === context.key` 且 `node.target === target`，否则 assembler 直接 throw（`[UC]:3137-3145`）；撤回一已物化 target 也是 throw（`[UC]:3153-3161`）。
  - 注册/注销跟随 ctx 纤维；registry 变更会重建已有 binding（`[UC]:3320-3352`、`[UC-README]:32`）。
- 逐字段判定：
  - `kind:"dsh-rewind-actions"`：**OK**（唯一即可）。
  - `target:"chat"` + `buildViewNode`：**OK**；chat 的 view builder 由 ui-chat 注册（`[CHAT]:9434-9445`），节点会进入 chat 快照。
  - `match`：`event.type === "user/message"` + `event.data.source.kind === "user"` 与官方 `messageDefinition` 一致（`[CHAT]:9856-9868`）；返回 `{id:String(event.data.id ?? event.seq), role:"start"}` **OK**。
  - `start`：返回 `{seq: match.event.seq, time, content: event.data.content}`，字段读取正确；`requireState` 不会因 undefined 抛错（每问必返回对象）**OK**。
  - `update: (context) => context.state`：**OK**（返回稳定同引用，不触发额外重建）。
  - `buildViewNode`：`key: context.key`、`target:"chat"`、`kind/id/anchorSeq/location/visibility/data` 与会话 `chatNode` 形状一致；`location` 取 `context.start?.location`（resolved Location）而非 `context.start` 本身，**正确**；兜底 `{kind:"unresolved"}` 也是合法 Location（`[UC]:2001`）。
  - `anchorSeq = state.seq + 0.1`：数值排序可用（`[CHAT]:8853-8861` 无整数校验），**语法/契约上可行**；但官方节点均用整数 seq，且 `SkillNameProjector` 会把任何非 message/context 节点当 batch boundary（`[CHAT]:8951-8975`、`[CHAT]:8996-9040`），该行会插在 user 消息之后切分技能名批次 ⇒ 可能丢失 user 气泡的 `/skill` 装饰（纯展示，P2）。
  - `match` 缺 `isAppendSurfaceEvent` 过滤：官方要求 `surfaceOp === "append"`（`[CHAT]:9476-9483`），并额外排除 compaction checkpoint（`[CHAT]:9843-9868`）。当前实现会把 replacement 窗里的 user/message 副本也匹配进来，可能产生重复动作行（P1-3）。
- 判定：Definition 整体**可行**；无结构性 P0；有 P1-3（append 过滤）与 P2-3（anchorSeq 小数副作用）。

### 2.9 `ctx.sessions`（binding / scope / list / create / fork）与 `session.prompt`

- 使用点：
  - `[C]:171-175` `ctx.sessions.binding(sessionId)` → `binding.session.cancel()`。
  - `[C]:199-205` `binding.session.prompt([{type:"text",text}], "queue")`。
  - `[C]:215-228` `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd`；`ctx.sessions.create({workspaceId}|{cwd})`；`ctx.sessions.fork({sessionId, atSeq})`。
  - `[C]:279-301` 包装 `session.prompt`。
  - `[C]:675` `ctx.sessions.list.getSnapshot().byId[sessionId]?.running`。
  - `[C]:187` `ctx.sessions.scope(sessionId)`。
- 官方契约：
  - `ctx.sessions` 由 `dsh-api-session-controller` client 以 `rootCtx.reflect.provide("sessions", …)` 提供（`[CTRL]:3841`）。
  - `binding(id)` 返回 `{ sessionId, session, eventSource, ctx }`（无 freeze，`[CTRL]:4057-4059`、`[CTRL]:4123-4145`）；`scope(id)` 返回已保留的 session-scope ctx（`[CTRL]:4014-4016`）。
  - `session.prompt(content, mode, signal?, requestId?)`：content 为块数组，文本块 `{type:"text", text}`，`mode` 为 `"queue"|"steer"`；返回 `{ ok, value? , error? }`，失败同时写 `promptError`（`[CTRL]:2342-2392`）。
  - `session.cancel()` 存在，返回 Remote 结果（`[CTRL]:2430-2444`）。
  - `list.getSnapshot()` 返回 `{ ids, byId, phase, error }`，`byId[id]` 摘要含 `id/displayTitle/running/blank/updatedAt/.../cwd?/title?/parentId?/origin?`（`[CTRL]:4147-4190`）。
  - `create(opts)`：`{ workspaceId }` 或 `{ cwd }`（+可选 `sessionId/agentPreset`），成功返回 sessionId string；失败抛 `SessionCreateError`（`[CTRL]:3973-3990`、`[CTRL]:3322-3340`）。
  - `fork(opts)`：`{ sessionId, atSeq?, allowMigration?, increaseTitle?, onCreated? }`，返回 childId string；失败抛 `SessionForkError`（`[CTRL]:3992-4012`）。`atSeq` 语义为「精确的含端点 seq」，省略则取最近完整 turn（`[CTRL]:3985-3994` 注释）；chat 的 Branch 按钮即 `ctx.sessions.fork({ sessionId, atSeq: turn.end.seq, … })`（`[CHAT]:13268-13283`）。
  - `session.prompt` 是原型方法、实例未冻结 ⇒ 赋值 own property 可成功（`[CTRL]:4123-4145` 无 `Object.freeze`）。
- 判定：
  - binding/cancel/prompt 块形状/queue 模式/list.byId.cwd/running/**create**/**fork**：**全部 OK**。`cutBefore` 对返回值 `string|number` 的判断与官方返回 string 一致。
  - `atSeq` 取“上一个已完成 turn 的 `turn.end.seq`”与 chat Branch 使用同一语义，**OK**；`null` 时新建会话走 `{workspaceId}`/`{cwd}` 也 **OK**（`byId.cwd` 与 `workspaces.list.items[].path` 均真实存在，`[WS]:1400-1408`、`[WSCTRL]:256-270`）。
  - 历史包装：**可行**（实例未冻结，方法可覆盖）；但 `[C]:630` 仅在 `HistoryButton` 的 effect 里调用 `ensurePromptWrapped`，若该组件未挂载则历史不记录；`[C]:282-284` 用 `session.__rewindHistoryWrapped` 与 `wrappedSessions` 双标记，HMR/重挂后旧包装可能残留（P2-4）。
- 最小修复：无 P0；P2-4 可把包装提前到 `apply` 里对“当前/新出现 session”兜底，或接受现状（记录为已知限制）。

### 2.10 `ctx.workspaces.archiveSession` 与 `ctx.uiWorkspace.openSession`（P0-2/P0-3）

- 使用点：
  - `[C]:177-180` `archive(ctx, sessionId)` → `ctx.workspaces.archiveSession({ sessionId })`（对象入参）。
  - `[C]:244-248` `await archive(...)` 后 `ctx.uiWorkspace.openSession(cut.childId)`。
  - `[C]:747` `inject: ["slots","sessions","workspaces","locale","uiConversation"]` —— **没有 "uiWorkspace"**。
- 官方契约：
  - `ctx.workspaces.archiveSession(sessionId: string, options?: { stopActivity?: boolean })`，第一参是字符串；服务签名与调用点见 `[WSCTRL]:417-419`、`[WSCTRL]:132-141`，官方调用 `this.workspaces.archiveSession(sessionId, options)`（`[WS]:1542-1543`）。
  - `ctx.uiWorkspace.openSession(target)` 存在，同步替换 mainView 引用（`[WS]:1471-1473`；README `[WS]:75`）。
  - Cordis 服务属性访问需要 inject 声明：未声明时 getter 抛 `cannot get property "<name>" without inject`（`[CORDIS]:675-700`，`error.message` 生成于 677 行）。官方使用 `ctx.uiWorkspace` 的包都把 `"uiWorkspace"` 写进 inject（`[CHAT]:13040-13051`、`[UC]:19439-19447`）。`ctx.get("conversation")` 这类显式 `reflect.get` 不需要 inject（`[CORDIS]:757-766`），所以 `[C]:184` 的用法正确。
- 判定：
  - **P0-2（错误）**：`inject` 缺 `"uiWorkspace"` ⇒ `[C]:246` 的 `ctx.uiWorkspace.openSession(...)` 抛错，被 `safeCompute` 吞掉 ⇒ 回退后子会话创建成功但**永远不会被打开**，用户视角是“点了没反应”。
  - **P0-3（错误）**：`archive({sessionId})` 传对象给只接受字符串的第一参 ⇒ Remote schema 校验失败/抛 `WorkspaceArchiveError`，被 `settle` 吞掉 ⇒ 父会话**永不归档**。两处叠加使 rollback 流程不可见地失败。
  - 另一处顺序问题：`[C]:244` 在`cut.childId === null`（fork/create 失败）时也执行 archive；修好签名后会“失败还归档父会话”，必须改为成功后归档（P1-3）。
- 最小修复：
  1. `[C]:747` inject 追加 `"uiWorkspace"`。
  2. `[C]:178-180` 改为 `ctx.workspaces.archiveSession(sessionId)`（可传 `{}`）。
  3. `cutBefore` 内把 `await archive(ctx, sessionId)` 移到 `cut.childId !== null` 之后。

### 2.11 `conversation.input.for(scope).setDraft` 与对话服务

- 使用点：`[C]:183-196` `ctx.get("conversation")` → `conversation.input.for(scope).setDraft(text)`，`scope` 由 `ctx.sessions.scope(sessionId)` 得到，40 次 × 50ms 轮询。
- 官方契约：
  - `conversation` 是 root 单例服务（`super(ctx, "conversation")`，`[UC]:4644-4646`；`ctx.get("conversation")` 读取方式见 `[UC]:4963`、`[UC]:19486`）。
  - `conversation.input` 是 `InputHub`（`[UC]:4647-4652`、`[UC]:15701-15756`）；`for(actx)` 需要**已保留的 session-scope ctx**，内部 `sessions.sessionOf(actx)` 校验（`[UC]:15742-15746`），否则抛 `conversation.input.for requires a retained Session scope`。
  - `SessionInputShell.setDraft(text)` 是公开写入口（`[UC]:15009-15026`）；官方 `requestDraftInitialization(binding, { prompt })` 是其受控封装（`[UC]:15082-15088`、`[UC]:15747-15750`）。
  - 官方同构用法：`ctx.sessions.scope(sessionId).get("conversation")`（`[UC]:19478-19485`）、`conversation.input.for(actx)`（`[UC]:17214-17220`）。
- 判定：**OK**（`ctx.sessions.scope(id)` + root conversation + `input.for(scope)` 组合与官方一致；轮询处理 fork 后 child scope 尚未保留的竞态合理）。
- 备注（P2-5）：如果希望更稳，可在 child binding 可借时改用 `conversation.input.requestDraftInitialization(binding, { prompt: text })`；当前实现对“draft 已有用户输入”可能覆盖，属可接受行为。

### 2.12 自定义 HTTP API（`/dsh-rewind/api/*`）

- 使用点：`[C]:156-168` `callApi(method, payload)` → `POST /dsh-rewind/api/<method>`，要求 `{ ok:true, value }`；`[C]:236-241` restore payload `{sessionId, atSeq, dryRun}` / `{sessionId, baseline:true, dryRun:false}`；读取 `restored/deleted/skipped` 数组。
- host 侧（只读核对，不改）：`index.js:624-657` 注册 `path: "/dsh-rewind/api"`，`/dsh-rewind/api/<method>` 分派；restore 读取 `atSeq`/`baseline`/`dryRun` 并返回 `{restored, deleted, skipped, dryRun}`（`index.js:280-337`、`index.js:618-620`）。
- 判定：**OK**（客户端路径/字段形状与 host 一致；鉴权走 DSH 连接层，`index.js:3` 注释说明）。
- 最小修复：无。

### 2.13 CSS 变量

- 使用点：`[C]:393` `--dsw-alias-label-tertiary`；`[C]:523` `--dsw-alias-label-secondary`；`[C]:538/571/572/596/603/708` `--dsw-alias-border-l1`；`[C]:538` `--dsw-alias-interactive-bg`；`[C]:571/707` `--dsw-alias-surface`；`[C]:571/707` `--dsw-alias-label-primary`。
- 官方依据：web 前端样式产物 `dsh-web-frontend/dist/assets/index-BxpfOGf3.css` + `vendor-DV2921Zo.css` 中：
  - `--dsw-alias-label-tertiary/secondary/primary`、`--dsw-alias-border-l{1..4}`、`--dsw-alias-bg-layer-{1..4}`、`--dsw-alias-interactive-bg-hover`/`-active`/`-hover-solid`、`--dsw-specific-input-major` **存在**（官方用例：`[CHAT]:193` 用 `--dsw-alias-border-l4`/`--dsw-alias-label-tertiary`/`--dsw-alias-bg-layer-1`；`[CHAT]:2680` 用 `--dsw-alias-interactive-bg-hover-solid`）。
  - `--dsw-alias-surface`、`--dsw-alias-interactive-bg`（裸名）**不存在**（两份 CSS 全文 0 次命中）；当前靠 fallback `#fff`/`rgba(0,0,0,.04)` 生效。
- 判定：**错误（P2-1，样式）**。深色主题下弹层背景为白色 fallback 而文字用 `--dsw-alias-label-primary`（浅色）⇒ 弹层文字可能不可读。
- 最小修复：`--dsw-alias-surface` → `--dsw-alias-bg-layer-1`；`--dsw-alias-interactive-bg` → `--dsw-alias-interactive-bg-hover`（或 `--dsw-specific-input-major`）。

### 2.14 `[data-chat-turn]` DOM

- 使用点：`[C]:313-320` `jumpToTurn` 查询 `[data-chat-turn="${turn}"]` 并 `scrollIntoView`；`[C]:655` 收藏面板展示轮次。
- 官方契约：flow item 包装节点真实输出 `"data-chat-turn": turn`（`[CHAT]:3812`）；同一属性在 `ApproveCommand`/导航读取处也使用（`[CHAT]:2236、2263、4213`）。
- 判定：**OK**（属性真实存在；`querySelector` 命中该 turn 的第一个 row，通常是 user 气泡，滚动定位符合预期）。
- 备注（P2-3）：收藏存的是 `turn` 序号，rollback/fork 后 turn 编号可能整体前移，旧收藏会指向别的轮；属数据模型限制，不是契约错误。

### 2.15 Companion 的 `running` 轮询

- 使用点：`[C]:675` `ctx.sessions.list.getSnapshot().byId[sessionId]?.running === true`，每 1s 轮询。
- 官方契约：list 摘要确有 `running`（`[CTRL]:4147-4190`），且 session 快照 `running` 由 host 事件流同步（`[CTRL]:2596-2613`）。官方另有更精确的 `uiSession.sessionStatus`（`[UISESS]:786-800`、`[UISESS]:1105-1114`）与 `useSessionStatus` 标准 hook。
- 判定：**OK（近似可用）**；只用 list 摘要有延迟。P2：可改用 `useSessionStatus` 标准 hook（无需新增依赖，属标准 props）。
- 最小修复（可选）：P2。

### 2.16 crash-hardening 结构

- 使用点：`[C]:113-151` `safeCompute/runGuarded/safeDom/readStore/writeStore/settle`；`[C]:401-413` `SlotErrorBoundary` + `guardSlot`；所有 slot 渲染都经过 `guardSlot`。
- 官方依据：renderer 自身为每个 slot entry 装了 `SlotErrorBoundary`，捕获后输出 `data-slot-error` 并报 `slot entry crashed in '<slot>'`（`[REN]:630-650`）。业务侧再包一层是允许的，不会破坏契约（边界组件只是普通 React 组件）。
- 判定：**OK，保留**。注意：本插件边界返回 null（host 边界返回占位 div），两者叠加无害；不要因为修复而移除。

### 2.17 输入历史键盘处理

- 使用点：`[C]:794-822` document 捕获阶段监听 ArrowUp/ArrowDown，仅在焦点可编辑且为空时 `preventDefault` 并 `setDraft`。
- 官方契约：composer 是每 Session 一个 Lexical editor（`[UC-README]:78`），Enter/Escape/方向键的部分语义被 composer 自身 keymap 占用（`[UC-README]:98-100`）；官方未提供输入历史 API。
- 判定：**存疑但可用**（无契约冲突证据；捕获阶段 + 仅空 draft 时拦截，风险低）。**未能确认**：Lexical 在捕获阶段被外部 `preventDefault` 后是否会出现 caret/IME 异常，需真机验证。
- 最小修复：保持现状，真机若发现 IME/选区问题再退回 `keydown` 冒泡阶段。

## 3. 问题清单

### P0（阻断核心功能，必须先修）

| # | 问题 | 证据 | 最小修复 |
|---|---|---|---|
| P0-1 | `QuestionActions` 的 `node` 是自身动作节点（kind=`dsh-rewind-actions`），`analyzeQuestion(snap, node.key)` 查回自身 ⇒ `kind !== "user"` ⇒ 整行永远渲染 null | `[CHAT]:3798-3819`（routedOwner/entryKey）；`[CHAT]:9845-9890`（官方 user 节点 data.seq）；`[C]:346-348,441` | 用 `node.data.seq` 反查 `kind==="user"` 节点后再算 turn/userText/isLastQuestion；**selector 只返回基本量** |
| P0-2 | `inject` 缺 `"uiWorkspace"`，`ctx.uiWorkspace.openSession` 抛 “cannot get property … without inject” 被 safeCompute 吞掉 ⇒ 回退后子会话不打开 | `[CORDIS]:675-700`；`[C]:246,747`；官方 inject 列表 `[CHAT]:13040-13051` | inject 数组追加 `"uiWorkspace"` |
| P0-3 | `ctx.workspaces.archiveSession({sessionId})` 签名错误（第一参应为 string）⇒ 父会话永不归档 | `[WSCTRL]:417-419`、`[WSCTRL]:132-141`、`[WS]:1542-1543`；`[C]:178-180` | 改为 `ctx.workspaces.archiveSession(sessionId)` |

### P1（功能缺失/错误，本轮一并修）

| # | 问题 | 证据 | 最小修复 |
|---|---|---|---|
| P1-1 | 复制 Markdown 的 assistant 文本恒为空（块字段用 `type`，实际是 `kind`） | `[CHAT]:6920-6922,6931-6936`；`[C]:365-377` | 同时接受 `kind`/`type` |
| P1-2 | 硬编码中文/混排：`第 N 轮`、`fork failed`、全角冒号、继续按钮发送中文“继续” | `[C]:458,462,617,655` | 新增 locale 键 `starTurn/forkFailed/continueText`（ZH/EN），全部走 `t()` |
| P1-3 | archive 在 cut 失败时也执行；且 match 缺 `surfaceOp==="append"` 过滤（replacement 副本会多出动作行） | `[C]:244-248`；`[CHAT]:9476-9483,9845-9868` | archive 移到 childId 非空后；match 增加 `(event.surfaceOp ?? "append") === "append"` |
| P1-4 | 修 P0-1 后若 selector 返回对象，会因 `useSyncExternalStoreWithSelector` 的 selector 身份变化进入重渲染循环（当前因恒返回 null 未触发） | `[REN]:156-161`；官方 selector 返回值 `[CHAT]:6968-6971` | `useSnapshot` 仅用于基本量；`analyzeQuestion` 拆为 `turn/nodeSeq/isLastQuestion/boundarySeq/userText` 多个 selector |

### P2（可选/体验）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P2-1 | `--dsw-alias-surface`、`--dsw-alias-interactive-bg` 不存在（深色主题弹层可能不可读） | CSS 产物 0 命中；官方用 `--dsw-alias-bg-layer-1`/`--dsw-alias-interactive-bg-hover-solid`（`[CHAT]:193,2680`） | 换真实变量 |
| P2-2 | `anchorSeq = seq + 0.1` 会被 `SkillNameProjector` 当批次 boundary，user 气泡的 `/skill` 装饰可能丢失 | `[CHAT]:8951-8975,8996-9040` | 保留（展示级）；或后续改为合入 assistant 尾部槽位 |
| P2-3 | 收藏按 turn 序号存储，rollback/fork 后指向错轮 | `[C]:306-320,644-658` | 记录 `(sessionId, turn)` 已含会话；跨会话失效可接受，文档标注 |
| P2-4 | 历史包装仅在 HistoryButton 挂载时安装；HMR/重挂可能残留旧包装 | `[C]:277-302,630` | 接受现状并在 README 标注；或 apply 时对当前 session 兜底调用 |
| P2-5 | `setDraftOn` 40×50ms 轮询 + 直接 setDraft，可能覆盖用户刚输入 | `[UC]:15082-15088,15742-15750` | 保持；后续可改 `requestDraftInitialization` |

## 4. 未能确认项

1. **Lexical composer 对捕获阶段 `preventDefault` 的 ArrowUp/Down 处理**：无官方源码级结论，需真机验证（2.17）。
2. **`anchorSeq` 小数在 turn rail/导航中的表现**：turn rail 用 `turnOutline`/seq 投影，本插件节点不在 rail 中；导航读取 `locations`，未见按 anchorSeq 取整的路径，但未逐行走读全部导航代码（风险低）。
3. **`ctx.workspaces.archiveSession` 用错误对象参数时 Remote 层的具体失败形态**：由 schema 校验拒绝（推断），被 `settle` 吞掉，未在真机观察日志。
4. **`session.prompt` own-property 覆盖在其他插件重挂/HMR 后的持久性**：无官方约定，属实现细节；建议真机观察。

## 5. 附：与上一轮猜测的差异

- 「`useChat` 不是 chat.node 的 prop」**不成立**：session scope 标准 kit 会注入全部标准 hooks（含 `useChat`），见 2.5；不要改走 `uiConversation.binding().target()`。
- 「QuestionActions 拿到自身节点」**成立**，列为 P0-1；这是行不渲染的直接原因。
- `ctx.sessions.fork({sessionId, atSeq})` 的客户端签名与 `create({workspaceId|cwd})` 的返回值判断**均正确**，无需修改。
