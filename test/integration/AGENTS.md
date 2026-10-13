# integration/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

括号里的编号指 [../../AGENTS.md](../../AGENTS.md) 的活跃坑。

integration/ 特有约束：

- 本目录是**本机红线**，不进 CI：它要求本机装了宿主、能建目录 junction、有空闲端口并真起一个服务。判据与跑法见 [README.md](README.md)。
- 本目录的 `.ps1` 必须是 UTF-8 **with BOM**。无 BOM 时 Windows PowerShell 5.1 按 GBK 解码中文注释直接解析失败，而报错看起来像语法错（坑 32）。
- 改完 `.ps1` 必须复核头三字节：`edit` 一类工具会剥掉 BOM，而 prettier 跳过 `.ps1`、CI 也不解析它，本机与 CI 全绿都照不出来（坑 38）。
- 变量名不许叫 `$Args` / `$Profile`，它们与 PowerShell 自动变量撞名，报错方向还偏（坑 29）。
- 绝不写死宿主 pid：按监听端口现查；查不到时是 fail-safe（一个都不杀），宁可留台子也不误杀主实例。
- 脚本必须自带 setup 与自还原，失败路径也走收尾；台子目录只落在工作区被忽略的路径下，不进任何仓库历史。
- 门禁只用 `--dump-config-schema` 的退出码；`--dump-config` 退出码恒 0，不能当门禁。
- 不写「验什么 / 怎么跑」，那是 [README.md](README.md) 的职责。
