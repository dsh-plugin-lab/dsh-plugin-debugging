# 发布手册

面向维护者。本文件讲**流程与判据**；「发布态该有什么」由
[scripts/check-release.mjs](../scripts/check-release.mjs) 的断言集合定义。两者互补，不互相抄。

**本文职责**：本仓怎么发一个版本、发之前要核什么、出错了怎么办。
**不负责**：跨仓判据（那条在工作区里另一份检出的 `docs/plugin-conventions.md`，不在本仓）；工具与技能的行为（见
[docs/ARCHITECTURE.md](ARCHITECTURE.md) 与 [README.md](../README.md)）。

## 发版前确认

逐条跑，全绿才继续。任何一条红了就停下，不要绕过。

- `pnpm run check:release` —— 发布态不变量：bundle 声明在不在、`private` 去掉没有、
  `engines.dsh` 声明了没有、`files` 覆盖 `cordis.patch.yml` 与
  `skills/dsh-plugin-debugging/SKILL.md`、`exports` 暴露 `./skills/*`、
  以及**发布流程没有偷偷改写版本号**（这一条读的是 `release.yml` 的文本）等；
  判据清单以脚本的断言集合为准，这里不抄。
- `pnpm run check`（= typecheck + build + test）与 `pnpm run lint`、`pnpm run format:check`。
- 身份件比对：在工作区根跑 `node <脚手架检出>/scripts/scaffold.mjs check dsh-plugin-debugging`（比对脚本不在本仓）
  —— 只比 5 个「逐字相同」件，离线只读。
- **`git rev-parse origin/main` 必须等于 `git rev-parse HEAD`。**
  **没 push 就没有可发的东西**：发布守卫判的是「上个 tag 到 **HEAD** 之间有没有改动」，
  而 workflow 跑的是**远端**那份代码 —— 本地领先而没推时，checkout 里的 `package.json` 仍是
  **远端那个已发布的版本**，探针查到它已经在 npm 上，发布步骤全部跳过：那是一条**绿的 no-op**，
  **不再以红的形式报出来**。
  ⚠️ **以前会红、现在不会，是同一处改动的两面**：旧形态下 dispatch 不排「当前版本自己的」tag，
  `previous` 因此落在**远端 HEAD 自己**那个 tag 上 ⇒ 区间空 ⇒ 守卫 exit 1（同工作区的另一个仓
  2026-09-22 就是这么撞的：本地领先 11 个提交、远端还停在上一个 tag）；现在两个入口都排掉
  当前版本自己的 tag，基线落在**上一个发布**上 ⇒ 区间非空。**但它只是从「会喊的失败」变成
  「不会喊的失败」** —— **先 push，再 dispatch。**
  这是组织判据里 Must agree 的一条（「发布前确认要发的提交已在远端」）。
- 按下面的判定链定档，然后本地 bump：

  ```shell
  npm version <patch|minor|major|prerelease|premajor> --preid=alpha --no-git-tag-version
  ```

  版本号只写在 `package.json` 一处：pnpm 的锁文件不记录根包自身的版本，所以 npm 仓那种
  「锁文件版本 == 清单版本」的交叉核对在本仓没有对应物。`pnpm install --frozen-lockfile`
  承担的是「锁文件与清单必须同步」那一半（对不上直接失败）；**漏 bump** 由发布链上那道
  「该版本已在 npm 上」的幂等判据兜住 —— 报的是「已存在」，而不是发一个内容相同的新版本出去。
  **`prerelease` 与 `premajor` 不是同义词**：前者在同一条 `X.Y.Z` 线上把预发布计数 +1，
  后者**开新线**（从 `0.2.0-alpha.0` 跑 `premajor` 得到的是 `0.3.0-alpha.0`），
  而 npm 上的版本号**不可覆盖**。拿不准就在临时目录里先量一次。

## 发布入口

发布入口是 [release.yml](../.github/workflows/release.yml)，它有两个等价入口，进的是同一个 job、
同一条全有或全无的顺序：

- **手动触发**：Actions → release → Run workflow，或 `gh workflow run release.yml`。
  只接受 `main`；那道守卫带着 `github.event_name == 'workflow_dispatch'` 前提 —— 不带这个前提的话，
  tag 触发时 `github.ref` 是 `refs/tags/...`，每一次 tag 发布都会红，而且红的原因离真正的原因很远。
- **推 tag**：`git push origin v<版本>`。tag 触发天然指向某个提交，「只接受 main」不适用，
  改由 **tag / 清单一致性闸**管：tag 名必须逐字等于 `v` + `package.json` 里的版本号，
  对不上就报「推的是 X，而 package.json 是 Y」并中止。没有这道闸就会出现
  「tag 是 `v0.3.0`、实际发的是 `0.2.0`」，而 npm 的版本号**不可覆盖**。

`dry-run` 是手动触发独有的输入，只做检查与打包，不发布、不打 tag、不建 Release（也因此不会删草稿）。

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

**手动发过的那一版，tag 与 Release 可以由流程补出来。** `exists` 只喂 `Publish` 一步：版本一旦
已经在 npm 上，只有 `Publish` 跳过，`Tag the release` 与 `Create the GitHub Release` 照跑 ——
它们各自内部幂等（tag 已存在则由 `git rev-parse` 命中后跳过，Release 已存在则由 `gh release view`
命中后跳过），这两步重跑不会撞已存在的 tag / Release。因此**只要 `package.json` 还停在那个号**，
手动触发一次 `release.yml` 就能补出那个版本的 tag 与 Release，不必在本机手工打 tag；正文照常走
「Drafter 草稿 → `--generate-notes` 回落」。补**还没打 tag** 的版本时，这是首选做法：它与其余版本
走同一条路（tag 形状与正文来源都一致），也不经过 tag 入口那道一致性闸。
（`dry-run` 那次补不出来：它不建任何正式版。）

⚠️ 它前面的 release-guard 不挡回填：两个入口都会**排掉当前版本自己的 tag**（tag 入口排
`github.ref_name`，手动入口排 `v` + 清单里的版本号），基线因此落在**上一个发布**上 —— 不排的话
HEAD 就是当前那个 tag 指向的提交、`上个 tag..HEAD` 恒空，一次「只差 Release」的回填会被判成
「没有可发布的内容」。**唯一例外是没有更早的基线**：仓里还没有任何 tag，或排掉当前版本自己的 tag
之后再没有更早的 tag ⇒ 守卫跳过（那两种情况都等于「没有可比基线」，守卫不适用）。所以回填不必
手动建 Release。

另外两条可选做法，视情况用：

- **手动补 `v<version>` tag 与 Release**（形状必须是 `v` + `package.json` 的版本号 —— 守卫与巡检靠
  `git describe --match 'v[0-9]*'` 看它，漏了 `v` 前缀那个 `--match` 就看不见）。
  这条路不要求 `package.json` 停在旧号。代价：手动推 tag 会**触发 tag 入口那次运行**，
  而它先过一致性闸 —— `package.json` 已经在新号上时那次运行会红（Release 这时也要手动建）。
- **直接 bump 到下一个号**（如 `0.1.1`）再走 workflow，让流程从那个号开始产出 tag 与 Release ——
  旧号就永远没有 tag / Release。

## workflow 逐步做什么

按固定顺序，前面任何一步红了都走不到发布：

1. `pnpm install --frozen-lockfile --config.node-linker=hoisted`（冻结安装）。
2. `pnpm run typecheck`。
3. **`pnpm run build`** —— ⚠️ **这一步不能少**，理由见下面「产物是构建出来的」。
4. `pnpm test`（**它自己不构建**：本仓的 `test` = `vitest run`）。
5. `pnpm run check:release`（发布态不变量）。
6. tag 触发时：tag 名必须逐字等于 `v` + `package.json` 版本（tag / 清单一致性闸）。
7. release-guard：`git describe --tags --abbrev=0 --match 'v[0-9]*'` 取上个 tag
   （**两个入口都会 `--exclude` 掉「当前版本自己的」那个 tag**，见下），
   比 `上个 tag..HEAD` 的改动；**只剩非产物改动就中止**（发了等于制造一个内容相同的新版本号）。
   首次发版没有任何 tag，这一步自动跳过。
   ⚠️ **基线要排掉当前版本自己的 tag**：不排的话 HEAD 就是那个 tag 指向的提交，`describe` 解析出
   它自己、`<tag>..HEAD` 恒空 —— 一次完全正常的发布（或一次「只差 Release」的回填）会被判成
   「没有可发布的内容」。两条规则各自成立：**tag 入口**排 `github.ref_name`；
   **手动入口**在「`v` + 清单版本」这个 tag **已经存在**时排它 —— tag 还没建时这一步是空操作，
   全新发布的路径逐字不变。
8. 探该版本在不在 npm 上（`npm view`）。在就跳过 `Publish` —— 重跑一条流水线不会在 npm 那里撞 403。
   ⚠️ 这个 `exists` **只喂 `Publish` 一步**：git 侧两步（tag 与 Release）不吃它 ——
   「registry 上有没有这个版本」与「git 侧有没有 tag / Release」是两件独立的事实。拿它当那两步的
   前提，「publish 成功、后面某步失败」就永远补不回来（重跑时 `exists` 已是 `true`，两步被跳过）；
   那两步各自内部幂等，「已存在」由它们自己处理。
9. `npm publish --provenance --tag <dist-tag>`。
10. 打 `v<version>` tag 并**只推这个 tag**；tag 已存在则跳过。
11. 建 GitHub Release：**正文两级 —— 先读 Release Drafter 的 `next` 草稿，草稿空则回落
    `--generate-notes`**；并显式区分「草稿读不到」（配置坏了，发 `::warning::`）与
    「草稿读到了但没有条目」（正常）。**建之前先 `gh release view` 判存在**：已存在就跳过，
    并置 `created=false`（下面删草稿那步靠它区分「这次真的建了」与「已存在、正文没被取走」）。
12. 让位草稿：删掉 Drafter 的 `next` 草稿（下一批合并后它会重建）。

`dry-run` 输入只做检查与打包，不发布也不打 tag。

### 草稿的读 / 写 / 删

正文由 Release Drafter 维护，滚动 tag 名 `next`（永不与 `v<版本>` 相撞，所以上面那道存在性判断
不会命中草稿）。三步：

- **读**：`gh release view next --json body --jq '.body'`。读到就用它建 Release；读不到、或读到了但
  没有条目，回落 `--generate-notes`。**两种情况要分开报**：读不到是**配置坏了**（tag 改名、action
  没跑、权限不足，发 `::warning::`），读到了但为空是**正常**（本版没有带标签的 PR）—— 不区分的话，
  「发版成功但正文其实走了回落」是静默失败。
- **写**：只按 action 名清洗草稿行（`sed '/Release Drafter/d'`），**不照抄那句提示语的全文**。
  那句话归组织仓的模板所有、随时会被改写；照抄一句就会在模板改词之后**匹配不到**，而 `sed`
  匹配不到不会报错 —— 提示语会静默留在正文里。
- **删**：正文取走之后必须把草稿让位，否则下一次发版读到的是**上一批**的正文（草稿停在旧分界，
  表面上还「有内容」，属静默错）。删的条件三条，缺一不可：`!inputs.dry-run`（dry-run 不建任何
  正式版，此时删掉草稿那批正文就**永久丢了**）、正文来源是草稿（回落 `--generate-notes` 时草稿
  没被消费）、`created == 'true'`（Release 已存在而跳过时正文并没被取走，删草稿同样是**永久丢正文**
  —— 这正是 tag 触发后重跑会走到的分支）。

只删 tag 不以 `v` 开头的那一个草稿：不按标题匹配，也不碰任何 `v<版本>` 的正式版
（`gh release delete <tag>` 默认连带删 tag，这里显式关掉）。

## 产物是构建出来的：**发布链路必须自己构建**

`main` 与 `exports` 指向 `lib/`，而 **`/lib/` 是构建产物、被 `.gitignore` 忽略** ——
**检出里没有它**。所以「CI 上能跑测试」不等于「CI 上能发出一个能用的包」：不构建就 publish，
发出去的 tarball **一行代码都没有**。

**判例（2026-10-13，`0.2.0`）**：这是本仓第一次真跑发布流程，就把这个洞打出来了 ——
`release.yml` 当时只有 `npm ci` → typecheck → test → `check:release` → publish，**没有 build**。
结果 `0.2.0` 的 tarball **只有 9 个文件**（`LICENSE` / 两份 locale / `package.json` / 两份 README /
`SKILL.md` / `icon.svg` / `cordis.patch.yml`），**没有 `lib/`** → 装上去连入口都解析不到。
对照：手动构建后发的 `0.1.0` 是 **53 个文件**。
**症状是静默的**：包里 `cordis.patch.yml` 在、宿主照样把这一行插进树，然后 import 失败 ——
正是「行在、功能不在」那个形状。

**这一仓当时没有构建机制，而同工作区另外三个仓各有一种**（机制可以不同，事实必须成立）：

| 机制 | 形态 |
|---|---|
| release.yml 里显式一步 | `- run: pnpm run build`（放在 publish 之前） |
| `test` 脚本先构建 | `test = pnpm run build && vitest run`，而发布流程会跑 `test` |
| `prepare` / `prepack` 先构建 | 包管理器在打包前自动跑它 |

**前两种对「跑测试的那条链」有好处**：CI 与发布都经过它，`lib/` 必然存在。
第三种只在打包那一刻生效 —— **测试仍在无产物的树上跑**，本仓特意选了显式一步（测试与发布看到的是同一棵树）。

**两条守卫**（`scripts/check-release.mjs` 里标号为 11 / 12 的那两条）：

- **第 11 条（机制）**：publish 之前**一定会构建** —— 三种机制认其一，不锁定写法，改机制不该把它判红。
  这条能被 `pnpm test` 直接跑到，**不必等一次真发布**（真发布只能在 main 上 dispatch，代价太大）。
- **第 12 条（事实）**：`main` 指向的入口文件在磁盘上。**条件式**，分三种情形：
  入口在 → ok；**产物目录在而入口不在 → 判红**（构建跑过却没产出入口，那是故障）；
  **两者都不在 → 只记 note**（还没构建的检出，例如 `git archive` 出来的副本、红线 A5 用的干净副本）。
  一律判红会把「还没构建」也判红，而那种红会训练人忽略这道守卫。

**发版前手动核一次产物**（比守卫更直接，且能看见文件名）：

```shell
npm pack --dry-run          # 看清单里有没有 lib/ 与 skills/
```

**发现发错了怎么办**：**不发 unpublish**（见文末「发布后缺陷处理」），
**立即发 patch 版本修掉**（新版本一上，`latest` 就指回可用的那个），
并给坏版本打 `deprecated`。⚠️ **`npm deprecate` 要一个本机 token，而本仓刻意不在本机放凭据**
（发布走 Trusted Publisher / OIDC）—— 所以这一步**要么维护者手动做，要么另开一条带凭据的路径**，
别以为它会自己发生。

## tag 与 Release 的形状

- **tag 名 = `v` + `package.json` 里的版本号**（如 `v0.2.0`），前缀由 workflow **显式补**。
  这是**形状判据，不是审美**：release-guard 与兼容巡检用
  `git describe --match 'v[0-9]*'` 看 tag，**不带 `v` 的 tag 那个 `--match` 看不见**。
  换版本号的来源时（`npm version` 的输出自带 `v`，读 `package.json` 则没有）形状会跟着变，
  必须同批把前缀补上。推 tag 那条入口还会**先核对这一点**（tag / 清单一致性闸）：对不上就中止，
  不会发出一个 tag 名与内容不符的版本。
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
下一次按锁文件装（`npm ci` / `pnpm install --frozen-lockfile`）直接失败。正确动作四步：`npm deprecate <name>@<version> "原因与替代版本"`
→ 修 → 定档发新版本 → 在 tag 说明里写清影响范围与升级动作。

只有「发布后 72 小时内、且确认无人依赖」才考虑 unpublish；走这条例外要在提交信息里写明依据。
