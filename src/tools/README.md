# tools/ — 工具半边

- 职责：本插件对外的全部能力，每个工具一个文件，注册在聚合入口。
- 工具分三种角色：只读诊断、写侧（改运行中的树）、派生（返回值里经手秘密）。角色判据、边界与未做工具的归属见 [../../docs/SHAPE.md](../../docs/SHAPE.md)。
- 输出契约 = `{ verdict, key, audit }`，成功失败同形；冻结签名与字段角色见 [../../docs/SHAPE.md](../../docs/SHAPE.md)，`error.message` 不进模型文本。
- 工具实现不依赖 Cordis：共享依赖（配置、子进程、HTTP、loader 树）与输出契约由本目录的共享模块组装，生命周期与注册只发生在聚合入口。
- 工具清单、注册顺序与依赖装配以本目录的聚合入口为准，本文不复制清单。
- 变更影响路由：改这里 → 同步 [../../docs/SHAPE.md](../../docs/SHAPE.md) 的契约与 [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 的设计理由；覆盖映射见 [../../test/tools/README.md](../../test/tools/README.md)；必跑 `pnpm run test`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)；根规则见 [../../AGENTS.md](../../AGENTS.md)。

## 共享助手住在哪

跨工具的语义各只有**唯一实现**，住处见下表；工具文件里出现第二份即为违例（规则与判据见 [AGENTS.md](AGENTS.md) 的 B30 那条）。

| 类 | 助手 | 作用 |
|---|---|---|
| 装配 | `withHomeOverride` / `withCallHome` / `spawnWithHome` / `childEnvFor` | 把本次调用的 `dshHome` 同时叠进**配置**与**子进程环境**（两层必须同改） |
| 投影 | `effectiveConfig` / `resolvePort` | 把「这次实际用的是哪份配置、哪个端口」摊成可见证据 |
| 渲染 | `resolvedLine` / `guardFallbackLine` / `guardKeyLines` | L2 的 `resolved:` 行、守卫兜底行、以及「key 不是对象时印什么」的判定（模型在工具之间读的是同一张脸） |
| 语义 | `spawnFailureOf` / `spawnFailureMessage` / `homeRetryArg` | 起不了 `dsh` 的 kind 映射与 message 模板、跨实例重试要不要带 `dshHome` 的判定 |
| 通用 | `asAudit` / `oneLine` / `toOutput` / `toolOutput` / `CANCELLED_MESSAGE` / `CANCELLED_WHY` | 类型边界转型、L2 单行化、返回值收敛、取消语义的一对模板 |

`resolvedLine` 的字段顺序、端口取舍与逐字段防御都在这一处；各工具**只决定要不要端口 / 目录**，不自己拼字符串。落点不都在 `shared.ts`：取异常 code 的正典在 `../lib/errors.ts`，relaunch 措辞的正典在 `../lib/carrier.ts` —— B30 按「名/片段 → 唯一落点」判，不按「只许在 shared.ts」判。
