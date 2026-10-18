# Client 半区修复说明（client.js vs DSH 0.2.1-rc.2）

依据：`docs/audit-client.md`（task-2）。
范围：只改 `client.js`；未动 `index.js`、`package.json`、`dsh-backup`、`~/.dsh`；无新增运行时依赖；`SlotErrorBoundary` / `safeCompute` / `runGuarded` / `safeDom` 全部保留。
自检：`node --check client.js` 通过；另用 mock ModuleLoader + mock React + 假 chat 快照做了渲染级冒烟（见 §3）。

## 1. 改动清单（按修复项）

### P0-1 动作行拿到的是自身节点 → 每问操作行永不渲染

- 依据：ui-chat `lib/client.js:3798-3819`（`routedOwner = {...owner, node: routedNode}`、`renderSlot(... { entryKey: routedNode.kind })`）；官方 user 节点 `data.seq = event.seq`（ui-chat `9845-9890`）。审计 §2.4。
- 改动：
  - 新增 `findUserNode(chatSnap, seq)`（`client.js:352-359`）：按 `node.data.seq === seq || node.anchorSeq === seq` 在 chat 快照里反查 `kind === "user"` 的持久节点。不再用 `node.key` 反查（key 是 assembler 生成的复合 key）。
  - `turnOfNode(chatSnap, node)`（`client.js:360-371`）改为优先读官方 Location（`location.kind === "turn"|"step"` → `location.turn.turn`），读不到再回退到 `timeline.turnOrder` + `locations.getTurn` 扫描。
  - `analyzeQuestion(chatSnap, seq)`（`client.js:373-391`）签名从 `nodeKey` 改为 `questionSeq`，内部先 `findUserNode`，`nodeSeq` / `userText` / `isLastQuestion` 全部基于找到的 user 节点。
  - `QuestionActions`（`client.js:452-485`）从 `node?.data?.seq` 取 `questionSeq`，`info` 与 `mdText` 两个 selector 都改用它。
- 行为变化：动作行不再恒为 null；历史轮显示 ↶/🔁/📋/⭐，最后一问额外显示 ✎。修复前整条功能不可见。

### P1-4（与 P0-1 同批）selector 只返回稳定值

- 依据：ui-renderer `lib/client.js:156-161`（`useSyncExternalStoreWithSelector` + 每次渲染新建的 selector 身份）；官方 `useChat` selector 均返回基本量/稳定引用（ui-chat `6968-6971`）。审计 §2.4 附加约束。
- 改动：`info` 不再是对象 selector。`infoKey` selector（`client.js:463-468`）把 `turn/nodeSeq/boundarySeq/isLastQuestion/userText` 编码成一个 `\u0000` 分隔字符串；`info` 由该字符串在渲染期安全解码（`client.js:469-485`）。`mdText` 仍返回字符串。
- 行为变化：避免“对象每次都是新引用”导致的 snapshot-changed 重渲染循环；快照未变时 selector 结果稳定。

### P0-2 inject 缺 `uiWorkspace` → 回退后子会话不打开

- 依据：cordis `lib/index.js:675-700`（未 inject 的服务属性访问抛 `cannot get property "<name>" without inject`）；官方 ui-chat inject 列表含 `uiWorkspace`（ui-chat `13040-13051`）；本插件 `ctx.uiWorkspace.openSession` 在 `client.js:251`。审计 §2.10。
- 改动：`client.js:806` `inject` 追加 `"uiWorkspace"`（现为 `["slots","sessions","workspaces","uiWorkspace","locale","uiConversation"]`）。
- 行为变化：`cutBefore` 里 `ctx.uiWorkspace.openSession(childId)` 真正执行；回退后自动切到子会话。已静态核对本文件所有 `ctx.<service>` 访问（slots/sessions/workspaces/uiWorkspace/locale/uiConversation 均已在 inject；`ctx.get("conversation")` 是 cordis `get()`，不受 inject 约束，保持原样）。

### P0-3 archive 签名错误 → 父会话永不归档

- 依据：api-workspace-controller `lib/client.js:417-419`（`archiveSession(sessionId, options = {})`）、`132-141`；ui-workspace `lib/client.js:1542-1543` 同样按 string 调用。审计 §2.10。
- 改动：`client.js:184-186` `ctx.workspaces.archiveSession({ sessionId })` → `ctx.workspaces.archiveSession(sessionId)`。
- 行为变化：回退成功后旧会话被归档；错误参数不再被 Remote schema 拒绝后静默吞掉。

### P1 archive 时机：只在 fork/create 成功后归档

- 依据：审计 §2.10 顺序问题（原实现 fork 失败也会 archive）。
- 改动：`cutBefore`（`client.js:250-255`）把归档移进 `if (cut.childId !== null)` 分支，顺序为 openSession → setDraft → archive。
- 行为变化：fork 失败时保留当前会话可继续使用，只报错不归档；restore 失败仍会归档（对话回退已完成，符合语义）。

### P1 assistant 文本块字段：`type` → `kind`

- 依据：ui-chat `6920-6922` `assistantText`: `block.kind === "text"`；`6931-6936` 同理。审计 §2.6。
- 改动：`assistantTextOfTurn`（`client.js:393-411`）同时接受 `b.kind === "text"` 与 `b.type === "text"`（兼容两代形状）。
- 行为变化：“复制本轮问答为 Markdown”的 `## A` 段不再恒为空。

### P1 `match` 补 `surfaceOp` 过滤

- 依据：ui-chat `9476-9483` `isAppendSurfaceEvent`、`9845-9868` 官方 input-message 只用 append-origin 事件；审计 §2.8。
- 改动：`client.js:778` 在 `rewindDefinition.match` 增加 `if (event.surfaceOp !== undefined && event.surfaceOp !== "append") return null;`（字段缺失视为 append，兼容旧日志）。
- 行为变化：replacement 副本（compaction/重写）不再生成重复动作行。

### P1 硬编码中文/混排 → locale 键

- 依据：审计 §2.2 / P1-2。
- 改动：
  - 新增键：`forkFailed`（ZH `client.js:31` / EN `74`）、`continueText`（`42` / `85`）、`starTurn`（`53` / `96`）；`restoreFailed` 改为带 `{message}` 插值（`29` / `72`）。
  - `client.js:514` `"fork failed"` → `t("forkFailed")`；`client.js:518` `${t("restoreFailed")}：${err}` → `t("restoreFailed", { message })`；`client.js:673` 继续按钮发送内容 `"继续"` → `t("continueText")`；`client.js:711` 收藏面板 `` `第 ${turn} 轮` `` → `t("starTurn", { turn })`。
- 行为变化：英文界面不再出现中文；修复 `restoreFailed` 的全角冒号硬编码。

### P2 CSS 变量改为真实存在的别名

- 依据：审计 §2.13（`--dsw-alias-surface`、`--dsw-alias-interactive-bg` 在前端 CSS 产物中 0 命中；官方用 `--dsw-alias-bg-layer-1`、`--dsw-alias-interactive-bg-hover-solid`，ui-chat `193/2680`）。
- 改动：`client.js:594` `--dsw-alias-interactive-bg` → `--dsw-alias-interactive-bg-hover`；`client.js:627`、`client.js:763` `--dsw-alias-surface` → `--dsw-alias-bg-layer-1`。
- 行为变化：深色主题下弹层背景与文字对比度恢复正常（fallback 仍保留）。

### 明确不改的项（避免误改）

- `useChat` 不是缺失项：ui-renderer `667-690` + ui-chat `13106-13111` + chat.node `scope:"session"`（ui-chat `13208-13213`）证明它是 session 标准 hook；**没有**改成 `ctx.uiConversation.binding().target()`。
- 自定义 Event Definition（`target:"chat"` + `buildViewNode`）官方支持（ui-conversation `3439-3441`、`3137-3145`），**没有**降级到别的槽位；动作行仍是自定义 chat node。
- `ctx.sessions.create({workspaceId|cwd})` / `fork({sessionId, atSeq})` / `conversation.input.for(scope).setDraft` / `session.prompt([{type:"text"}], "queue")` / `locale.register` / `[data-chat-turn]` 均与官方契约一致，未改。

## 2. 行区间 diff 摘要

| 区域 | 行区间（改后） | 变化 |
|---|---|---|
| ZH 字典 | 29-53 | `restoreFailed` 插值化，新增 `forkFailed`/`continueText`/`starTurn` |
| EN 字典 | 72-96 | 同上 |
| archive 调用 | 184-186 | 参数改为 `sessionId` |
| cutBefore 归档顺序 | 250-255 | 归档移入 `childId !== null` 分支 |
| 节点反查/轮次解析 | 343-411 | 新增 `findUserNode`；`turnOfNode`/`analyzeQuestion` 改为按 seq；`assistantTextOfTurn` 接受 `kind` |
| QuestionActions selector | 452-485 | `questionSeq` + 字符串 `infoKey` + 解码；`mdText` 用 seq |
| 错误文案 | 514-518 | `forkFailed` / `restoreFailed{message}` |
| CSS 变量 | 594, 627, 763 | 换真实变量名 |
| 继续按钮文案 | 673 | `t("continueText")` |
| 收藏轮次文案 | 711 | `t("starTurn", { turn })` |
| Definition match | 774-781 | 增加 `surfaceOp === "append"` 过滤 |
| inject | 806 | 追加 `uiWorkspace` |

## 3. 自检记录

### 3.1 语法

```
$ node --check client.js
（退出码 0）
```

### 3.2 渲染级冒烟（mock 环境，脚本为临时 scratch，不入库）

方法：mock `window.__ModuleLoader__.load` 捕获工厂 → 用 mock React（`createElement/useState/useEffect/useRef/useCallback/Component`）取 `{inject, apply}` → mock ctx（effect/slots/locale/sessions/workspaces/uiWorkspace/uiConversation + 假 `document`）→ 执行 `apply` 拿到全部槽位注册回调 → 用假 chat 快照直接渲染。

假快照：turn 1（已完成，end.seq=10）含 user/动作行/assistant 节点；turn 2（open）含 user/动作行；`locations.getTurn` 按 turn 返回 key 数组。

结果（全部符合预期）：

```
module id: @local/dsh-rewind | exports: [ 'inject', 'apply' ]
slot registrations: conversation.chat.node:dsh-rewind-actions, conversation.input.left:dsh-rewind-phrases, ... , conversation.input.left:dsh-rewind-companion
row1 rendered: true
row1 buttons: rollback | regenerate | copyMarkdown | star          # 历史轮，无 edit
row2 buttons: rollback | edit | regenerate | copyMarkdown | star    # 最后一问，有 edit
input.left dsh-rewind-phrases -> rendered
...（6 个 input.left 均 rendered）
copied text: "## Q\nfirst question\n\n## A\nfirst answer"          # P1-1 修复生效
no user node -> null                                               # 快照缺 user 节点时不崩、不渲染
missing useChat -> null                                            # hook 缺失时安全降级
definition match: {"id":"m2","role":"start"}
buildViewNode: {"key":"dsh-rewind-actions:18dsh-rewind-actionsm2","kind":"dsh-rewind-actions","anchorSeq":20.1,"data":{"seq":20,"time":1,"content":[]}}
replacement event ignored: null                                    # surfaceOp 过滤生效
```

### 3.3 静态核对

- 本文件所有 `ctx.<name>` 访问：`slots / sessions / workspaces / uiWorkspace / locale / uiConversation / effect / get`；前 6 项全在 inject，后 2 项为 Cordis 内建。
- `analyzeQuestion` 的所有调用点都传 seq；`findUserNode` 对 `seq` 非 number 直接返回 undefined（不会把 undefined 当 id 扫全表）。
- 未新增依赖、未新增文件、未动 `index.js` / `package.json`。

## 4. 遗留风险 / 本版本限制

1. **`anchorSeq = seq + 0.1`（未改）**：chat 的 `SkillNameProjector` 把任何非 message/context 节点当 batch boundary（ui-chat `8951-8975`、`8996-9040`），动作行插在 user 消息后会切分技能名批次，可能导致 user 气泡上的 `/skill` 装饰丢失。属展示级（P2），本轮未改；若要彻底消除，需要改为向官方 assistant/turn 尾部槽位注册（会改变每问行位置，非最小修复）。
2. **收藏按 turn 序号存储（未改）**：rollback/fork 后 turn 编号重排，旧收藏会指到别的轮（P2）。收藏 key 已含 sessionId，不会跨会话污染。
3. **输入历史包装时机（未改）**：`ensurePromptWrapped` 仅在 HistoryButton 挂载的 effect 中安装；HMR/重挂可能留下旧包装标记。当前用 `session.__rewindHistoryWrapped` + `wrappedSessions` 双标记兜底，实际影响低（P2）。
4. **`setDraftOn` 轮询（未改）**：40×50ms 直接 `setDraft`，在“用户在子会话立刻输入”的极端时序下可能覆盖首个字符；官方更受控的入口是 `conversation.input.requestDraftInitialization(binding, { prompt })`，需要 binding 可借，本轮保持最小改动（P2）。
5. **Companion 的 running 轮询（未改）**：用 `sessions.list` 摘要每秒轮询，状态可能滞后；官方 session scope 标准 hook `useSessionStatus` 更精确（ui-session `786-800`、`1105-1114`）。可后续改为标准 hook（P2，无契约风险）。
6. **Lexical 键盘拦截（未能确认）**：捕获阶段拦截空 draft 的 ArrowUp/Down 未在真机验证 IME/caret 行为；如出现问题，降级为冒泡阶段监听或移除该功能。
7. **自定义 chat node 的视觉位置**：动作行是独立 flow row（与 user 气泡同级、按 `anchorSeq` 紧随其后）。官方没有“question 行内插槽”，这是 0.2.1 下唯一可行路径；若后续官方提供 question 行内 slot，可迁移。

## 5. 结论

- P0 全部处置：P0-1（节点身份 + 稳定 selector）、P0-2（inject `uiWorkspace`）、P0-3（archive 签名）。
- P1 全部处置：assistant 块字段、surfaceOp 过滤、归档时机、硬编码中文/locale 插值。
- P2：CSS 变量已顺手修；其余 4 条留档（§4）。
- 无需降级方案：`conversation.chat.node` + 自定义 Event Definition 在 0.2.1 真实可用；`useChat` 由 session scope 标准 props 提供。
