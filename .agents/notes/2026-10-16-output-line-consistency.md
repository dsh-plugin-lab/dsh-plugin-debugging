# 依据：跨工具输出的「同形」层没有判据，也没有索引（2026-10-16）

状态：生效

## 背景

维护者问「8 个工具的参数设计合不合理、哪些明显该改」，并要求「放弃既有纪律重新审视」。
连续几轮提案被代码与判据推翻，最后定位到的不是参数设计，而是**渲染层一致性这一档既没有判据、也没有索引**。

本文记的是那几轮核对的事实与被推翻的推论，避免下一个人重走。

## 结论

### 一、`resolvedLine` 在 6 个工具里各写一份，正常路径无判据覆盖

| 文件:行 | 形状 | 兜底 |
|---|---|---|
| `dsh_check_effect_mode.ts:930` | `profile=… dshHome=… (src)[ dir=…]` | 逐字段 `'unknown'` |
| `dsh_check_auth.ts:466` | `profile=… dshHome=… (src)[ port]` | `GUARD_FALLBACK_LINE` |
| `dsh_dump_config.ts:979` | `profile=… dshHome=… (src)` | 逐字段 `'unknown'` |
| `dsh_diagnose_plugin_load.ts:1177` | `profile=… dshHome=… (src)[ port][ dir]` | 逐字段 `'unknown'` |
| `dsh_sign_cookie.ts:417` | `profile=… dshHome=… (src) port=… (src)` | `GUARD_FALLBACK_LINE` |
| `dsh_restart.ts:1882` | **`dshHome=… profile=… (src)`**（顺序相反） | **无** |

**字段集合的差异是有意的**（各工具不碰端口 / 不读 profile 目录，各自带注释说明）。
**字段顺序与防御策略的差异没有依据**，其中 `restart` 是唯一无兜底的一个。

### 二、`GUARD_FALLBACK_LINE` 是 5 份逐字副本

`check_auth` / `diagnose` / `dump_config` / `sign_cookie` 各一份 `resolved: unknown (the guard synthesized this result)`；
`list_instances` 一份**内容不同**的 `scan: unknown (…)`。
零处引用共享常量。

### 三、B25 只管「兜底可渲染」，**明写不断言措辞一致** —— 但只针对兜底

`test/redlines.test.ts:5135-5138` 与 `:5597` 都写明：降级措辞是**各工具自己的契约，不是全局契约**。

⚠️ **这条容易被读成「全仓有意不统一输出」** —— 它针对的是兜底那一支。
正常路径的六份副本不属这条红线的范围，B16（恒定块）/ B21（`data` 形状闭集）也都不覆盖。
⇒ **「同形」这条约束只活在 `dsh_check_auth.ts:450` 的注释里**（「模型在两个工具之间读的是同一张脸」），无判据。

### 四、`dsh_restart` 的无兜底与一处已记载的历史崩溃同形状

`dsh_check_auth.ts:452` 注释：「字段一律按 `typeof` 防御取值：兜底合成的 `key` 里整块 `resolved` 都不在，直接取字段会当场抛（**这正是本工具过去在兜底路径上崩掉的原因**）」。
`dsh_restart.ts:1880` 只判 `!== undefined && !== null` 就直接取字段 ⇒ 兜底路径上会印出 `undefined` 逐字。

### 五、`src/tools/README.md` 缺「同一种语义住在哪」这一档

它只有 9 行（职责 / 契约 / 入口 / 变更路由）。
本轮反复「找不到」的四处知识，全部只存在于源码注释里：
`withCallHome` 是唯一装配点、`effectiveConfig` 是唯一投影点、`scope: 'cross-instance'` 是既有记号、`check_auth:450` 的同形要求。

## 支撑的决策

暂无（本文只记事实）。

## 影响

- 本仓有一条真实缺陷待修（`restart` 无兜底），属**行为变化** ⇒ 走 PR。
- 「同形」要不要落成判据（新红线）与要不要收成一处渲染，待维护者拍板。
- 若收成一处，`resolved:` 那一行的逐字形状会变 ⇒ 与 `GUARD_FALLBACK_LINE` 的逐字断言（`check-auth.test.ts:608` / `dump-config.test.ts:803` / `diagnose-plugin-load.test.ts:1006`）同批核。