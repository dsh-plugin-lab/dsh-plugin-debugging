# 依据：全仓重复语义清点（2026-10-16）

状态：生效

## 背景

红线 B30 落地时只扫 `src/tools` 下含 `dsh_` 的文件。为确认「还有多少同族重复」，做了一次
全仓清点：`src/**` 36 文件 / 19,075 行，`test/**` 26 文件 / 23,635 行，合计 62 文件。
手段：四类机器扫描（字符串字面量跨文件去重 ≥15 字符 / 3–4 行归一化代码块 / 函数体逐字 / 名+体）
覆盖全部，另人工通读 `src` 33 个全文、`test` 12 个关键段。

## 结论

### 一、B30 的三个盲区（已修前两个）

`test/redlines.test.ts` 的 B30 原先只扫 `src/tools` 且只认文件名含 `dsh_` 的：

1. `src/lib` 整层在门外 —— **而重复最多的恰在那里**；
2. `src/tools/{index,describe}.ts` 也在门外；
3. FORMAT 片段判**逐字**子串 ⇒ 「换一种说法的同一件事」照不到。**2026-10-17 拍板不修**：
   AST 级（ts-morph / compiler API）的语义等价判定没有便宜写法，且本仓大量**有意的相似**
   （三个 `omit for` 参数描述、C2 的 `'unknown'` 各表一格）会被相似度误伤 —— 判据写进
   B30 的注释（检索串「已知限制」），真出现漏网再评估。

⇒ ①② 已把扫描面改成整个 `src`（`src/client` 除外，B14 同此分法）。

### 二、高优先级缺陷（**全部在 B30 原扫描面之外**）

| id | 内容 | 份数 | 判定 |
|---|---|---|---|
| ~~**B5**~~ | ~~`no relaunch route has been verified on …`~~ | — | ✅ **已修**（PR #52，正典 `carrier.ts`） |
| ~~**A6**~~ | ~~取 `error.code` 弱化副本~~ | — | ✅ **已修**（PR #52，改用正典） |
| ~~**B4**~~ / ~~**B1**~~ / ~~**B2**~~ | ~~spawn kind 映射~~ / ~~取消 why~~ / ~~取消 message~~ | — | ✅ **已修**（PR #53，正典 `shared.ts`） |
| ~~**B3**~~ / ~~**B6**~~ | ~~兜底 keyText~~ / ~~retryArgs 规则~~ | — | ✅ **已修**（PR #54，正典 `shared.ts`；effect_mode 的 `return []` 违约同批修正） |
| ~~A1~~ | ~~`messageOf`~~ | ~~5+6~~ | ✅ **已修**（正典 `errors.ts`；B30 揪出审计漏数的 lib 侧 4 份，一并收敛） |
| ~~A3~~ / ~~A4~~ | ~~`asRecord` 族 / `isAborted`~~ | — | ✅ **已修**（正典 `errors.ts`） |
| ~~A2~~ | ~~`iterate`（21 行生成器）~~ | — | ✅ **已修**（PR #57：判定逐字相同、import 无环，正典 `loader.ts`） |
| ~~A7~~ | ~~`${code}: ${message}` 形状~~ | — | ✅ **判定不同义不修**（PR #57：兜底链不同，两处记差异注释；顺手修 restart-fs 的 A6 同族弱化副本） |
| ~~B7 / B8~~ | ~~`'dshHome is empty'` / `` `authority: ` ``~~ | — | ✅ **已修**（PR #57：正典 `restart.ts` / `shared.ts`） |
| ~~B10~~ | ~~`dshHome` 参数描述收尾句分歧~~ | — | ✅ **已修**（PR #57：收尾对齐多数派，主体保持有意自含） |
| ~~D1~~ | ~~描述骨架断言逐字重复~~ | — | ✅ **已修**（PR #58：B20a 照不到的「合成器一致」收敛为 helper，逐字重复删留指针，特有形状保留；B20a 未动） |
| ~~D4~~ | ~~diagnose 重夹具 14+3~~ | — | ✅ **已修**（PR #58：`baseFixture` 工厂收敛 17 处，8 类特殊替身判可读性豁免，净 −257 行） |
| ~~D5~~ | ~~redlines 清单两份~~ | — | ✅ **判定各自闭集不修**（PR #57：8 工具名 vs 4 文件路径，粒度与覆盖面都不同） |

### 三、B5 与 A6 为什么排最前

**B5**：`src/lib/restart.ts` 的注释写着「三档措辞**只写在那里一处**」，而
`src/tools/dsh_restart.ts` 又自己拼了第二、第三处 ⇒ **注释是假话**，「一处一事实」在这句话上不成立。

**A6**：`src/lib/errors.ts` 的 `systemErrorCode` 是正典（显式读 `cause`，注释写明 `fetch` 把
`ECONNREFUSED` 包在 `TypeError` 的 `cause` 上）；而 `dsh_list_instances` 自己那份**只读顶层**，
那条路走的正是全局 `fetch`/undici ⇒ 真机 `ECONNREFUSED` 会退化成一句 `fetch failed`，
而同仓 `src/lib/http.ts` 走正典。**这是唯一有真机可观测语义差的一条。**

### 四、明确判为「有意」的（去重时别误伤）

- `resolvedLine` 薄适配器 2 份（B30 明写豁免）；
- **C2 全部 `'unknown'` 降级 —— 逐条核过，无一条缺陷**：它们不是同一语义（三值判定的一格 /
  YAML 缺 level 的占位 / carrier 的 `unrecognized`），本仓三值纪律要求彼此可分；
- 包名字面量 20 处 / 6 个常量（client 半边刻意不 import `package.json`；槽 key 与 loader entry id
  「今天同串却是两件事」）；
- 同文件内的 L1 开头模板（`nothing was restarted: ` × 5 等）—— 判定句式就是各工具的契约；
- `port` 参数描述 3 份逐字一致（**正面证据**：同参数同语义就该逐字同）；
- `FsRecorder` / 临时目录三件套 3 份（`install-anchor.test.ts` 已注释理由：并发写者下的隔离）。

### 五、建议进 B30 的清单（**加之前必须先修**，否则当场红）

- FORMAT：`cancellation is up to the caller; retrying the same call is pointless`、
  `the caller cancelled this execution`、`cannot start dsh: `、
  `no relaunch route has been verified on`、`if (!key || typeof key !== 'object')`、
  `Omit to use the configured one.`
- NAME：`retryArgs`、`systemErrorCodeOf`、`messageOf`、`asRecord`、`asFunction`、`asString`、
  `isString`、`isAborted`、`iterate`、`errorCodeOf`、`codeOf`

## 支撑的决策

- 高优先级批（B5/A6/B4/B1/B2）→ PR #52、#53；B3/B6 → PR #54；A1/A3/A4 → PR #56；src 侧轻度批（B10/B7/B8/A2 收敛、A7/D5 判定不修）→ PR #57；测试侧（D1/D4）→ PR #58。
- B30 的两轮设计修正（落点映射、FORMAT/NAME 边界）由本清单的修复批逼出，见红线文件 B30 注释；闭集随 PR #52–#57 五批扩充至 FORMAT 9 条 / NAME 22 条。

## 影响

- **清点表已全部闭环**（2026-10-17）：代码项 PR #52–#57，测试项 PR #58。剩余只有两条**待拍板的后续**：① 把「合成器与声明一致」升级进 B20a（一行断言照全仓）；② B30 的逐字片段限制（换说法照不到，要修得上 AST）。
- ~~每修一批，把对应名字/片段加进 B30 的两个闭集~~ —— 已执行三批（#52/#53/#54 + 本批），B30 现有闭集覆盖本清单全部已修项。
- 限度（如实记）：`src/lib/ports.ts`（1199 行）/ `startup-log.ts`（853）/ `hot-reload.ts`（1507）
  是分段人工读 + 机器扫描交叉验证，**未逐行通读** ⇒ 那三个文件里「换一种说法的同一件事」可能仍有漏
  （A1 的 lib 侧 4 份就是 B30 落地后才揪出来的实证）。机器扫描对**语义级重复**（同一断言换写法）同样照不到。