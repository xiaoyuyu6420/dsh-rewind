# Host 半区修复记录：index.js 适配 DSH 0.2.1-rc.2

- 依据：`docs/audit-host.md`（P0×1 / P1×3 / P2×14）
- 改动文件：仅 `index.js`（`git diff --stat index.js`：约 +148 / −22，693 行）
- 未改：`client.js`、`package.json`、`cordis.patch.yml`、`dsh-backup`、`~/.dsh`、真实 desktop profile
- 自检：
  - `node --check index.js` → 通过
  - `node scripts/test-host.mjs --strict` → **18 通过 / 0 XFAIL / 0 失败**
  - 真实形状复现脚本（见 §3）全部符合预期
- 未引入任何运行时依赖（仍只用 Node 内置模块）

---

## 1. 修复总览

| # | 严重度 | 缺陷 | 修复位置 | 行为变化 |
|---|---|---|---|---|
| P0-1 | P0 | `live.events` 在 0.2.1 不存在 → restore(atSeq) 恒退化为 baseline | `index.js:595-633`（`liveEventsOf`/`eventsOf`） | 活会话改用 `snapshotEvents()` 全量事件；`resolveTarget` 的 turn/end 查找恢复正常；非首轮回退命中该 turn 检查点 |
| P1-1 | P1 | `sessionPersistence.inspect(id)` 不存在 → 冷会话不跟踪、不可还原 | `index.js:455-480`（`workspaceRootOf`）、`606-633`（`eventsOf`） | 优先 `stat(id).header.cwd` + `open(id,"read")→read()→close()`；保留旧 `inspect()` 兜底；失败 fail-safe 返回 undefined/[] |
| P1-2 | P1 | git auto-commit 从子目录 `add -A` 会全仓暂存、可能结束用户 merge | `index.js:369-382`（`runGit` env）、`523-563`（`autoCommitFor`） | 仅当 workspace == 仓库工作树根时提交；`add/status/commit` 全部带 `-- .` pathspec；merge/rebase/cherry-pick/revert/bisect 时跳过并 warn；剥离继承的 `GIT_DIR` 等环境变量 |
| P1-3 | P1 | workspace 为 `$DSH_HOME` 祖先时会把 `~/.dsh/**` 纳入快照并可回写 | `index.js:482-498`（`storeFor`）、`84-92`（helper）、`117-136`（walk 排除）、`310-316`（restore `within`）、`17`（`.dsh` 兜底忽略） | 祖先/内含 DSH home 的工作区直接不跟踪；walk 与 restore 双重排除 `dshHome`；`.dsh` 加入默认忽略名单 |
| P2-6 | P2 | `sessionId` 未校验就拼存储路径 | `index.js:482-486`（`isSafeStorageSegment` `:89-92`） | 含 `/`、`\`、NUL 或为 `.`/`..` 的 id 直接不跟踪（纵深防御） |
| P2-15 | P2 | `api[method]` 走原型链（`constructor`/`toString` 返回 200） | `index.js:677` | 仅接受 `api` 自有方法，其余 404 |
| P2-16 | P2 | `requestRejection` 未来若返回非 number 真值，`res.statusCode = {}` 会抛 RangeError | `index.js:667-672` | 非 number 拒绝一律 503，保持 fail-closed |
| P2-9 | P2 | `stores/chains/gitChains` 永不清理 | `index.js:578-593`（`session/disposed` 清理） | 会话销毁时删除三张表与去重告警键，长进程内存有界 |
| P2-5b | P2 | 子目录工作区每轮都 warn（噪声） | `index.js:435-441, 540, 549`（`warnOnce`） | 同一会话同一原因只 warn 一次 |

> 行号为本文件修复后的 `index.js` 行号；`git diff -U0` 的 hunk 与之一一对应。

---

## 2. 逐项说明（依据 + 行为变化）

### 2.1 P0-1：restore 目标解析（`index.js:595-633`）

**依据**
- `@deepseek-ai/dsh-session` 的 `Session` 类只有 `log/header/surface/...` 与 `snapshotEvents()/ownEvents()/eventAt()`、`seq`，**没有 `.events`**（`app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:1325-1485`，`snapshotEvents`:1453、`ownEvents`:1466）。
- `session/event` 回调参数为 `(session, event)`、`event.seq` 为整数、`turn/end` 载荷含 `{turn, reason}`（`dsh-session/lib/index.js:1580-1594`；`dsh-agent-loop/lib/index.js:1030-1033`）。
- 客户端 `atSeq` = 上一轮 `turn/end` 的 `event.seq`（`client.js:354`；`dsh-client-ui-conversation/lib/client.js:2188,2306`）。

**改动**
```js
function liveEventsOf(live) {
  try {
    if (typeof live?.snapshotEvents === "function") return live.snapshotEvents(); // 全量含 fork inherited 前缀
    if (typeof live?.ownEvents === "function") return live.ownEvents();           // 最后兜底（会丢 inherited）
  } catch {}
  return Array.isArray(live?.events) ? live.events : [];                          // 兼容旧宿主
}
```
`eventsOf` 活会话分支改为 `liveEventsOf(live)`；冷会话分支见 2.2。`resolveTarget()` 的逻辑保持原样（仍取「第一个 `seq >= atSeq` 的 `turn/end`」），只是这次真能拿到事件。

**行为变化**：非首轮回退从「还原 baseline、删除回退点后所有新文件」变为「命中该轮 `turn/end` 的 checkpoint」。修复前后对比（脚本 `restore atSeq=9`，turn2 结束边界）：

```
修复前: mode=baseline, restored=[a.txt], deleted=[b.txt,c.txt,d.txt], a.txt=hello
修复后: mode=turn, boundary={turn:2,endSeq:9}, restored=[a.txt], deleted=[d.txt], a.txt=turn2
```

**已知限制**：`snapshotEvents()` 被官方标记 deprecated（不禁止外部调用，但新生产代码不推荐）；0.2.1 没有替代的整段读取 API，外部插件只能用。升级时优先复核此调用，若移除则自动退到 `ownEvents()`/`live.events`，最坏情况回到「只跟踪、restore 退化为 baseline」——不会崩溃。

### 2.2 P1-1：冷会话 cwd/events（`index.js:455-480, 606-633`）

**依据**
- 0.2.1 `ctx.sessionPersistence` 只有 `create/open/stat/list/flush`，**没有 inspect**（`dsh-session-persistence/README.md:37-48`；`lib/index.js:262-267`；README:13 的 "inspect" 是动词）。
- `stat(id)` → `{ header, revision, sizeBytes? }` 或 `undefined`，cwd 在 `snapshot.header.cwd`（`dsh-session-persistence-jsonl/lib/index.js:2571-2600`）。
- `open(id,'read')` → `SessionHandle`；`handle.read(offset=0, length=Number.MAX_SAFE_INTEGER)` → `{ eventState, events }`（**默认一次读全量，无需分页**）；`handle.close()` 幂等（README.md:40-54；JSONL 实现 `:64-66, :2489`）。返回结构已按源码确认，但仍建议 task-5/6 e2e 在真机宿主上复核一次（见 §5 遗留风险）。

**改动**
- `workspaceRootOf`：live `header.cwd` → `stat(id)?.header?.cwd` →（兼容）`inspect(id)?.meta?.cwd` → `undefined`。
- `eventsOf`：live → `open(id,"read")` + `read()` + `finally close()`（失败关闭句柄、不抛）→（兼容）`inspect(id).events` → `[]`。

**行为变化**：归档/重启后的会话 `checkpoints` 返回 `tracking:true`，restore 可命中磁盘上的 `turn-N.json`；所有失败路径 fail-safe（无 cwd 不跟踪、无 events 返回 `[]`），不会向 HTTP 调用方抛错。

**冷会话语义（与 Lead 确认）**：冷会话若从未被本插件跟踪过（磁盘上没有 `baseline.json`/`turn-N.json`），则 `restore` 返回 `mode:"none"` 是**正确**行为（没有文件快照可还原）；harness-builder 已把 BUG-2 用例改为"阶段一 live 建快照、阶段二冷会话还原"，当前严格模式全绿。

### 2.3 P1-2：git auto-commit 误伤（`index.js:369-382, 523-563`）

**依据**
- Git 2.0 起无 pathspec 的 `git add -A` 等价于 `git add -A :/`，作用整个工作树。实测（`/tmp/gitlab`）：在仓库子目录执行后，暂存区出现子目录外的 `top.txt`。
- `git commit -m` 在 merge 进行中会**结束 merge**（生成 merge commit）。
- 参考实现 `dsh-backup` 不自动提交用户仓库；本插件的 auto-commit 是设计内的「额外保险」，默认开（README 已写明）。

**改动**
1. 工作树根判定：`git rev-parse --show-prefix` 输出为空才提交；否则跳过并 `warnOnce`。
   - 选它而不是 `--show-toplevel` 的原因：toplevel 返回物理路径（macOS `/var` → `/private/var`），与 symlink 形式的工作区路径直接字符串比较会误判「不是仓库根」而静默跳过；`--show-prefix` 在 symlink 路径下仍为空，天然不受影响。实测：`cd /tmp/realsym/link && git rev-parse --show-prefix` → `""`，`--show-toplevel` → `/private/tmp/realsym/repo`。
   - 这同时解决了「从子目录全仓暂存」问题（子目录工作区直接不提交）。
2. `git status --porcelain -- .`、`git add -A -- .`、`git commit -m <msg> -- .` 全部带 pathspec：只碰工作区内的路径，不会把用户在工作区外已暂存的内容写进 checkpoint commit（实测：`user.txt` 保持 staged，`top.txt` 保持未暂存）。
3. 进行中操作保护：读取 `git rev-parse --git-dir`，若存在 `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` / `BISECT_LOG` / `rebase-merge/` / `rebase-apply/` 任一 → 跳过并 warn（同一会话同一原因只报一次），绝不代用户 conclude。
4. `runGit` 的 env 剥离 `GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_COMMON_DIR`，避免宿主进程环境影响目标仓库。
5. 实测三场景：
   - 子目录 workspace：`log` 仍 1 条，`top.txt` 与 `sub/s.txt` 均保持未提交，warn 一条；
   - 仓库根 workspace：新增 `dsh: checkpoint before turn 1`，工作区干净；
   - merge 冲突中：跳过，`MERGE_HEAD` 仍在（merge 未被结束）；
   - symlink workspace 指向仓库根：正常提交。

**遗留（不修，需产品/文档决策）**
- 默认 `gitAutoCommit: true` 不变；用户可在 `$DSH_HOME/storages/dsh-rewind/config.json` 写 `{"gitAutoCommit": false}` 关闭。
- 工作区 = 仓库根时，用户在工作区内**已暂存**的内容仍会进入本次 checkpoint commit（无法与 agent 改动区分）；未跟踪且未被 `.gitignore` 的敏感文件也会入历史。这是该设计的固有风险，README 已把 auto-commit 描述为"额外保险"，建议后续在 README 明确提示或改默认值（超出本次允许改动范围）。
- checkpoint commit 失败时，`git add -A -- .` 可能把工作区内文件留在 index（内容不变，仅暂存状态变化）；已用 pathspec 把影响面限制在工作区内。

### 2.4 P1-3：DSH home 泄漏（`index.js:17, 84-92, 117-136, 310-316, 482-498`）

**依据**
- `$DSH_HOME/storages` 是 storage-json 的 root（`dsh-base/cordis.patch.yml:186`）；`$DSH_HOME/.credentials.yaml` 保存浏览器 session 签名密钥（`dsh-client-connection/README.md:44`）；会话日志也在 `$DSH_HOME` 下。
- 旧实现只判断 `root` 是否在 DSH home 内；`root` 是 home（`~`）或 `/` 这类 DSH home 的**祖先**时检查通过，`.dsh` 又不在忽略名单里 → 凭据与会话日志会被 hash 进 `blobs/`，restore 时可能被覆盖/删除。

**改动（四层）**
1. `storeFor`：`isSameOrInside(root, home) || isSameOrInside(home, root)` → 直接不跟踪（含"工作区是 home 祖先"）。
2. `CheckpointStore` 新增 `excludeRoots`（`storeFor` 传 `[dshHome()]`）；`walkWorkspace` 跳过 `excludeRoots` 下的绝对路径；baseline/turn/restore 的当前态遍历都用同一套 options。
3. `restore` 的 `within()` 额外拒绝 `excludeRoots` 下路径（即使旧版已写出的 checkpoint 里混入了 `~/.dsh/...` 也不会回写）。
4. `DEFAULT_IGNORE_NAMES` 增加 `".dsh"` 作为第二道防线（自定义 DSH_HOME 且目录名不是 `.dsh` 时由第 1/2 层兜住）。

**行为变化**：workspace=home（或 `/`）时 `checkpoints` 返回 `tracking:false`，不创建 store；已有正常 workspace 的快照/还原行为不变（实测：`workspace files: home,project.txt`，store 目录未创建）。

### 2.5 小修（P2，均 <20 行）

- `isSafeStorageSegment`（`:89-92`）+ `storeFor`（`:486`）：sessionId 含路径分隔符/NUL 或为 `.`/`..` 时不跟踪，杜绝 `storages/<id>` 路径逃逸（当前 cwd 解析链已挡住实际利用，属纵深防御）。
- `Object.hasOwn(api, method)`（`:677`）：`POST /dsh-rewind/api/constructor` 等不再误命中 `Object.prototype` 方法。
- rejection 形状防御（`:667-672`）：0.2.1 返回 `401/403` number，按 number 使用；未来若返回对象等非 number 真值 → 503（fail-closed），不再出现 `res.statusCode = {}` 抛 RangeError。
- `session/disposed` 清理（`:578-593`）：删除 `stores/chains/gitChains/warnedOnce` 中的会话条目，长进程不再按会话数单调增长。
- `warnOnce`（`:435-441`）：子目录 git 跳过、merge 跳过等只报一次，避免每轮刷日志。
- `loadConfig`（`:355-356`）：`ignoreNames/ignorePatterns` 过滤非字符串元素，坏配置不再让每次 checkpoint 静默失败。

---

## 3. 验证证据

### 3.1 仓库内测试
```
$ node --check index.js
（无输出，退出码 0）

$ node scripts/test-host.mjs --strict
[test-host] 用例数=18
...（全部 ✅）
✅ 真实 0.2.1 live Session（无 .events，只有 snapshotEvents）: restore(atSeq) 应还原上一轮 [BUG-1 已消失]
✅ 真实 0.2.1 sessionPersistence（无 inspect，只有 stat/open）: 冷会话可跟踪与还原 [BUG-2 已消失]
[test-host] 结果：18 通过 / 0 已知缺陷复现(XFAIL) / 0 失败（共 18）
```

### 3.2 独立真实形状复现（/tmp，不依赖仓库测试）
- `/tmp/mock-rewind-smoke2.mjs`：两轮会话，回退 `atSeq=9` → `mode:"turn"`、`a.txt=turn2`、`b/c.txt` 保留、`d.txt` 删除（修复前为 `mode:"baseline"` + 三文件误删）。
- `/tmp/mock-cold.mjs`：阶段 live 建快照 → 阶段冷会话（只有 `stat/open`）→ `tracking:true`、`restore atSeq=1` → `mode:"turn"`、`a.txt=A2`、`handle.closed=1`（句柄已关闭）。
- `/tmp/mock-git2.mjs`：子目录跳过 / 根目录提交 / merge 跳过三场景全部符合预期（见 2.3）。
- `/tmp/mock-git-symlink.mjs`：symlink 工作区指向仓库根 → 正常提交（验证 `--show-prefix` 方案）。
- `/tmp/mock-ancestor.mjs`：workspace 是 DSH home 祖先 → 不建 store、`tracking:false`。

---

## 4. P2 未修清单（留档）

| # | 位置 | 原因 |
|---|---|---|
| P2-1 | `storageRoot()` 放在 storage-json 的 root 下 | 0.2.1 没有文档化的插件私有数据目录；改用 `ctx.settings`/storage 域属于设计变更，超出最小修复 |
| P2-2 | `resolveTarget` 按 turn 号取 checkpoint，fork 子会话 inherited/own turn 号可能撞号 | 正常客户端路径（atSeq=turn/end seq）不触发；改需引入 `endSeq` 二次校验，收益低、影响面大 |
| P2-3 | baseline = 插件首次见到会话的状态 | 语义设计，需要产品决策（是否会话中途启用插件） |
| P2-4 | checkpoint 在事件回调里异步 walk，非事件 seq 时刻精确快照 | 需阻塞式/序号对齐机制，属架构变更 |
| P2-5 | 未 realpath 防符号链接换目录 | 极端场景（快照后目录被替换为外链），且文本边界已挡住典型穿越 |
| P2-7 | 跨会话同 cwd 无锁 | 设计假设一个 workspace 一个会话；团队/子代理并发优化留待后续 |
| P2-10 | blob 预算不读磁盘、无 GC/保留策略 | 需要产品决定保留天数/容量，改动不止 20 行 |
| P2-11 | blob 读取不校验 sha | 需要全量 hash 校验或内容头，成本高 |
| P2-12 | `trackSizeCap(5MB) > blobSizeCap(1MB)`：1–5MB 文件有 sha 无内容 | 现有测试已锁定「no-content 如实 skipped」语义；改语义需同步测试与 UI 文案，属产品决策 |
| P2-13 | 不恢复文件 mode/mtime、不跟踪 symlink | 需要扩展 checkpoint schema（版本化），超出最小修复 |
| P2-14 | restore 无恢复前安全快照/撤销 | 新功能，非缺陷修复 |
| P2-17 | `.gitignore` 解析为近似实现（仅根文件、无嵌套/否定 re-include） | 文档层面已可说明；引入完整 gitignore 解析超出范围 |

---

## 5. 遗留风险 / 待真机验证

1. **冷会话 events 读取**：`open(id,"read")` / `read()` 返回结构已按 JSONL 实现与 README 确认（见 2.2），但尚未在真实桌面宿主上跑过冷会话 restore。失败时行为是 fail-safe（`[]`、不抛、`tracking` 照旧），不会误删文件；建议 task-5/6 的 e2e 或真机手动步骤覆盖一次。
2. **`snapshotEvents()` 的 deprecated 状态**：0.2.1 可用；未来宿主若移除，代码会退到 `ownEvents()`/`live.events`，最坏退化为 baseline 还原（P0 回归但不崩溃），已留注释提示升级复核。
3. **`connection.requestRejection` 非 README 文档化契约**：存在且语义正确；未来改名会走 503 fail-closed，不会放行。替代的文档化通路是 `ctx.connection.fetch.register`（需要客户端改 URL，属 client 侧范围）。
4. **git 默认自动提交的产品风险**（见 2.3 遗留）：工作区内已暂存内容/未跟踪敏感文件仍可能入 commit；用 `{"gitAutoCommit": false}` 可关闭。本次未改默认值，避免与 README 冲突。
5. **restore 的破坏性语义不变**：快照后用户手工新建且未被忽略的文件会被删除；无 pre-restore 备份（P2-14）。
6. **未在真实 desktop profile 安装/启动验证**：本次修复依据官方 asar 源码 + 真实形状 mock + 仓库单测；真机 boot 冒烟由 task-5（`scripts/e2e-host.mjs`）与 task-6 验收覆盖。未触碰用户的 DSH 进程与 profile。
