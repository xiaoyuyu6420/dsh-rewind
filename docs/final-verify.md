# dsh-rewind 最终独立验收（task-6）

- 验收人：harness-builder（测试/验证，独立于 host/client 修复者）
- 时间：2026-10-18（Asia/Shanghai）
- 对象：`/Users/xiao/Desktop/dsh/dsh-rewind` 当前工作区（git HEAD `da034d7` + 未提交修复）
- 宿主：DeepSeek Harness **0.2.1-rc.2**（`/Applications/DeepSeek Harness.app/.../bin/dsh --version`）
- 工具链：Node v22.22.1、pnpm 12.9.1、git 2.54.0、macOS arm64
- 冻结指纹（验收时）：`index.js` sha256 `f381b947be82dbf97b31b196f74c2b370d4261c02e2271f059839489d6c127b5`、`client.js` sha256 `f436cee40ce362d28b797b2fcccb3b4482f10274b64c9f33e7854e141ff6cc36`（完整值见 §11 复跑命令）。
- 冻结声明：验收期间运行时源码 `index.js`（693 行）/`client.js`（885 行）未再变更（`node --check` + 门禁结果一致）；Lead 的 README/package.json/install.sh 元数据改动不属于验收对象，仅如实记录。

---

## 0. 结论先行

**GO（可以安装到 desktop profile）** —— 无 P0/P1 代码阻断项；两个原始 P0（Host restore 退化、Client 动作行不渲染）均已修复并有测试锁死；四道门禁全绿；发布物可打包、可安装、可在隔离 web profile 真机 boot 并完成 API/鉴权/客户端 bundle 断言。

附条件（不阻断安装）：本验收**没有**在真实 Electron 桌面运行时启动验证（受「不重启用户正在用的 DSH」约束），`/dsh-rewind/api/*` 的相对 `fetch` 是否被桌面 fetch bridge 转发**未实测**；若该路径不通，表现为「对话已回退，但工作区文件还原失败」的可见错误，不会崩溃（详见 §8 L1）。建议用户安装后按 §10 的手工冒烟清单走一遍。

---

## 1. 验收范围与方法

| 项 | 内容 |
|---|---|
| 代码复核 | `git diff`（5 个修改文件：README.md / README.en.md / index.js / client.js / package.json；10 个新增文件：docs×6、scripts×3、install.sh）、`docs/audit-host.md`、`docs/audit-client.md`、`docs/host-fixes.md`、`docs/client-fixes.md` |
| 门禁 | `node --check index.js client.js`；`node scripts/test-host.mjs --strict`（19 例）；`node scripts/check-client-static.mjs --strict`（含渲染降级冒烟）；`node scripts/e2e-host.mjs`（隔离 DSH_HOME/HOME + tarball 安装 + `dsh web` boot + token/cookie + HTTP 断言） |
| 语义验收 | 新增 task-6 专属用例：两轮边界 restore（第2轮边界还原 A 且 B 不存在；baseline 还原初始） |
| 卫生审查 | 调试残留 / 临时路径 / 私密信息 / 无关文件 / 真实 profile 与 dsh-backup 污染 |
| 发布物 | `pnpm pack` 内容清单、`package.json` 元数据、`install.sh` 静态检查 |

所有测试均在 `mkdtemp` 隔离的 `DSH_HOME`/`HOME` 与独立端口下运行；**未**触碰真实 `~/.dsh`、desktop profile、用户正在运行的 DSH 进程，也**未**修改 `dsh-backup`。用户桌面 DSH（PID 75241，127.0.0.1:62075）验收前后持续运行、未重启。真实 `~/.dsh/profiles/web/package.json`（mtime Oct 17）与 `~/.dsh/profiles/desktop/package.json`（mtime Oct 18 15:31，早于本会话）均未被本会话写入。

---

## 2. 门禁结果（全部 PASS）

| # | 门禁 | 命令 | 结果 |
|---|---|---|---|
| G1 | 语法 | `node --check index.js && node --check client.js` | **PASS**（退出码 0，无输出） |
| G2 | Host mock-ctx 单测 | `node scripts/test-host.mjs --strict` | **PASS**：`19 通过 / 0 XFAIL / 0 失败` |
| G3 | Client 静态守护 | `node scripts/check-client-static.mjs --strict` | **PASS**：`FAIL=0 WARN=0 INFO=5` |
| G4 | 真机 boot 冒烟 | `node scripts/e2e-host.mjs` | **PASS**：`14/14`，boot 5155ms，port 56982，tarball `local-dsh-rewind-0.1.1.tgz` |

> 说明：G2 在原 18 例基础上新增 1 条 task-6 语义验收用例（见 §4），因此计数为 19；README/`docs/test-report.md` 中“18/18”为修复完成时的历史计数，属文档小偏差（§8 L5）。

### 2.1 G2 关键输出（strict 模式，XFAIL 也计入失败；0 XFAIL 表示旧缺陷已消失）

```
✅ 真实 0.2.1 live Session（无 .events，只有 snapshotEvents）: restore(atSeq) 应还原上一轮 [BUG-1 已消失]
✅ 真实 0.2.1 sessionPersistence（无 inspect，只有 stat/open）: 冷会话可跟踪与还原 [BUG-2 已消失]
✅ 兼容: 旧 persistence.inspect() 契约的冷会话可跟踪与还原（修复不得回归）
✅ 验收: 两轮边界 restore 语义（第2轮边界还原 A 且 B 不存在；baseline 还原初始）
[test-host] 结果：19 通过 / 0 已知缺陷复现(XFAIL) / 0 失败（共 19）
```

覆盖：baseline/检查点落盘与 changed 统计、restore(atSeq)/dryRun/baseline/未知会话、`.gitignore` 忽略、大文件 skip 语义、API 401/403/503/405/404/400（含 1 MiB body 上限）、gitAutoCommit（提交/非 git 跳过/关闭/子目录与 merge 保护由单测与修复记录佐证）、并发 restore 与 turn/end、路径穿越安全、DSH_HOME 祖先/内含排除、enabled:false、subagent 不跟踪、旧 inspect 兼容。

### 2.2 G3 关键输出

```
服务访问：sessions×8, workspaces×2, uiWorkspace×1, locale×1, uiConversation×1, slots×12
plugin.inject：["slots","sessions","workspaces","uiWorkspace","locale","uiConversation"]
INFO inject 静态/VM 一致
INFO apply(ctx stub) 通过（registrations: slots=6 events=1）
INFO 渲染降级冒烟：6 个 slot 渲染回调 × 5 种快照/useChat 场景 + 1 个 Event Definition 均未抛异常
[check-client-static] PASS（FAIL=0 WARN=0 INFO=5，strict）
```

检查内容：`ctx.<service>` 访问（含 alias/解构/字面量下标）与 `plugin.inject` 比对；VM 以浏览器 `ModuleLoader` 方式加载 bundle、执行 `apply(ctx stub)`；并新增渲染降级冒烟（缺 `useChat`、空/`null`/抛异常快照、畸形 chat 快照、Event Definition 异常输入）。

### 2.3 G4 14 项断言

```
✅ dsh plugin add 成功
✅ tarball 安装到隔离 profile（index.js + bundle 声明）
✅ boot 后 Web shell 返回 200
✅ Web shell HTML 有内容
✅ index HTML 的启动预加载列表包含本插件 client bundle
✅ client bundle combo 可下载（200 且含本插件代码）
✅ client bundle 可在 ModuleLoader 沙箱里导出插件面（apply/inject）
✅ POST /dsh-rewind/api/checkpoints 返回 200 且 tracking:false（host 半区 apply() 真的跑了）
✅ GET /dsh-rewind/api/checkpoints 返回 405（路由已注册，不是 fallback 404）
✅ 无 cookie 调 API 返回 401（鉴权 fail-closed）
✅ 未知方法返回 404（API 前缀路由生效）
✅ 启动日志无 slot crash / client 组合失败
✅ 启动日志无 dsh-rewind 报错行
✅ dsh web 进程仍在运行（boot 后未退出）
[e2e-host] 结果: 14/14 通过（boot 5155ms，port 56982）
```

---

## 3. Host 修复复核（docs/audit-host.md P0×1 / P1×3）

| 缺陷 | 修复落点（当前 index.js） | 代码复核 | 测试证据 |
|---|---|---|---|
| **P0-1** `live.events` 不存在 → restore(atSeq) 恒退化 baseline | `liveEventsOf()` `:595`、`eventsOf()` `:606`：优先 `snapshotEvents()`（全量含 fork inherited），退 `ownEvents()`，再兼容旧 `.events` | ✅ 正确；`resolveTarget` 语义未改 | G2「真实 0.2.1 live Session」+ §4 两轮边界用例；修复前该用例 XFAIL（mode=baseline），现 PASS（mode=turn） |
| **P1-1** `sessionPersistence.inspect()` 不存在 → 冷会话不跟踪/不可还原 | `workspaceRootOf()` `:455`：`stat(id).header.cwd` → 兼容 `inspect().meta.cwd`；`eventsOf()`：`open(id,"read")` → `read()` → `finally close()` → 兼容 `inspect().events` | ✅ 正确；失败路径 fail-safe（`undefined`/`[]`，不抛） | G2「真实 0.2.1 sessionPersistence」+「旧 inspect 兼容」；冷会话 `tracking:true`、restore 命中 turn2 |
| **P1-2** git auto-commit 可能全仓暂存 / 结束用户 merge | `autoCommitFor()` `:523`：`rev-parse --show-prefix` 判仓库根（symlink 安全）、marker（MERGE_HEAD 等）跳过、`status/add/commit` 全带 `-- .`、`runGit` 剥离 `GIT_DIR` 等环境变量、`warnOnce` | ✅ 合理；子目录工作区不提交，避免 Git 2.0 `add -A` 全树语义 | G2 gitAutoCommit 两例通过；**本验收另用独立临时脚本复核 3 场景全部 PASS**：① 子目录 workspace 不提交且仓库内外文件均未被暂存、warn 一次；② merge 冲突中不提交且 `MERGE_HEAD` 仍在（未结束用户 merge）、有跳过告警；③ symlink workspace 指向仓库根时正常提交、工作区变干净（验证 `--show-prefix` 对 `/var→/private/var` symlink 路径安全） |
| **P1-3** workspace 是 DSH_HOME 祖先 → `~/.dsh/**` 入快照/可回写 | `storeFor()` `:482` 双向 `isSameOrInside`；`CheckpointStore.excludeRoots` + `walkWorkspace` 跳过（`:117`）；`restore.within()` 双重拒绝；默认忽略名单加 `.dsh` | ✅ 四层纵深防御 | G2「store 边界」+「安全（篡改 checkpoint 不越界）」；祖先/内含工作区 `tracking:false` 且不建 store |
| P2 小修 | `isSafeStorageSegment` `:89`、`Object.hasOwn(api, method)`、rejection 非 number → 503 fail-closed、`session/disposed` 清理、`loadConfig` 过滤非字符串 | ✅ 与修复文档一致，未见副作用 | G2 API 校验/鉴权/并发用例通过；`test-host` 对 `constructor` 等原型链方法返回 404 已被 API 校验用例覆盖 |

**Host 遗留（不阻断，见 `docs/host-fixes.md §4`）**：`snapshotEvents()` 被官方标记 deprecated（0.2.1 仍可用，移除此接口会退化到 `ownEvents()`/`.events`，最坏回到 baseline，不崩）；blob 无 GC/无 sha 校验；restore 无撤销；跨会话同 cwd 无锁；`trackSizeCap > blobSizeCap` 语义。

---

## 4. restore 语义端到端验收（task-6 第 4 项）

**PASS**。新增用例 `验收: 两轮边界 restore 语义`（`scripts/test-host.mjs`），fixture 与断言：

| 阶段 | 操作 | 状态 |
|---|---|---|
| 初始 | 写 `a.txt="A-init"` | baseline 捕获 A-init |
| 第1轮 | `a.txt → "A-round1"`，`turn/end seq=1` | checkpoint turn1 = A-round1 |
| 第2轮 | 新增 `b.txt="B-round2"`，`turn/end seq=3` | checkpoint turn2 = A-round1 + B-round2 |
| 回退到第2轮之前 | `restore({atSeq:1})`（= turn1 end seq） | `mode:"turn"`、`boundary={turn:1,endSeq:1}`；**`a.txt=="A-round1"`、`b.txt` 不存在（`deleted` 含 b.txt）** |
| 回退到第1轮之前 | `restore({baseline:true})` | `mode:"baseline"`；**`a.txt=="A-init"`、`b.txt` 不存在** |

```
✅ 验收: 两轮边界 restore 语义（第2轮边界还原 A 且 B 不存在；baseline 还原初始） (204ms)
```

该用例同时验证了修复后的真实事件读取路径（`snapshotEvents()` 风格 fixture + 真实 0.2.1 冷会话路径分别在 G2 其他用例覆盖）。真机侧可用 G4 的 `/dsh-rewind/api/*` 断言证明路由/鉴权可用；「真实对话 + 文件还原」需要 LLM 轮次，本轮未在真机驱动（见 §9）。

---

## 5. Client 修复复核（docs/audit-client.md P0×3 / P1×4）

| 缺陷 | 修复落点（当前 client.js） | 复核结论 |
|---|---|---|
| **P0-1** `QuestionActions` 拿到自身动作节点 → 每问操作行永不渲染 | `findUserNode()` `:352`（按 `data.seq`/`anchorSeq` 反查 `kind==="user"`）；`turnOfNode()` 优先官方 Location；`analyzeQuestion(snap, seq)`；`QuestionActions` 用 `node.data.seq`（`:458`） | ✅ 正确；`infoKey` selector 只返回字符串（避免新对象 selector 重渲染循环），`info` 由字符串 `safeCompute` 解码（`:468`） |
| **P0-2** `inject` 缺 `uiWorkspace` | `:806` `inject: ["slots","sessions","workspaces","uiWorkspace","locale","uiConversation"]` | ✅ 与静态扫描一致（G3 断言静态/VM 一致，0 未 inject 访问） |
| **P0-3** `archiveSession({sessionId})` 签名错误 | `:185` `ctx.workspaces.archiveSession(sessionId)`；归档移入 `childId !== null` 之后（`:250-255`） | ✅ 正确；fork 失败不再归档父会话 |
| P1-1 assistant 文本块 `type` → `kind` | `assistantTextOfTurn` 同时接受 `kind`/`type` | ✅ |
| P1-2 硬编码中文/locale | 新增 `forkFailed/continueText/starTurn`，`restoreFailed` 改 `{message}` 插值（ZH/EN 同步） | ✅；locale `{name}` 插值契约见 audit-client §2.2（`t(key, params)` 官方支持） |
| P1-3 archive 时机 + `surfaceOp==="append"` 过滤 | 归档绑定 cut 成功；`match` 过滤 replacement 副本 | ✅ |
| P1-4 selector 稳定性 | `useSnapshot` 内的 selector 结果包 `safeCompute`；`infoKey` 为字符串 | ✅ |

**crash-hardening 复核（服务/快照缺失时不崩）**：
- `safeCompute` `:119`、`runGuarded` `:124`、`guardSlot`/`SlotErrorBoundary` `:444`、`useSnapshot` 的 selector 兜底 `:447` 全部保留；新代码路径 `findUserNode`（`safeCompute` 扫描）、`info` 解码（`safeCompute`）、`analyzeQuestion`/`assistantTextOfTurn` 的取值均在 `safeCompute` 内。
- G3 新增**渲染降级冒烟**：6 个槽位渲染回调 × 5 种场景（缺 `useChat`、空快照、`null` 快照、抛异常快照、畸形 chat 快照）+ 1 个 Event Definition 的异常输入，**全部未抛异常**；`apply(ctx stub)` 正常注册 6 slots + 1 definition。
- 边界：完全空 props（连宿主按 `locale: NS` 注入的 `t` 都没有）下 5 个渲染回调会抛；这不是宿主契约路径（`t` 由注册项 `locale` 注入），记为假设而非缺陷。

---

## 6. 文件范围 / 卫生审查（task-6 第 2 项）

`git rev-parse HEAD` = `da034d7`（**未** commit/amend/push）。工作区变更：

| 文件 | 性质 | 审查结论 |
|---|---|---|
| `index.js` | Host 修复（+148/−22，693 行） | ✅ 仅契约修复，无调试残留/临时路径/依赖新增 |
| `client.js` | Client 修复（+82/−23，885 行） | ✅ 仅契约修复，crash-hardening 保留，无调试残留 |
| `package.json` | 元数据（Lead） | ✅ 见 §7 |
| `README.md` / `README.en.md` | 文档（Lead） | ✅ 安装/验证/已知限制更新；仅文档 |
| `install.sh`（新增） | 安装脚本（Lead） | ✅ `sh -n` 通过，可执行位 `-rwx--x--x`；**未执行**（会写真实 desktop profile，按约束禁止） |
| `docs/`（新增 5 篇 + 本文件） | 审计/修复记录/测试报告/最终验收 | ✅ 无敏感信息 |
| `scripts/`（新增 3 个验证脚本） | 测试基建 | ✅ 零第三方依赖、只用临时目录、不写真实 HOME |

卫生扫描（`grep` 于 `index.js client.js package.json install.sh scripts/ docs/`）：
- 无 `debugger` / `console.log`（运行时源码）/ `TODO` / `FIXME` / `XXX`；
- 无 `/tmp/`、`/private/tmp` 等临时路径硬编码（脚本一律 `os.tmpdir()`+`mkdtemp`）；
- 无 token/key/私钥/真实 HOME 路径（`/Users/xiao/...` 仅出现在安装说明与文档叙述中，属用户路径示例）；
- 未出现 `dsh-backup` 路径写入代码（仅 `scripts/e2e-host.mjs` 头注释声明“只作为模式参考、绝不修改”）；
- 未改 `cordis.patch.yml`、`locale/*.json`、`icon.svg`、`LICENSE`；
- 无 `.tgz` 等打包残留进工作区（`pnpm pack` 输出到临时目录）。

真实环境未污染：`~/.dsh/profiles/{web,desktop}` mtime 均早于本会话；桌面 DSH 进程未重启；`dsh-backup` 目录未被本会话写入（本会话所有写操作仅限 `dsh-rewind/{scripts,docs}`）。

---

## 7. package.json / 发布物复核

`package.json` 变更（如实记录）：
- `version`: `0.1.0` → **`0.1.1`**
- 新增 `description`（中英）、`license: MIT`、`keywords`（dsh/rewind/restore/回退等）
- 新增 `engines`: `{ "node": ">=20", "dsh": ">=0.2.1-rc.2 <0.3.0" }`
- `files` 追加 `install.sh`
- `dsh` 增加 `"manifestVersion": 1`（`bundle.patch` / `client.platform=web` / `immediately` / `inject` 未变）

`pnpm pack` 实测内容（`local-dsh-rewind-0.1.1.tgz`）：

```
package/LICENSE
package/README.en.md
package/README.md
package/client.js
package/cordis.patch.yml
package/icon.svg
package/index.js
package/install.sh
package/locale/en.json
package/locale/zh.json
package/package.json
```

→ 发布物包含运行时与安装脚本，不含 `docs/`/`scripts/`（与 `files` 白名单一致）。`scripts/e2e-host.mjs` 按 `readdir(*.tgz)` 发现 tarball，**不硬编码版本号**，version 0.1.1 下正常运行（G4 实证）。`engines.dsh` 为元数据约束，`pnpm` 未报错（实测安装成功）。

---

## 8. 遗留问题清单（含严重度）

| # | 严重度 | 问题 | 影响/处置 |
|---|---|---|---|
| L1 | **中（部署验证缺口）** | 桌面 Electron 运行时未真机启动验证；client 的 `/dsh-rewind/api/*` 使用相对 `fetch`，是否被桌面 fetch bridge 转发未实测 | 若不通：文件还原报可见错误「对话已回退，但工作区文件还原失败」，对话回退本身仍完成、不崩溃（`runGuarded`/`settle` 包裹）。建议安装后按 §10 手工冒烟；必要时先用 web profile（`dsh web`）验证完整功能 |
| L2 | 中（宿主前景） | `live.snapshotEvents()` 被官方标记 deprecated | 0.2.1 可用；未来移除时自动退到 `ownEvents()`/`.events`，最坏 restore 退回 baseline（P0 回归但不崩溃）。升级宿主前需复核 |
| L3 | 中（设计风险） | git auto-commit 默认开启；工作区内已暂存内容/未忽略敏感文件仍可能进入 checkpoint commit | 已按 `docs/host-fixes.md §2.3` 缩小影响面（仅仓库根、pathspec、merge 保护）；可 `{"gitAutoCommit": false}` 关闭；建议 README 后续更醒目提示（现已知限制已写入） |
| L4 | 低 | `trackSizeCap(5MB) > blobSizeCap(1MB)`：1–5MB 文件有指纹无内容，restore 时 `skipped:no-content` | 测试已锁定语义；属产品决策（见 `docs/host-fixes.md §4` P2-12） |
| L5 | 低（文档） | README/README.en/`docs/test-report.md` 仍写 Host 单测“18/18”，当前为 19 例（新增 task-6 语义验收用例） | 建议 Lead 顺手统一为 19/19（或删除具体数字） |
| L6 | 低（未验证项） | 冷会话 `open(id,'read')` 真实 JSONL 后端行为仅按源码/README + mock 验证，未在真机重启场景跑过 | 失败路径 fail-safe（`[]`、不抛、不误删文件）；e2e 的 API/鉴权层已真机通过 |
| L7 | 低（展示级） | `anchorSeq = seq + 0.1` 可能让该轮 `/skill` 名称装饰丢失；收藏按 turn 序号在 fork 后可能错位 | 已在 README「已知限制」与 `docs/client-fixes.md §4` 记录，非本轮范围 |
| L8 | 低 | 无浏览器 UI 自动化：槽位视觉/交互、`slot entry crashed` 运行期行为未自动验证 | 依赖用户首次安装后的手工冒烟（§10） |

**无 P0/P1 未决项**。修复文档中留档的 P2（`storageRoot` 位置、fork turn 撞号、异步 walk 非 seq 精确、无 GC/撤销、gitignore 近似实现等）均不阻断安装与核心功能。

---

## 9. 明确未验证的内容

1. **真实 Electron 桌面运行时**（受约束：不重启用户正在用的 DSH）：未启动桌面实例、未在桌面上点过任何按钮。
2. **真实对话驱动的端到端 restore**：需要一次真实 LLM 轮次；本轮以 mock-ctx 语义验收 + 真机路由/鉴权验收组合覆盖。
3. **浏览器视觉/交互**：未引入 Playwright 等浏览器自动化依赖。
4. **desktop profile 的真实安装**：`install.sh` 只做静态检查，未执行（会修改用户 profile）。等价的 tarball 安装路径已在隔离 web profile 完整验证。

---

## 10. 安装后手工冒烟清单（建议用户执行一次）

前置：`./install.sh`（安装到 desktop profile，`link:` 方式）→ 完全退出并重启 DeepSeek Harness → 刷新页面。

1. 打开任意已有会话，确认每条用户提问下方出现操作行（↶/📋/⭐，最后一问还有 ✎/🔁）→ 验证 P0-1。
2. 输入框左侧出现 📝/▶/🕘/★/心情按钮 → 验证槽位注册。
3. 在**一次性测试目录**里建一个会话，让 agent 改一个文件；点「↶ 回退到此」并勾选「同时还原工作区文件」→ 确认：新会话被打开（P0-2）、旧会话出现在归档列表（P0-3）、文件被还原且提示“还原 N 个文件”。
4. 若第 3 步提示「对话已回退，但工作区文件还原失败」→ 属 §8 L1 的桌面 fetch bridge 风险，请反馈并把 boot 日志（`~/Library/Logs` 或启动终端输出）中的 `dsh-rewind` 行贴出；临时可用 web profile（`dsh web`）验证完整功能。
5. 检查启动日志无 `slot entry crashed` / `dsh-rewind` 报错。

---

## 11. 证据命令（可复跑）

```bash
cd /Users/xiao/Desktop/dsh/dsh-rewind

# 冻结指纹（与上面记录的 sha256 对照；源码若变更说明验收对象已漂移）
shasum -a 256 index.js client.js

# 语法
node --check index.js && node --check client.js

# G2 Host 单测（19 例；严格模式，XFAIL 计入失败）
node scripts/test-host.mjs --strict

# G3 Client 静态守护（含 VM 加载/apply/渲染降级冒烟）
node scripts/check-client-static.mjs --strict

# G4 真机 boot 冒烟（隔离 DSH_HOME/HOME + tarball 安装 + token/cookie + HTTP 断言）
node scripts/e2e-host.mjs

# 发布物
pnpm pack --pack-destination "$(mktemp -d)" && tar -tzf <上一步 tgz>

# 文件范围
git rev-parse HEAD && git diff --name-only && git status --short && git ls-files --others --exclude-standard
```
