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
3. FORMAT 片段判**逐字**子串 ⇒ 「换一种说法的同一件事」照不到（**已知限制，不修**：要修得上 AST）。

⇒ ①② 已把扫描面改成整个 `src`（`src/client` 除外，B14 同此分法）。

### 二、高优先级缺陷（**全部在 B30 原扫描面之外**）

| id | 内容 | 份数 | 判定 |
|---|---|---|---|
| **B5** | `no relaunch route has been verified on …` | 2 + 1 截断版 | **缺陷**，见下 |
| **A6** | 取 `error.code`：正典 + 3 份**弱化**副本 | 4 | **缺陷**，见下 |
| **B4** | `ENOENT ⇒ not-configured / 其它 ⇒ internal` + `cannot start dsh: ` | 2 | 缺陷 |
| **B1** | 取消语义 `nextStep.why` | 7 | 缺陷 |
| **B2** | 取消语义 `error.message` | 5 | 缺陷 |
| **B3** | `if (!key \|\| typeof key !== 'object') return [GUARD_FALLBACK_LINE]` | 5 + **1 走样** | 缺陷 |
| **B6** | `retryArgs` 同名同规则两份 | 2 | 缺陷 |
| A1 | `messageOf` | 5 逐字 + 6 内联 | 缺陷 |
| A2 | `iterate`（21 行生成器） | 2 | 缺陷 |
| A3 | `asRecord`×3 / `asFunction`×2 / `asString`×2 / `isString`×2 | 9 | 缺陷 |
| A4 | `isAborted` | 2 | 缺陷 |
| A7 | `${code}: ${message}` 形状 | 2 | 缺陷·轻度 |
| B7 / B8 | `'dshHome is empty'` / `` `authority: ` `` | 2 / 2 | 缺陷·轻度 |
| B10 | `dshHome` 参数描述收尾句 `Omit to use…` vs `Omit for…` | 3 / 1 | 主体有意，收尾**缺陷** |
| D1 | 描述骨架断言在 4 个工具测试里逐字重复 | 4 + 3 变体 | 缺陷（红线 B20a 已有更全实现） |
| D4 | `diagnose-plugin-load.test.ts` 内重夹具 | 14 + 3 | 缺陷 |
| D5 | `redlines.test.ts` 内清单两份 | 2 + 2 | 缺陷·轻度 |

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

暂无（本文只记清点结果与优先级）。

## 影响

- 本仓还有一批「同一语义多落点」未修，**优先级 B5 > A6 > B4 > B1/B2 > B3 > B6**。
- 每修一批，把对应名字/片段加进 B30 的两个闭集 —— 否则修完还会再长回来。
- 限度（如实记）：`src/lib/ports.ts`（1199 行）/ `startup-log.ts`（853）/ `hot-reload.ts`（1507）
  是分段人工读 + 机器扫描交叉验证，**未逐行通读** ⇒ 那三个文件里「换一种说法的同一件事」可能仍有漏。
  机器扫描对**语义级重复**（同一断言换写法）同样照不到。