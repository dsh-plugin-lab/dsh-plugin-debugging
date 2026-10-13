# 发布手册

面向维护者。本文件讲**流程与判据**；「发布态该有什么」由
[scripts/check-release.mjs](../scripts/check-release.mjs) 的断言集合定义。两者互补，不互相抄。

**本文职责**：本仓怎么发一个版本、发之前要核什么、出错了怎么办。
**不负责**：跨仓判据（那条在工作区里另一份检出的 `docs/plugin-conventions.md`，不在本仓）；工具与技能的行为（见
[docs/ARCHITECTURE.md](ARCHITECTURE.md) 与 [README.md](../README.md)）。

## 发版前确认

逐条跑，全绿才继续。任何一条红了就停下，不要绕过。

- `npm run check:release` —— 发布态不变量：bundle 声明在不在、`private` 去掉没有、
  `engines.dsh` 声明了没有、`files` 覆盖 `cordis.patch.yml` 与
  `skills/dsh-plugin-debugging/SKILL.md`、`exports` 暴露 `./skills/*`、
  以及**发布流程没有偷偷改写版本号**（最后一条读的是 `release.yml` 的文本）。
- `npm run check`（= typecheck + build + test）与 `npm run lint`、`npm run format:check`。
- 身份件比对：在工作区根跑 `node <脚手架检出>/scripts/scaffold.mjs check dsh-plugin-debugging`（比对脚本不在本仓）
  —— 只比 5 个「逐字相同」件，离线只读。
- **`git rev-parse origin/main` 必须等于 `git rev-parse HEAD`。**
  **没 push 就没有可发的东西**：发布守卫判的是「上个 tag 到 **HEAD** 之间有没有改动」，
  而 workflow 跑的是**远端**那份代码 —— 本地领先而没推时，远端那个区间是**空的**，
  守卫会以「没有可发的」红掉（同工作区的另一个仓 2026-09-22 就是这么撞的：本地领先 11 个提交、
  远端还停在上一个 tag）。**先 push，再 dispatch。**
  这是组织判据里 Must agree 的一条（「发布前确认要发的提交已在远端」）。
- 按下面的判定链定档，然后本地 bump：

  ```shell
  npm version <patch|minor|major|prerelease|premajor> --preid=alpha --no-git-tag-version
  ```

  这一步会**同时**改 `package.json` 与 `package-lock.json`；只手工改前者会被 CI 与
  `release.yml` 两处守卫拦下。
  **`prerelease` 与 `premajor` 不是同义词**：前者在同一条 `X.Y.Z` 线上把预发布计数 +1，
  后者**开新线**（从 `0.2.0-alpha.0` 跑 `premajor` 得到的是 `0.3.0-alpha.0`），
  而 npm 上的版本号**不可覆盖**。拿不准就在临时目录里先量一次。

## 发布入口

唯一入口是 [release.yml](../.github/workflows/release.yml)，**手动触发**
（Actions → release → Run workflow，或 `gh workflow run release.yml`）。

它**不需要任何仓库 secret**：认证走 npm Trusted Publishing（OIDC），
向 npm 换短期凭据；git 侧只用内置 `GITHUB_TOKEN` 建 tag 与 Release。
**本仓的发布不推 `main`** —— 所以不需要 GitHub App token 与 ruleset 放行
（同工作区有的仓因为要把发布提交推回 main，才多一把 App 私钥）。

### bump 是发布**之前**的独立一步，workflow 不 bump

顺序是死的：**先 bump 并提交 → 再 push → 最后 dispatch 发布**。

为什么不能把 bump 塞进 workflow：界面上的版本号显示的就是 `package.json` 里那个号。
只要发布流程自己改版本，工作树就永远停在「上一个已发布版本」——截图与界面必然拍出旧号。
这条不变量**已落成断言**（`check:release` 的「发布流程不改写版本号」），
所以它不靠人记得，靠脚本拦。

推论：**发一个版本 = 一次 bump 提交 + 一次 workflow 运行**；workflow 重跑不会改任何版本号。

### 首次发布是引导步：由维护者手动做一次

`0.1.0` 由维护者在本机手动 `npm publish`（维护者 2026-10-13 指定；之后的版本一律走 workflow）。

⚠️ **手动发过之后，tag 与 Release 不会被流程补出来**：`release.yml` 的 Tag 步骤带
`if: steps.probe.outputs.exists == 'false'`，版本一旦已经在 npm 上，**publish 与 tag 两步都会跳过**。
所以首次发布只有两条路，二选一：

- **手动补 `v<version>` tag 与 Release**（形状必须是 `v` + `package.json` 的版本号 —— 守卫与巡检靠
  `git describe --match 'v[0-9]*'` 看它，漏了 `v` 前缀那个 `--match` 就看不见）；
- 或者**直接 bump 到下一个号**（如 `0.1.1`）再走 workflow，让流程从那个号开始产出 tag 与 Release
  （`0.1.0` 就永远没有 tag）。

## workflow 逐步做什么

按固定顺序，前面任何一步红了都走不到发布：

1. `npm ci`（冻结安装）。
2. 校验 `package.json` 与 `package-lock.json` 的版本号一致。
3. `npm run typecheck` / `npm test`。
4. `npm run check:release`（发布态不变量）。
5. release-guard：`git describe --tags --abbrev=0 --match 'v[0-9]*'` 取上个 tag，
   比 `上个 tag..HEAD` 的改动；**只剩非产物改动就中止**（发了等于制造一个内容相同的新版本号）。
   首次发版没有任何 tag，这一步自动跳过。
6. 探该版本在不在 npm 上。在就跳过 publish，只补 git 侧 —— 重跑一条流水线不会撞 403。
7. `npm publish --provenance --tag <dist-tag>`。
8. 打 `v<version>` tag 并**只推这个 tag**；tag 已存在则跳过。
9. 建 GitHub Release：**正文两级 —— 先读 Release Drafter 的 `next` 草稿，草稿空则回落
   `--generate-notes`**；并显式区分「草稿读不到」（配置坏了，发 `::warning::`）与
   「草稿读到了但没有条目」（正常）。

`dry-run` 输入只做检查与打包，不发布也不打 tag。

## tag 与 Release 的形状

- **tag 名 = `v` + `package.json` 里的版本号**（如 `v0.2.0`），前缀由 workflow **显式补**。
  这是**形状判据，不是审美**：release-guard 与兼容巡检用
  `git describe --match 'v[0-9]*'` 看 tag，**不带 `v` 的 tag 那个 `--match` 看不见**。
  换版本号的来源时（`npm version` 的输出自带 `v`，读 `package.json` 则没有）形状会跟着变，
  必须同批把前缀补上。
- 版本号带**预发布段**（如 `0.2.0-alpha.1`）→ dist-tag 由版本自己那段推导（`alpha`），
  `latest` 保持不动；Release 加 `--prerelease`。
- **git 侧两样产物（tag 与 Release）都由流程产出**，不靠人记得去补。

## Trusted Publisher 一次性配置

认证是 OIDC，仓库里**不该出现任何 npm token**；出现了说明配置没生效。在 npmjs.com 上
打开本包 → Settings → Trusted Publisher → GitHub Actions，四项必须**逐字对上**：

| 字段 | 值 |
|---|---|
| Organization or user | `dsh-plugin-lab` —— 填 **GitHub 属主**，不是 npm 用户名 |
| Repository | `dsh-plugin-debugging` |
| Workflow filename | `release.yml` |
| Environment name | `release` —— 必须与 job 上的 `environment:` **逐字一致** |

另外两件一次性配置（与 npm 无关）：

1. 在 GitHub 仓库设置里建同名 environment `release`，可以给它挂人工审批。
2. 配好 ruleset（见下）。

**排障**：属主 / 仓库 / workflow 文件名不符，通常报 `ENEEDAUTH`；
**环境名不符实测报的是 `404 … you do not have permission to access it`**，
极易误读成权限问题 —— 先比对 `environment`，别按权限查。

## 仓库设置（发布链路的前置）

- **ruleset `protect-main`**：`required_status_checks` 只配 **`CI Success`** 这一个名字
  （就是 [ci.yml](../.github/workflows/ci.yml) 的收口 job）。
  **必须在 `CI Success` 在 main 上出现过一次之后再要求它** —— 否则这个检查永远等不到，
  PR 会一直卡在 pending。
- **npm 上的 publishing access** 允许 trusted publisher。

## 发布之后

- **「发布成功」以 registry 为准，而且它有几分钟延迟。** CLI 打出 `+ <包名>@<号>`、
  provenance 也进了透明度日志之后，registry 那一刻**可能还查不到**这个号。
  **别在这一刻判失败，更别重发**（重发撞的是「版本已存在」）；轮询
  `npm view dsh-plugin-debugging dist-tags`，等那个号出现。
  **实测（2026-10-13 发 `0.2.0`）**：workflow 已 `completed success`、tag 与 Release 都已建，
  而 registry 那一刻**仍显示 `latest: 0.1.0`、attestations 端点 404**；轮询第 2 次（约 20 秒后）
  才变成 `latest: 0.2.0` / **200**。→ **「刚发完就查」看到的那个 404 不是发布失败。**
- **provenance 的真假要对具体版本查，别凭「这次走的是 workflow」推断**：
  `https://registry.npmjs.org/-/npm/v1/attestations/dsh-plugin-debugging@<版本>` —— **200 才算有**。
  实测：手动发的 `0.1.0` → **404**；workflow 发的 `0.2.0` → **200**。这就是 SLSA 徽章能不能挂的判据。
- **workflow 日志会自证 provenance**：`Signed provenance statement … from GitHub Actions` 与
  `Provenance statement published to transparency log` 两行同时出现，才说明 `--provenance` 真的生效。
- 核对该版本是否已经在 `latest`（预发布则应在 `alpha`，且 `latest` 未动）。

## 发布后缺陷处理

**不发 unpublish。** 已经有人装过的版本一旦撤下，他们的 lockfile 就指向一个不存在的版本，
下一次 `npm ci` 直接失败。正确动作四步：`npm deprecate <name>@<version> "原因与替代版本"`
→ 修 → 定档发新版本 → 在 tag 说明里写清影响范围与升级动作。

只有「发布后 72 小时内、且确认无人依赖」才考虑 unpublish；走这条例外要在提交信息里写明依据。
