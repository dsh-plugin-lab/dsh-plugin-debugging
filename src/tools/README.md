# tools/ — 工具半边

- 职责：本插件对外的全部能力，每个工具一个文件，注册在聚合入口。
- 工具分三种角色：只读诊断、写侧（改运行中的树）、派生（返回值里经手秘密）。角色判据、边界与未做工具的归属见 [../../docs/SHAPE.md](../../docs/SHAPE.md)。
- 输出契约 = `{ verdict, key, audit }`，成功失败同形；冻结签名与字段角色见 [../../docs/SHAPE.md](../../docs/SHAPE.md)，`error.message` 不进模型文本。
- 工具实现不依赖 Cordis：共享依赖（配置、子进程、HTTP、loader 树）与输出契约由本目录的共享模块组装，生命周期与注册只发生在聚合入口。
- 工具清单、注册顺序与依赖装配以本目录的聚合入口为准，本文不复制清单。
- 变更影响路由：改这里 → 同步 [../../docs/SHAPE.md](../../docs/SHAPE.md) 的契约与 [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 的设计理由；覆盖映射见 [../../test/tools/README.md](../../test/tools/README.md)；必跑 `pnpm run test`。
- 使用约束与工作偏好 → 见 [AGENTS.md](AGENTS.md)；根规则见 [../../AGENTS.md](../../AGENTS.md)。

## 共享助手住在哪

三类语义 + 一组通用助手，各只有**唯一实现**，都住在 `shared.ts`；工具文件里出现第二份即为违例（规则见 [AGENTS.md](AGENTS.md)）。

| 类 | 助手 | 作用 |
|---|---|---|
| 装配 | `withHomeOverride` / `withCallHome` / `spawnWithHome` / `childEnvFor` | 把本次调用的 `dshHome` 同时叠进**配置**与**子进程环境**（两层必须同改） |
| 投影 | `effectiveConfig` / `resolvePort` | 把「这次实际用的是哪份配置、哪个端口」摊成可见证据 |
| 渲染 | `resolvedLine` / `guardFallbackLine` | L2 的 `resolved:` 行与守卫兜底行（模型在工具之间读的是同一张脸） |
| 通用 | `asAudit` / `oneLine` / `toOutput` / `toolOutput` | 类型边界转型、L2 单行化、返回值收敛 |

`resolvedLine` 的字段顺序、端口取舍与逐字段防御都在这一处；各工具**只决定要不要端口 / 目录**，不自己拼字符串。
