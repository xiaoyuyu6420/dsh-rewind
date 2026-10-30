# 安装与配置指南(dsh-rewind)

> 适用:DSH Web(`dsh web`)与 DSH Desktop。macOS / Linux / Windows 10+。
> 一句话:装上插件 → 重启 → 每条提问旁出现操作行,点「↶ 回退到此」即可。

## 1. 安装

### 方式 A:桌面端插件管理器(推荐桌面端)

DSH Desktop:**设置 → 插件 → 添加插件**,输入以下任一种:

- npm 包名:`@xiaoyuyu6420/dsh-rewind`
- GitHub 地址:`https://github.com/xiaoyuyu6420/dsh-rewind`
- 本地 tarball 绝对路径(例如 `/path/to/xiaoyuyu6420-dsh-rewind-0.2.0.tgz`)

> 桌面端的 profile 归**应用的插件管理器**所有;应用运行期间不要用命令行改它
> (宿主持锁,命令会报 `timed out waiting for the writer lock`)。

### 方式 B:命令行(Web / 其它 profile)

```sh
# 从 npm
dsh plugin --profile web add @xiaoyuyu6420/dsh-rewind

# 或从 GitHub(跟随 main)
dsh plugin --profile web add github:xiaoyuyu6420/dsh-rewind
```

本仓库自带的 `install.sh` 把上面几种方式包一层,并自动定位 Desktop 内置 CLI:

```sh
./install.sh                 # 默认 desktop profile,从 npm 安装
./install.sh --github        # 从 GitHub 安装
./install.sh --link          # 开发态:link 本目录,改完源码重启即生效
./install.sh --tarball FILE   # 从本地 .tgz 安装
./install.sh --uninstall     # 卸载
PROFILE=web ./install.sh     # 换 profile(默认 desktop)
DSH_CLI=/path/to/dsh ./install.sh
```

装完**重启 DSH**(桌面端完全退出再打开;Web 端重启 `dsh web`),然后刷新页面。

### 方式 C:离线 / 单文件(换机、内网)

```sh
npm pack                     # 在仓库根目录生成 xiaoyuyu6420-dsh-rewind-0.2.0.tgz
dsh plugin --profile web add /path/to/xiaoyuyu6420-dsh-rewind-0.2.0.tgz
```

tarball 内已含 `index.js`、`client.js`、`cordis.patch.yml`、`locale/`、`icon.svg`,
目标机器不需要构建,也不联网。

> `headless` profile 不适用本插件:插件 inject 了 `webServer` 与 `connection`
> (文件还原走 HTTP 接口),而 headless 没有这两个服务,插件不会 apply——
> `dsh --profile headless` 下没有检查点属预期。

## 2. 装完先做这 5 步

1. 重启 DSH,打开任意已有会话。
2. 每条**提问下方**出现操作行:↶ 回退到此 / 📋 复制 Markdown / ⭐ 收藏;最后一条提问还多 ✎ 修改并重发 / 🔁 重新生成。
3. 输入框左侧出现:**📝 常用提示词 / ▶ 继续 / 🕘 输入历史 / ★ 收藏 / 心情表情**。
4. 在**一次性测试目录**里新建会话,让 agent 改一个文件,然后点「↶ 回退到此」并勾选
   「同时还原工作区文件」→ 应看到:新会话被打开、旧会话进归档、提示「已回退:还原 N 个文件,删除 M 个」。
5. 打开浏览器控制台(桌面端按 F12)确认没有 `slot entry crashed` / `[dsh-rewind]` 报错。

## 3. 配置

### 开关(host 半区)

配置文件:`~/.dsh/storages/dsh-rewind/config.json`

```json
{
  "enabled": true,
  "gitAutoCommit": true,
  "gitCommitPrefix": "dsh: checkpoint before turn"
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后不记录任何文件检查点(回退只动对话) |
| `gitAutoCommit` | `true` | 每轮 `turn/start` 前把脏工作区提交一次(仅当工作区就是 git 仓库根;merge/rebase 等状态跳过) |
| `gitCommitPrefix` | `dsh: checkpoint before turn` | 自动提交信息前缀 |
| `ignoreNames` / `ignorePatterns` | 内置 | 追加忽略的文件名/模式 |
| `trackSizeCap` / `blobSizeCap` | 5MB / 1MB | 超过 `blobSizeCap` 只记指纹不存内容(还原时跳过) |
| `maxFiles` / `maxTotalBlobBytes` | 内置 | 单轮快照上限,超出即停止记录 |
| `enableGitignore` | `true` | 遵守工作区 `.gitignore` |

### 客户端(浏览器 localStorage,按会话)

| 键 | 说明 |
|---|---|
| `dsh-rewind.phrases` | 常用提示词短语 |
| `dsh-rewind.restIntervalMs` | 休息提醒间隔(默认 45 分钟) |
| `dsh-rewind.history.<sessionId>` | 输入历史(↑↓) |
| `dsh-rewind.stars.<sessionId>` | 收藏 |

### 回退语义(重要)

- 回退 = 从「这条提问之前」**分叉出新会话**,原会话进归档;对话层面不丢历史。
- 勾选还原时,文件被还原到**上一轮结束时**的状态:之后新建的文件会被删除,
  被改过的文件恢复原内容。**没有「撤销上一次还原」**。
- 重要工作区建议先提交/备份,或临时 `enabled: false`。

## 4. 升级与卸载

```sh
# 升级(npm 渠道)
dsh plugin --profile web update @xiaoyuyu6420/dsh-rewind
# 或重新 add 最新版
dsh plugin --profile web add @xiaoyuyu6420/dsh-rewind

# 卸载
dsh plugin --profile web remove @xiaoyuyu6420/dsh-rewind
./install.sh --uninstall          # desktop profile
```

升级/卸载后重启 DSH。历史检查点保留在 `~/.dsh/storages/dsh-rewind/`,可直接删除该目录清空。

## 5. 排错

| 症状 | 可能原因 | 处置 |
|---|---|---|
| 操作行完全不出现 | 插件没装进当前 profile;或页面没刷新;或 client bundle 加载失败 | 确认 `dsh plugin --profile <名> list` 里有它 → 重启 DSH → 刷新页面;控制台搜 `dsh-rewind` |
| 每条提问下只有原版 UI,输入框左侧也没有按钮 | client 半区 id 与包名不一致(手工改包名时易犯) | 检查 `client.js` 顶部 `id:` 与 `package.json` 的 `name` 相同 |
| 提示「对话已回退,但工作区文件还原失败」 | 客户端拿不到 `/dsh-rewind/api/*`(网络/桥接/鉴权) | 看控制台网络面板;临时改用 web profile 验证;把报错贴到 issue |
| 提示「本会话没有可还原的文件记录」 | 会话在插件安装前就已存在;工作区被排除(DSH home 祖先/忽略规则);`enabled:false` | 开新会话试;检查配置与工作区位置 |
| 安装报 `timed out waiting for the writer lock` / `EPERM` | 桌面端正在运行,profile 被持有 | 完全退出 DeepSeek Harness 后再安装 |
| 某个槽位静默消失 | 渲染崩了(已被 error boundary 拦住) | 控制台找 `[dsh-rewind] slot entry crashed`;请连带该行一起报 issue(宿主不会白屏) |
| 后悔还原了 | 无内置撤销 | 用 git 自动提交记录回滚(`git log` 找 `dsh: checkpoint before turn`),或从备份恢复工作区 |

## 6. 验证(想自己跑门禁)

```sh
node scripts/test-host.mjs --strict          # Host 单测 19 例
node scripts/check-client-static.mjs --strict # Client 静态守护
node scripts/check-runtime-contract.mjs      # 宿主契约守卫(升级 DSH 后先跑这个)
node scripts/e2e-host.mjs                    # 真机 boot 冒烟(隔离 home)
node scripts/e2e-turn.mjs                    # 真机两轮对话 → 检查点 → 还原(隔离 home + 假模型端点)
```

全部用隔离的临时 `DSH_HOME`,不触碰你的真实 `~/.dsh`。
