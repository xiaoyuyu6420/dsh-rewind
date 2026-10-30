# 新宿主版本兼容复核:DSH 0.2.1-rc.2 → 0.2.1-rc.5

- 复核人:Lead
- 时间:2026-10-30(Asia/Shanghai)
- 触发:用户告知「新版本了」
- 对象:`/Users/xiao/Desktop/dsh/dsh-rewind` @ `fd13824`(rc.2 上完成验收的同一份代码,未改动)

## 0. 结论

**rc.5 兼容,无需改运行时代码。** 插件依赖的全部契约点在 rc.5 仍成立(逐条见 §2),
真机 boot 冒烟在 rc.5 上 **14/14 通过**,Host 单测 19/19,Client 静态守护 PASS。

同时发现两点值得记录:

1. rc.5 把 **同步事件读取整族标记为 deprecated**(`eventAt` / `snapshotEvents` / `ownEvents`,
   见 dsh-session `lib/index.js:1434,1446,1461`),而插件 live 读取路径正走 `snapshotEvents()`。
   官方自己的 `dsh-api-session-controller:1092,3051`、`dsh-session-title:282,457` 也仍在用同一族 API,
   且 rc.5 未提供等价的同步替代品 → **跟随官方现状保持不动**,但列为本插件最高的宿主升级风险
   (将来该族被移除时,restore 会退回 baseline:功能降级、不崩溃)。
2. rc.5 新增 `@deepseek-ai/dsh-workspace-changes`:按轮记录工作区变更(git 工作区快照 + 文件工具
   改动前的整文件捕获,`workspace/changes` 会话事件,回合前后逐文件对比,**仅在会话存活期间提供**)。
   它与本插件的文件检查点相邻但目标不同(它做展示/对比,不做还原),不构成替代;
   后续可考虑复用它的整文件捕获来补上本插件 1–5MB 文件「只记指纹不存内容」的缺口(未来工作)。

## 1. 版本与环境

| 项 | rc.2(上次验收) | rc.5(本次) |
|---|---|---|
| CLI `--version` | 0.2.1-rc.2 | **0.2.1-rc.5** |
| `app.asar` mtime | — | 2026-10-29 21:47 |
| 桌面 GUI URL | 127.0.0.1:62075 | 127.0.0.1:60354 |
| asar 内 `dsh/package.json` version | 0.2.1-rc.2 | 0.2.1-rc.5 |
| `@deepseek-ai/cordis` | — | 4.0.5 |

包数量明显增加(rc.5 多出 `dsh-agent-preset-*`、`dsh-client-ui-*` 多个 UI 包、
`dsh-experimental-*`、`dsh-workspace-changes`、`dsh-session-checkpoint-policy` 等),但下面
逐条契约未受影响。

## 2. 契约逐条复核(rc.5 证据)

### Host 半区

| # | 契约点 | 插件用途 | rc.5 证据 | 判定 |
|---|---|---|---|---|
| H1 | `session.snapshotEvents(from,to)` / `ownEvents()` / `eventAt(seq)` | `liveEventsOf()` 取 live 会话完整日志(含 fork 继承前缀) | `dsh-session/lib/index.js:1452`(snapshotEvents)、`:1466`(ownEvents)、`:1440`(eventAt) | 存在(**deprecated**) |
| H2 | `sessionPersistence.open(id,'read')` / `stat(id)` / `handle.read()` | 冷会话(fork 前缀/重启后)还原 | `dsh-session-persistence-jsonl/lib/index.js:2488`(open)、`:2570`(stat)、`:63`(read);README 明确 `read()` 返回 `{ eventState, events }` | 存在 |
| H3 | `connection.requestRejection(request)` | API fail-closed 鉴权 | `dsh-client-connection/lib/index.js:737` | 存在 |
| H4 | `webServer.register({kind:'prefix'|'exact', path, handler})` | `/dsh-rewind/api` 路由 | `dsh-host-webserver/lib/index.js:327-328`(exact/prefix 两张表)、`:500-502`(最长前缀优先);rc.5 真机 e2e 断言 405/404 通过 | 存在 |
| H5 | fork RPC `{sessionId, atSeq?, allowMigration?}`,atSeq 为**闭区间切点** | 回退 = 从上一轮 `turn/end.seq` 处分叉 | `dsh-api-session-controller/lib/index.js:844-871`(:870 `boundary = atSeq ?? latestCompletedPrefixBoundary(...)`);`typert.host.js:1601` jsonSchema 含 atSeq | 存在 |
| H6 | create RPC 同时接受 `workspaceId` 与 `cwd`(互斥) | 首问回退(baseline)时新建会话 | `typert.host.js:1535`(两字段 + 描述)、`:230`(cwd) | 存在 |
| H7 | `archiveSession(sessionId, options?)` 字符串签名 | 回退后归档父会话 | `dsh-client-ui-workspace/lib/client.js:1542`;官方调用点 `:184` | 存在 |

补充:客户端 `ctx.sessions.fork()` 走 Remote 代理,请求字段以宿主 jsonSchema 为准(§H5),
官方 `navigation.forkSession()`(`ui-workspace/lib/client.js:1492-1499`)只是包了一层
`increaseTitle: true`;本插件不传该字段,因此不受影响。

### Client 半区

| # | 契约点 | 插件用途 | rc.5 证据 | 判定 |
|---|---|---|---|---|
| C1 | `conversation.chat.node` 渲染时把节点作为 `node` 传给 slot | 自定义动作行的宿主位置 | `ui-chat/lib/client.js:3797`(routedOwner)、`:3815`(renderSlot) | 存在 |
| C2 | 用户消息节点 `kind:"user"`,视图节点 `anchorSeq = event.seq`、`data.seq = event.seq` | 由动作节点反查真实提问 | `ui-chat/lib/client.js:9909`(kind:"user" + seq)、`:7718-7732`(chatNode 组装 anchorSeq/data) | 存在 |
| C3 | `surfaceOp === "append"` 才生成新 surface 事件 | 过滤 replacement 副本,避免重复动作行 | `ui-chat/lib/client.js:9495`(isSurfaceEvent)、`:9508`(isAppendSurfaceEvent)、`:9881`(input-message 定义用它) | 存在 |
| C4 | `conversation.input.left` slot | 6 个输入框左侧控件 | `ui-conversation/lib/client.js:19270`(renderSlot) | 存在 |
| C5 | Definition 必须 `target` 与 `buildViewNode` 同生共死 | 自定义事件 → 动作行 | `ui-conversation/lib/client.js:3438`(assertDefinitionTarget) | 存在(本插件两者都声明) |
| C6 | service 名 `uiConversation` | `ctx.uiConversation.events.register` | `ui-conversation/lib/client.js:4041` | 存在 |
| C7 | `archiveSession(sessionId, options={})`;`uiWorkspace.openSession(target)` | 归档父会话、打开子会话 | `ui-workspace/lib/client.js:1542`、`:1471` | 存在 |
| C8 | `provide({hooks:["chat"]})` / `hooks:["session"]` | `useChat` 标准 hook props | `ui-chat/lib/client.js:13141`、`ui-session/lib/client.js:756` | 存在 |
| C9 | 主题 CSS 变量 `--dsw-alias-bg-layer-1`、`--dsw-alias-interactive-bg-hover` | 弹层/按钮配色 | `ui-theme/lib/client.js:1540`(bg-layer-1)等 | 存在 |
| C10 | `dsh.client.inject/external/immediately` 解析规则(immediately 必须 boolean) | 插件清单(`platform:"web"`, `immediately:true`) | `dsh-client-modules/lib/client.js:66-73` | 存在 |

### 语义复核(容易被忽略的两点)

- **fork 的切点是闭区间**:rc.5 文档串写的是 "atSeq is the inclusive cut" /
  "Exact inclusive source event seq"。本插件客户端把「上一轮 `turn/end.seq`」作为边界传下去,
  子会话因此保留到上一轮结束、丢掉被回退的那一问——语义与 rc.2 一致。
- **省略 atSeq 的默认值变了?** rc.5 新增 `latestCompletedPrefixBoundary()`(`:870-871`)处理
  「不传 atSeq」的情形;本插件总是显式传,行为不受影响。

## 3. rc.5 上跑过的门禁

```
$ node --check index.js && node --check client.js        # PASS
$ node scripts/test-host.mjs --strict                    # 19/19(0 XFAIL)
$ node scripts/check-client-static.mjs --strict          # PASS(FAIL=0 WARN=0)
$ node scripts/e2e-host.mjs                              # 14/14(boot 516ms,port 61478)
```

说明:`test-host` 与 `check-client-static` 用的是 mock/stub(不依赖宿主版本),真正证明
rc.5 行为的是 `e2e-host`:它在隔离 `DSH_HOME`/`HOME` 下用 rc.5 的 CLI 安装 tarball、
真机 `dsh web` 启动、断言 boot 200 / client bundle 进组合并可加载 / API 200/401/405/404。
客户端契约的存在性由 §2 的源码逐条复核覆盖,并由本目录新增的
`scripts/check-runtime-contract.mjs`(task-7)固化为可执行门禁。

## 4. 未验证 / 风险

| 级别 | 项 | 说明 |
|---|---|---|
| 中 | 真实桌面 UI 交互仍未点按 | 同 `docs/final-verify.md` L1:不重启用户正在用的 DSH,无法点按;桌面 fetch bridge 转发 `/dsh-rewind/api/*` 仍未实测 |
| 中 | 同步事件读取族 deprecated | 见 §0.1;升级宿主前先跑 `scripts/check-runtime-contract.mjs`(H1 变红即需迁移) |
| 低 | rc.5 新增 `dsh-workspace-changes` | 不替代本插件;可作未来增强(§0.2) |
| 低 | fork/新建会话的官方入口语义 | 官方 `forkSession` 不传 atSeq(取最近完成轮前缀);若某天宿主收紧为「不允许多带 atSeq」需重新复核(当前 jsonSchema 明确允许) |
