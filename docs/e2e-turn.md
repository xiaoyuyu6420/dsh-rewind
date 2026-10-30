# 真机闭环：真实对话轮次 → 检查点落盘 → HTTP restore 还原文件

- 脚本：`scripts/e2e-turn.mjs`（零依赖，`node scripts/e2e-turn.mjs`）
- 宿主：DSH **0.2.1-rc.5**（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh --version`）
- 目的：补上 `docs/final-verify.md` 的 L1/L6 缺口——此前所有 checkpoint/restore 证据都来自 mock-ctx 或纯 HTTP 层，
  **从未在真实对话轮次上跑过**。
- 结论：**A1–A5 全部通过，22 项断言，连续 4 次运行稳定（每次 7–9 秒）**。
  真实宿主在真实 `turn/end` 上落出检查点，插件的 HTTP API 把工作区文件真的还原了。

---

## 1. 关键发现：轮次必须跑在 web profile，不能跑 headless

任务书建议用 `dsh --profile headless --session-id` 驱动两轮。**探针（≤15 分钟）结论：headless 能连本地假端点，但装不上本插件。**

### 1.1 headless 确实能到达本地假端点（不是卡点）

- 端点覆盖：`DEEPSEEK_BASE_URL=http://127.0.0.1:<port>`，源码
  `llm-deepseek/lib/index.js:442`（`config.baseURL ?? environment?.get(BASE_URL_ENV)?.value ?? 公网默认`），
  `:349-350`（`BASE_URL_ENV = "DEEPSEEK_BASE_URL"`），
  `:443-444`（必须是 http(s) root，不带凭据/query/fragment），
  `:578-580`（请求路径 = `<base>/v1/messages`）。
- 凭据不是阻塞项：headless profile 关闭了托管凭据库，API-key 走启动环境 →
  `<cwd>/.env` → `$DSH_HOME/.env`（`dsh-headless/README.md`「Credentials」节）。
  探针用**假 key**（`DEEPSEEK_API_KEY=sk-fake-…`，从未读取真实 `~/.dsh/.credentials.yaml`）即可，
  假端点收到的是 `POST /v1/messages` + `x-api-key: <假 key>`，无需任何登录态。
- 探针实测：`dsh --profile headless --json "say hi"` → **exit 0，367ms**，
  假端点被调用 2 次（一次轮次 + 一次标题生成），stdout 出 `turn_end reason.kind=completed`。

### 1.2 但 headless 里插件不会被挂载（真正的卡点）

本插件 Host 半区声明 `inject = ["webServer", "sessions", "connection"]`（`index.js:14`）。
headless profile 的合成树里**没有** `webserver` / `connection` 这两个服务：

```
$ DSH_HOME=<isolated> HOME=<isolated> dsh --profile headless --dump-config | grep -cE "id: webserver|id: connection"
0
$ DSH_HOME=<isolated> HOME=<isolated> dsh --profile web      --dump-config | grep -cE "id: webserver|id: connection"
2
```

对应源码：`dsh-web-app/cordis.patch.yml:180-181`（`webserver` → `@deepseek-ai/dsh-host-webserver`）、
`:235-236`（`connection` → `@deepseek-ai/dsh-client-connection`）；`dsh-headless/cordis.patch.yml` 只有
system-prompt / tools / headless-startup / headless-runner / hmr / credentials 等行，无 HTTP 相关行。
Cordis 的 `inject` 不满足时插件不会 `apply`，因此 headless 跑出来的检查点一条也不会有
（这条不是插件缺陷：插件的 restore 能力本来就依赖 HTTP API 与 webServer）。

### 1.3 采用的替代路径（更接近真实使用）

在同一隔离 home 里起 **`dsh web`**，用浏览器客户端**同一条 Typert RPC 通道**驱动真实轮次：

```
POST /api/<endpoint>          # 信封见 dsh-client-connection RPC schema
{"type":"client-request","rpcId":"<uuid>","method":"<endpoint>","payload":{"args":{…}}}
→ {"type":"server-response","rpcId":"…","result":{"ok":true,"value":…}}
```

用到的端点（`dsh-api-session-controller/lib/typert.host.js` 内有对应 descriptor）：

| 端点 | 用途 | 关键参数 |
|---|---|---|
| `session/create` | 建真实会话 | `request.cwd`、`request.sessionId`（`:1523`） |
| `session/prompt` | 提交一问，触发真实轮次 | `request.requestId/sessionId/mode:"queue"/content:[{type:"text",text}]`（`:1783`） |
| `session/list` | 取该会话行（含 `projections.asOfSeq` 游标）（`:1636`） |
| `session/page` | 读宿主自己的会话日志（交叉校验 `turn/end` seq）（`:1717`） |

> 为什么这不是"绕过真实链路"：浏览器里点发送按钮走的就是同一条通道（`dsh-client-connection` 的 `/api`
> Fetch bridge → Typert Gateway → `sessionController`）。区别只是「谁发起」——
> 桌面 GUI 的 fetch bridge 仍未实测（`final-verify.md` L1，仍列为未覆盖，见 §6）。

---

## 2. 脚本做了什么

```
隔离 DSH_HOME/HOME(mkdtemp) + 隔离工作区(mkdtemp)
  → 本地假模型端点(http, /v1/messages, SSE 纯文本, 无 tool_use)
  → pnpm pack → dsh plugin --profile web add <tarball>      # e2e-host.mjs 同款模式
  → DEEPSEEK_BASE_URL=<fake> dsh web --no-open --port <free>
  → 从启动日志抓 ?token= → 换 HttpOnly cookie
  → RPC session/create(cwd=工作区)
  → 轮 1: session/prompt → 轮内改 A.txt → 等 turn-1 检查点
  → 改工作区(A=round1, 新建 B) → 轮 2: session/prompt → 等 turn-2 检查点
  → 改工作区(A=dirty, 新建 C)
  → 插件 API: checkpoints / restore(dryRun) / restore(atSeq=turn1.endSeq) / restore(baseline)
  → 断言 A1–A5
```

几个刻意设计（都为了让断言有区分度、不产生假阳性）：

| 设计 | 原因 |
|---|---|
| 假端点只回文本、绝不发 `tool_use` | 本轮不验证工具调用；避免把"agent 自己改文件"混进"脚本改文件"的证据链 |
| **轮内改动**：假端点打到第一条请求后，先等 `baseline.json` 落盘，再由脚本写 `A.txt = v1-during-turn1` | 让 baseline（`v0-initial`）与 turn-1（`v1-during-turn1`）内容不同 → A3/A4 才能证明"确实分别来自两个不同快照"，而不是同一个文件被写两次 |
| 等待条件用"插件 API 里出现 turn N 检查点" | 检查点本身就只在真实 `turn/end` 落盘，比轮询日志更直接；同时天然覆盖 A2 |
| `restore` 先 `dryRun:true` | 顺带断言 dryRun 不改工作区（客户端点"预演"时依赖此语义） |
| 会话 `--session-id` 由脚本生成 | 不写真实 `~/.dsh`；工作区、home、端口全部隔离 |

---

## 3. 断言 A1–A5（实测）

`node scripts/e2e-turn.mjs`（最近一次：22/22 通过，port 63461，7.4s，exit 0）

| 断言 | 内容 | 实测 |
|---|---|---|
| **A1** | 隔离 home 内 `storages/dsh-rewind/<会话>/` 出现 `baseline.json`、`turn-1.json`、`turn-2.json` | ✅ |
| **A1** | `blobs/` 为 sha256 内容寻址，且含 baseline 时 `A.txt` 的内容 blob | ✅ 5 个 blob，全部 64 位 hex，含 `bff4f353…`（=`v0-initial` 的 sha256） |
| **A2** | 同一 home 的 `POST /dsh-rewind/api/checkpoints` → `tracking:true`，列出 2 个检查点（turn 1/2，endSeq 递增） | ✅ `turn:1,endSeq:18` / `turn:2,endSeq:29` |
| **A2** | turn-1 检查点带 `endSeq`（restore 的 atSeq 来源） | ✅ 18 |
| **A3** | `restore(atSeq=18, dryRun:true)` → `mode:"turn"`、`boundary.turn=1`、**工作区未变**（A 仍 dirty、B 仍存在） | ✅ |
| **A3** | `restore(atSeq=18)` → `A.txt` 回到 `v1-during-turn1` | ✅ `restored:["A.txt"]` |
| **A3** | 回退点之后新建的 `B.txt`/`C.txt` 被删除，返回体与事实一致 | ✅ `deleted:["B.txt","C.txt"]`，磁盘上确实消失 |
| **A3** | `restored` 列表含 `A.txt`；`keep.txt` 未被误动 | ✅ |
| **A4** | `restore(baseline:true)` → `mode:"baseline"`，`A.txt` 回到 `v0-initial`（与 turn-1 的内容不同，证明来自 baseline 而非 turn-1） | ✅ |
| **A4** | baseline 还原后 B/C 仍然不存在 | ✅ |
| **A5** | 宿主会话日志里的 `turn/end` seq 与检查点 `endSeq` **完全一致**（`session/list` 取 `projections.asOfSeq` 游标 → `session/page` 读日志） | ✅ 日志 `[18, 29]` = 检查点 `[18, 29]` |
| **A5** | 启动日志无 slot crash / 组合失败；无 `dsh-rewind` 报错行 | ✅（boot.log 仅 1 行 token 提示） |
| **A5** | 假端点确实被真实宿主调用（≥2 次 `/v1/messages`） | ✅ 3 次（2 轮 + 1 次标题） |
| **A5** | `dsh web` 进程全程存活 | ✅ |

稳定性：连续 4 次运行全部 exit 0（20 秒内跑完 2 次；单次 7–9 秒），端口/会话 id 每次不同。

---

## 4. 证据样本（来自 `--keep` 保留的隔离 home）

```jsonc
// storages/dsh-rewind/<sessionId>/baseline.json
{"kind":"baseline","turn":0,"endSeq":-1,"at":1793329078678,
 "files":{"A.txt":{"sha":"bff4f353…","size":11,…},"keep.txt":{"sha":"60d8b5ad…","size":8,…}}}

// turn-1.json —— 注意 A.txt 的 sha 变了（轮内改动被抓到），keep.txt 不变
{"kind":"turn","turn":1,"endSeq":18,"at":1793329078741,
 "files":{"A.txt":{"sha":"3a5f574d…","size":16,…},"keep.txt":{"sha":"60d8b5ad…","size":8,…}}}

// turn-2.json —— A=round1（脚本在轮 1 后改的），并新增 B.txt
{"kind":"turn","turn":2,"endSeq":29,…}
```

```
blobs/60d8b5ad…(keep.txt) 3a5f574d…(A@turn1) 650986d3…(A@round1) bff4f353…(A@baseline) 12412406…(B)
$ cat blobs/650986d3…  →  r1-after-turn1
```

restore 响应（真实 HTTP 200）：

```jsonc
{"ok":true,"value":{"mode":"turn","boundary":{"turn":1,"endSeq":18},
  "restored":["A.txt"],"deleted":["B.txt","C.txt"],"skipped":[],"dryRun":false}}
{"ok":true,"value":{"mode":"baseline","restored":["A.txt"],"deleted":[],"skipped":[],"dryRun":false}}
```

---

## 5. 这次真机跑通，顺带证明了什么（rc.5 上）

| 插件侧改动/契约 | 真实环境证明 |
|---|---|
| `liveEventsOf()` 走 `snapshotEvents()`（P0-1） | `restore(atSeq=18)` 在**真实 live Session** 上命中 turn-1 边界而不是退化 baseline；若 `snapshotEvents` 拿不到事件，整条 A3 会退化成 `mode:"baseline"` 并且 B/C 的删除集合会不同 |
| 检查点在真实 `turn/end` 落盘 | 日志 `turn/end` seq 18/29 与 `turn-1.json`/`turn-2.json` 的 `endSeq` 一一相等 |
| `webServer.register({kind:"prefix"})` 路由（H4） | 插件 API 真实响应 200（`/dsh-rewind/api/checkpoints|restore`） |
| `connection.requestRejection` fail-closed（H3） | 带 cookie 通过；无 cookie 401 已由 `e2e-host.mjs` 覆盖 |
| `resolveTarget()` 边界语义 | `atSeq = turn-1 的 turn/end.seq` → 命中 turn 1；`baseline:true` → 回到会话首见状态 |
| 真实工作区 walk + blob CAS | 5 个 blob 内容寻址、内容与历史状态逐字节一致；`keep.txt` 未被误改 |

---

## 6. 未覆盖 / 风险（诚实边界）

| 级别 | 项 | 说明 |
|---|---|---|
| 中 | **桌面 GUI 的 fetch bridge 仍未实测** | 本脚本走 `dsh web` 的 HTTP RPC（与浏览器同一条通道），但用户在桌面 App 里点"回退"按钮时，请求经 desktop 的 `/api` 转发；该转发仍未真机点按（同 `final-verify.md` L1） |
| 中 | **冷会话路径未覆盖** | restore 全程会话都是 live（走 `snapshotEvents`）。`stat/open/read` 冷读路径（P1-1）仍只有 mock + 源码证据 |
| 中 | **fork/归档未覆盖** | 客户端回退的完整链路是 fork → restore → archive（H5/H7），本脚本只测 restore 半段 |
| 低 | 假模型不产生工具调用 | 真实模型会改文件；本脚本用"脚本改文件"替代，覆盖了 walk/blob/restore，但没覆盖"agent 正在写文件时快照"的竞态（P2-4） |
| 低 | 依赖本机 dsh 安装与 pnpm | 缺任一项即 SKIP（`--fail-on-skip` 可让 CI 把 SKIP 当失败） |
| 低 | 未验证 1–5MB 双 cap 语义、符号链接、文件 mode/mtime | 这些是 `docs/host-fixes.md` §4 的既有 P2 |

---

## 7. 运行方式

```sh
node scripts/e2e-turn.mjs                 # 全自动；环境缺依赖 → SKIP 并 exit 0
node scripts/e2e-turn.mjs --fail-on-skip  # CI：SKIP 视为失败（exit 1）
node scripts/e2e-turn.mjs --keep          # 保留隔离 DSH_HOME / 工作区 / boot.log 供排查
node scripts/e2e-turn.mjs --port 45871    # 指定端口
node scripts/e2e-turn.mjs --verbose       # 打印 RPC 应答与假模型请求
```

- 退出码：`0` = A1–A5 全绿（或环境性 SKIP）；`1` = 真实断言失败 / 致命错误。
- SKIP 条件（明确打印原因，不静默）：找不到 `dsh` CLI、`pnpm` 缺失、`pnpm pack` 失败、
  `dsh plugin add` 因网络/registry 失败。
- SKIP 语义已实测：把 `pnpm` 从 `PATH` 移走后 `node scripts/e2e-turn.mjs` → 打印
  `SKIP（环境性）：PATH 里找不到 pnpm` 且 **exit 0**；加 `--fail-on-skip` 同场景 → **exit 1**。
- 隔离性：只写 `mkdtemp` 出来的 `DSH_HOME/HOME/工作区`，结束即删（`--keep` 除外）；
  不碰真实 `~/.dsh`、不装 desktop profile、不重启用户正在用的 DSH。
- 凭据：全程只用假 key；从未读取、复制或打印真实凭据内容。

---

## 8. 与既有门禁的关系（rc.5 上全绿）

```
$ node --check scripts/e2e-turn.mjs                      # PASS
$ node scripts/test-host.mjs --strict                    # 19/19（mock 层）
$ node scripts/e2e-host.mjs                              # 14/14（boot / client bundle / API 鉴权）
$ node scripts/e2e-turn.mjs                              # 22/22（真实轮次 → 检查点 → restore）★本文
```

三层互补：`test-host` 覆盖契约分支（mock），`e2e-host` 覆盖"宿主能装上并跑起来"，
`e2e-turn` 覆盖"真实轮次上功能真的生效"。剩下唯一没被真机覆盖的是**桌面 GUI 点按**
（`final-verify.md` L1）与**冷会话/fork**路径（见 §6）。
