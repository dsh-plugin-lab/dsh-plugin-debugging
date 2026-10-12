/**
 * 配置 schema —— 默认值同时是文档。
 *
 * 只放**值**，不放凭据：本插件读本机既有文件（`$DSH_HOME/.credentials.yaml`、
 * `startup-*.log`），自己不产生也不存任何密钥。
 *
 * 字段顺序无关紧要：`.default()` 与 `.volatile()` 各写各的 `meta` 键，没有先后约束
 * （已回源码核过，见 `.coord/recon-C-host-truth.md` 命题 7）。真正的约束是
 * `.volatile()` 只能落在固定对象路径上 —— 本 schema 全部是顶层标量，不受影响。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

import type { ResolvedConfig } from './contracts.js'

/** 用户在配置卡片里能改的东西。 */
export interface Config {
  /** DSH_HOME 目录；留空则取环境变量 `DSH_HOME`，再退回 `<homedir>/.dsh`。 */
  dshHome?: string
  /** profile 名；留空则取环境变量 `DSH_PROFILE`，再退回 `web`。 */
  profile?: string
  /** 宿主端口；`0` = 由工具从监听端口推断。 */
  port?: number
  /** 外部命令与 HTTP 探测的超时（毫秒）。 */
  timeoutMs?: number
}

export const Config = z.object({
  dshHome: z.string().default(''),
  profile: z.string().default(''),
  port: z.number().default(0),
  timeoutMs: z.number().default(15_000),
})

/** 默认 profile 名：`ctx.cmdlineArgs` **不含** `--profile`（启动器自己吃掉了），只能读 env。 */
export const DEFAULT_PROFILE = 'web'

/**
 * 默认 DSH_HOME：`<homedir>/.dsh`。
 *
 * **这不是我们发明的兜底**，而是宿主自己的默认值：本机实测 `DSH_HOME` 未设时宿主的 home 就是
 * `C:\Users\speak\.dsh`（`~/.dsh`），与官方 `@deepseek-ai/dsh-home-paths` 的解析一致。
 * 因此「读默认值」与「读宿主实际在用的值」在正常机器上指向同一处。
 */
export function defaultDshHome(): string {
  return join(homedir(), '.dsh')
}

/**
 * 把「可能没配」的配置补齐成工具半边要的形状。
 *
 * 不走 schema 的 `resolve()`：`apply()` 在单测里会被直接调用（宿主不在场），
 * 那时拿到的就是一个普通对象。这里显式兜底，让两条路径同形。
 *
 * **`dshHomeSource` 是给用户看的**：诊断工具最怕「看着成功其实读错了目录」。
 * 把「这个值是从配置来的、从环境变量来的、还是我们按默认值推的」显式带出去，
 * 读的是默认目录这件事本身就成了可见证据，而不是隐藏假设。
 *
 * @param config 宿主传来的（或单测里手写的）配置。
 * @param env 只用于测试注入；默认读 `process.env`。
 */
export function resolveConfig(
  config: Config | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const configuredHome = config?.dshHome ?? ''
  const envHome = env.DSH_HOME ?? ''
  const dshHome = configuredHome !== '' ? configuredHome : envHome !== '' ? envHome : defaultDshHome()
  const dshHomeSource: ResolvedConfig['dshHomeSource'] =
    configuredHome !== '' ? 'config' : envHome !== '' ? 'env' : 'default'
  const profile = config?.profile || env.DSH_PROFILE || DEFAULT_PROFILE
  return {
    dshHome,
    dshHomeSource,
    profile,
    port: config?.port ?? 0,
    timeoutMs: config?.timeoutMs ?? 15_000,
  }
}
