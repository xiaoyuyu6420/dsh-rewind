# dsh-rewind

[English](README.en.md) | 中文

为 DeepSeek Harness（DSH）Web 界面补上「回到这条提问之前重新来」的能力：
每条提问旁挂一排快捷控件，回退对话时**可选**是否把这个提问之后 agent 改过的工作区文件一起还原；
另带常用提示词面板、输入历史 ↑↓、一键「继续」、收藏跳转、复制本轮问答，
以及一个随状态变化的心情小表情与休息提醒。

适配 **DSH 0.2.1-rc.2**（`webRuntime` 已改名、`conversationEvents` 已改名，本插件按新契约编写）。

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

```bash
dsh plugin --profile desktop add "file:/Users/xiao/Desktop/dsh/dsh-rewind"
```

> ⚠️ pnpm 的 `file:` 依赖是**复制**而非软链。改完源码后必须重新 `add`（或手动把文件覆盖到
> `~/.dsh/profiles/desktop/node_modules/@local/dsh-rewind/`），再重启 DSH + 刷新页面才会生效。

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
- 也可调 `ignoreNames` / `ignorePatterns` / `trackSizeCap` / `blobSizeCap` / `maxFiles` / `maxTotalBlobBytes` / `enableGitignore`

客户端（浏览器 localStorage）：

- `dsh-rewind.phrases` — 常用提示词
- `dsh-rewind.restIntervalMs` — 休息提醒间隔（默认 45 分钟）
- `dsh-rewind.history.<sessionId>` / `dsh-rewind.stars.<sessionId>` — 输入历史与收藏

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
  locale/*.json     显示名与运行时文案（中英）
  icon.svg
```

## License

MIT — 见 [LICENSE](LICENSE)
