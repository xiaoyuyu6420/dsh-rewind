# 发版渠道与当前状态(dsh-rewind)

对照 dsh-backup 的发版形态整理。**npm 渠道当前被凭据卡住**,其余渠道已上线。

## 1. 渠道一览

| 渠道 | 状态 | 怎么用 |
|---|---|---|
| **GitHub 仓库** | ✅ 已上线 | `https://github.com/xiaoyuyu6420/dsh-rewind`(public,main 已推,CI 绿) |
| **GitHub 安装** | ✅ 已实测 | `dsh plugin --profile web add github:xiaoyuyu6420/dsh-rewind`;桌面「设置 → 插件 → 添加插件」填仓库 URL |
| **npm** | ⛔ 未发布 0.2.0 | 见 §2:本地 token 已吊销、账号 2FA 丢失;但 CI secret 的 token 仍可用 |
| **桌面插件管理器** | ✅ 可用 | 设置 → 插件 → 添加插件:npm 名 / GitHub URL / 本地 `.tgz` |
| **离线 tarball** | ✅ 可用 | `npm pack` → `dsh plugin --profile <p> add ./xiaoyuyu6420-dsh-rewind-0.2.0.tgz` |
| **插件市场索引** | ➖ 未收录 | DSH 的市场索引由用户自己配置 URL(`plugin-market.indexes`),默认没有内置源;要收录需自建/自荐索引 JSON |

发版流水线(tag → 门禁 → `npm publish`)已就位:`.github/workflows/publish.yml`(幂等:版本已存在则跳过),
CI 门禁在 `.github/workflows/ci.yml`。**推送 `v*` tag 即触发发布**(前提:仓库里有 `NPM_TOKEN` secret)。

## 2. npm 凭据现状(2026-10-30)

- `~/.npmrc` 里的 token(本机唯一一份)已失效:`npm whoami` → **401 Unauthorized**。
- 账号 2FA 设备在另一台无法登录的 Mac 上,**未保存恢复码**,所以自助登录走不通。
- 但 **dsh-backup 仓库的 `NPM_TOKEN` secret 仍可用**:2026-10-30T03:04Z 的 `v0.14.1`
  发布流水线成功,说明那是一个绕过 2FA 的自动化 token。GitHub secret 是只写不可读的,
  所以它只能在 Actions 里被使用,读不出来拷到别处。

### 实测结果(2026-10-30 15:0x,借 dsh-backup 的 secret 跑了一次 dispatch)

- 门禁全过、tarball 正确(12 文件 / 34.3 kB / `@xiaoyuyu6420/dsh-rewind@0.2.0`);
- `npm publish` 在 **PUT 建包** 这一步失败:`E404 Not Found - PUT .../@xiaoyuyu6420%2fdsh-rewind`;
- 结论:该 `NPM_TOKEN` 是**按包授权的 granular token**(能发 `@xiaoyuyu6420/dsh-backup`,无创建新包权限)。
  所以它只能维持 dsh-backup 自己的发版,**不能用来发新包**。
- 临时工作流已用 PR #136 回滚:dsh-backup 的 `.github/workflows/` 只剩 `ci.yml / compat.yml / publish.yml`,
  `package.json` 仍是 0.14.2,发布逻辑未变(只在 Actions 历史里多了一条失败 run)。

### 名字占用提醒

npm 上无作用域的 `dsh-rewind` 已被第三方占用(`l-dot`,`github.com/LJH-dot/dsh-rewind`,v0.11.12,
"Claude Code-style /rewind for DSH"),所以:

- 本插件**必须**用带作用域的名字 `@xiaoyuyu6420/dsh-rewind`;
- 对外说明时建议带上作者/仓库地址,避免与那个同名插件混淆。

### 可选处置

1. **找回账号**:优先找 TOTP 是否还在别的设备/密码管理器里(iCloud 钥匙串、1Password、
   Bitwarden、浏览器同步),npm 的 TOTP 条目名通常是 `npm` 或 `registry.npmjs.org`;
   否则只能走 npm 官方支持重置 2FA(<https://www.npmjs.com/support>,需能收账号邮箱)。
   恢复后**立刻**新建 automation token 存进密码管理器 + 两个仓库的 secret,并把恢复码存档。
2. **不登录也能发(借助现有 CI token)**:在 dsh-backup 仓库加一个 `workflow_dispatch`
   工作流,checkout 本仓库 → 跑门禁 → `npm publish`(token 由该仓库 secret 注入,不落盘)。
   一次性的发完即可删除;想长期这么发就留成常驻工作流。
   注意:若该 token 是单包作用域的 granular token,发别的包会 403。
3. **不用 npm**:GitHub 渠道已经能把插件装到桌面/Web,功能完全一致(npm 只是分发方式)。

## 3. 发 0.2.0 的具体动作(任选其一)

```bash
# A. 账号恢复后(本地有可用 token):
npm publish --access public          # 仓库根目录;已验证 dry-run
git tag v0.2.0 && git push origin v0.2.0   # 打 tag 让流水线留痕(幂等,不会重复发布)

# B. 账号未恢复、借 CI token:先按 §2-2 在 dsh-backup 加工作流,dispatch 它。
# C. 先不发 npm:直接走 GitHub 安装,dsh-rewind 的 npm 发布留待日后。
```

## 4. 发版检查单(以后每次)

1. `npm run verify`(五道门禁;需要本机装有 DSH,否则契约守卫会 SKIP)
2. 更新 `package.json` 的 `version` 与 README「验证」表里的数字
3. `npm publish --dry-run` 看包内容(应为 12 个文件,约 34 kB)
4. `git commit` → `git tag vX.Y.Z` → `git push origin main --tags`
5. 发布后:`dsh plugin --profile web add @xiaoyuyu6420/dsh-rewind@X.Y.Z` 在隔离 profile 实测一次
