# dsh-rewind

[English](README.en.md) | 中文

为 DeepSeek Harness（DSH）Web 界面补上「回到这条提问之前重新来」的能力：
每条提问旁挂一排快捷控件，回退对话时**可选**是否把这个提问之后 agent 改过的工作区文件一起还原；
另带常用提示词面板、输入历史 ↑↓、一键「继续」、收藏跳转、复制本轮问答，
以及一个随状态变化的心情小表情与休息提醒。

适配 **DSH 0.2.1-rc.5**,并已在 rc.2 上完成过同一轮真机验收(boot 冒烟 14/14、Host 单测 19/19、Client 静态守护通过)。上一版只是"按新契约编写",本版把真实契约跑通并修掉了会导致动作行不渲染、回退不打开新会话、还原退化成初始状态等问题的缺陷,详见 [docs/](docs/)。

宿主 0.2.1-rc.2 → rc.5 的逐条契约复核见 [docs/compat-rc5.md](docs/compat-rc5.md):rc.5 上 boot 冒烟仍 14/14,依赖的宿主/客户端契约点全部未变,**无需改代码**。唯一需要留意的是 rc.5 把同步会话事件读取(`snapshotEvents`/`ownEvents`/`eventAt`)整族标为 deprecated(官方自身也仍在用,且暂无同步替代品);将来若被移除,restore 会退回 baseline(功能降级、不崩溃)。

## 功能

### 每条提问旁的操作行

| 控件 | 作用 |
|---|---|
| ↶ 回退到此 | 从这条提问之前分叉出新会话，丢弃这条及其后的对话；弹确认，带「是否同时还原工作区文件」勾选（默认勾） |
| ✎ 修改并重发 | 仅最后一条：回退 + 把原问题载回输入框，改完再发 |
| 🔁 重新生成 | 从这条之前分叉 + 原样重问一遍（保留文件、不还原） |
| 📋 复制 Markdown | 一键复制「这一轮的提问 + 回答」为 Markdown |
| ⭐ 收藏 | 收藏/取消收藏这条消息，可在输入框旁列表跳转回去 |

### 输入框左侧工具栏

- 📝 **常用提示词**：本地保存的短语，点一下填入输入框，可编辑
- ▶ **继续**：一键发「继续」（失败时按钮变红提示）
- 🕘 **输入历史**：下拉选择，且**空输入框里按 ↑↓ 可直接翻历史**
- ★ **收藏列表**：列出收藏消息，点击跳回那一轮
- 😴/🤔/✨/🧋 **心情表情**：随运行/完成/休息提醒变化

### Host 侧

- 每轮 `turn/end` 记录工作区文件检查点（CAS 内容寻址快照，忽略 `.git`/`node_modules` 等，遵守 `.gitignore`）
- 每轮 `turn/start` 前**自动 git 提交**（可选，默认开）作为额外保险
- 提供 restore API，按事件序号把工作区还原到指定轮次

## 安装

### 桌面端:插件管理器(推荐)

DSH Desktop **设置 → 插件 → 添加插件**,输入 npm 包名 `@xiaoyuyu6420/dsh-rewind`,
或 GitHub 地址 `https://github.com/xiaoyuyu6420/dsh-rewind`,或本地 `.tgz` 绝对路径。
装完完全退出并重启 DeepSeek Harness。

### 命令行 / Web profile

```bash
dsh plugin --profile web add @xiaoyuyu6420/dsh-rewind        # npm
dsh plugin --profile web add github:xiaoyuyu6420/dsh-rewind  # GitHub(跟随 main)
```

本仓库的 `install.sh` 把各种渠道包了一层(自动定位 Desktop 内置 CLI,可用
`DSH_CLI=/path/to/dsh` 指定):

```bash
./install.sh                  # 默认 desktop profile,从 npm 安装
./install.sh --github         # 从 GitHub 安装
./install.sh --tarball FILE    # 从本地 .tgz 安装
./install.sh --link           # 开发态:link 本目录,改完源码重启即生效
./install.sh --uninstall      # 卸载
PROFILE=web ./install.sh      # 换 profile(默认 desktop)
```

> ⚠️ 开发态请用 `--link`(即 `link:` 依赖):pnpm 的 `file:` 依赖是**复制**而非软链,
> 改完源码必须重新 add。桌面端运行期间不要用命令行改 profile(宿主持锁,会报
> `timed out waiting for the writer lock`)。
> `headless` profile 不适用(插件 inject `webServer`/`connection`,headless 没有这两个服务)。

完整安装/配置/排错见 [docs/INSTALL.md](docs/INSTALL.md)。
> ℹ️ **与 npm 上同名包无关**:npm 有一个无作用域的 `dsh-rewind`(作者 l-dot,2026-08 后停更;
> 它注入的 `conversationEvents` 服务在 DSH 0.2.1 已不存在,装在新版宿主上不会生效)。
> 本项目的包名是带作用域的 `@xiaoyuyu6420/dsh-rewind`,仓库是 [xiaoyuyu6420/dsh-rewind](https://github.com/xiaoyuyu6420/dsh-rewind)。
> 两者实现不同:本项目用内联按钮 + 按轮 CAS 检查点精确还原 + 分叉新会话;详见 [docs/RELEASE.md](docs/RELEASE.md)。

发版渠道与当前状态(npm / GitHub / tarball)见 [docs/RELEASE.md](docs/RELEASE.md)。

## 验证

在 DSH 0.2.1-rc.2（macOS arm64）上：

| 门禁 | 命令 | 结果 |
|---|---|---|
| Host 半区单测 | `node scripts/test-host.mjs --strict` | 19/19（快照/还原/鉴权/git 自动提交/并发） |
| 真机 boot 冒烟 | `node scripts/e2e-host.mjs` | 14/14（隔离 DSH_HOME、tarball 安装、boot 200、client bundle、API/401/405/404） |
| 真机轮次闭环 | `node scripts/e2e-turn.mjs` | 22/22（隔离 home + 本地假模型端点 → **真实两轮对话** → 检查点落盘 → HTTP restore 精确还原文件；见 [docs/e2e-turn.md](docs/e2e-turn.md)） |
| Client 静态守护 | `node scripts/check-client-static.mjs --strict` | PASS（`ctx.<service>` 访问与 `inject` 一致、bundle 可在沙箱加载并 apply） |
| 宿主契约守卫 | `node scripts/check-runtime-contract.mjs` | 17/17 PASS（依赖的宿主/客户端契约点，**升级 DSH 后先跑这个**；见 [docs/runtime-contract.md](docs/runtime-contract.md)） |

测试都用临时 `DSH_HOME`，不会碰真实 `~/.dsh`；环境缺 `dsh`/`pnpm`/网络时 e2e 会明确 SKIP。

## 配置

Host 配置：`~/.dsh/storages/dsh-rewind/config.json`

```json
{
  "enabled": true,
  "gitAutoCommit": true,
  "gitCommitPrefix": "dsh: checkpoint before turn"
}
```

- `enabled: false` — 关闭文件检查点
- `gitAutoCommit: false` — 关闭每轮前自动 git 提交
  （自动提交只在「会话工作区 == git 仓库根」时执行，且遇到 merge/rebase/cherry-pick 等状态会跳过）
- 也可调 `ignoreNames` / `ignorePatterns` / `trackSizeCap` / `blobSizeCap` / `maxFiles` / `maxTotalBlobBytes` / `enableGitignore`

客户端（浏览器 localStorage）：

- `dsh-rewind.phrases` — 常用提示词
- `dsh-rewind.restIntervalMs` — 休息提醒间隔（默认 45 分钟）
- `dsh-rewind.history.<sessionId>` / `dsh-rewind.stars.<sessionId>` — 输入历史与收藏

## 已知限制

- **还原是破坏性的**：检查点之后手工新建、且未被忽略规则排除的文件会被删除；没有「撤销上一次还原」。
  重要工作区建议先提交/备份，或临时把 `enabled` 设为 `false`。
- 大于 `blobSizeCap`（默认 1MB）的文件只记录指纹不存内容，还原时会跳过并在结果里计入 `skipped`。
- 当会话工作区是 `$DSH_HOME` 的祖先（例如整个 home 目录）时**不跟踪**，避免把 `~/.dsh`（含凭据）纳入快照。
- 自定义动作行用 `seq + 0.1` 的锚点插在提问下方，可能让该轮 `/skill` 名称装饰丢失（仅展示层）。
- 输入历史/收藏存在浏览器本地并按会话保存；回退/分叉后轮次号会重排，旧收藏可能指向别的轮。
- 冷会话（宿主重启后）还原依赖 session 持久化日志，需插件在会话存活期间已建立检查点。
- 只作用于 **web / desktop** profile：插件 inject 了 `webServer` 与 `connection`（还原走 HTTP 接口），
  `headless` profile 没有这两个服务，插件不会 apply —— `dsh --profile headless` 下没有检查点属预期行为。

## 崩溃安全（很重要）

DSH 的槽位机制是：渲染函数里任何未捕获异常都会让宿主记录
`slot entry crashed in '<slot>'` 并把那个槽位整块清空。本插件按「让崩溃在结构上不可能」设计：

- 每个槽位入口包一层 **React error boundary**，崩了就卸载子树、渲染 `null`
- 所有快照计算走 `safeCompute`（异常→降级值）
- 所有异步流程走 `runGuarded`（异常→统一结果，不抛出）
- 所有 DOM 访问走 `safeDom`
- 鉴权缺失时 **fail-closed**（返回 503 而不是放行）

最坏情况：某个槽位静默消失 + console 一条 `[dsh-rewind] slot entry crashed`，
不会白屏，也不会连累其它插件。

## 目录

```
dsh-rewind/
  index.js          Host 半区：文件检查点、git 自动提交、restore API
  client.js         Client 半区：槽位 UI、快捷控件、心情
  cordis.patch.yml  Loader 插入的插件行
  package.json      dsh.bundle.patch + dsh.client
  install.sh        安装/卸载到 desktop profile（link: 开发态）
  locale/*.json     插件显示名与描述（中英）
  scripts/          验证脚本（Host 单测、真机 boot 冒烟、Client 静态守护、宿主契约守卫）
  docs/             INSTALL 安装指南、契约审计、修复记录、测试报告、最终验收、版本兼容复核、运行时契约
  icon.svg
```

## License

MIT — 见 [LICENSE](LICENSE)
