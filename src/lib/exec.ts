/**
 * 子进程执行层 —— 唯一的 `node:child_process` 出口，且 `spawnImpl` 可注入。
 *
 * 为什么把执行收成一个接口：工具实现因此不碰 `node:child_process` 的具体形态，
 * 单测可以喂一个假的 spawn（不需要真跑 `dsh`，也不需要 mock 类）。
 *
 * 只读纪律：本层只提供「跑一条命令读它的输出」，**没有**任何写文件 / 杀进程的能力。
 */
import { spawn } from 'node:child_process'

/** 一条外部命令的结果。超时与取消**不抛异常**，而是把标志位带回给调用方。 */
export interface CommandResult {
  /** 退出码；进程未正常退出（被信号杀死 / spawn 失败）时为 `null`。 */
  code: number | null
  /** 标准输出（utf8）。 */
  stdout: string
  /** 标准错误（utf8）。 */
  stderr: string
  /** 是否因**传输层预算耗尽**被杀。 */
  timedOut: boolean
  /** 是否因**调用方取消**（`exec.signal`）被杀。 */
  aborted: boolean
  /** spawn 本身失败时的原因（例如可执行文件不存在）；正常退出为 `undefined`。 */
  spawnError?: string
}

/** 一条命令的完整调用参数。 */
export interface RunCommandOptions {
  readonly command: string
  readonly args: readonly string[]
  /** 本条命令的传输预算（毫秒）；调用方负责让它小于工具预算。 */
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly cwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}

/** 可注入的 spawn：测试喂假实现，生产用 {@link defaultSpawnImpl}。 */
export type SpawnImpl = (options: RunCommandOptions) => Promise<CommandResult>

/**
 * 生产实现：`spawn` + 手写超时与取消。
 *
 * 不用 `spawn` 自带的 `signal` 选项，是为了同时拿到「超时」与「取消」两个**不同的**
 * 标志：两者的正确反应不同（超时 → 可重试；取消 → 不可重试），混成一个看不出来。
 *
 * @param options 命令与预算。
 */
export const defaultSpawnImpl: SpawnImpl = async (options) => {
  // 已经取消就别起进程：起了也只会立刻被杀，白留一个副作用窗口。
  if (options.signal?.aborted === true) {
    return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true }
  }

  return await new Promise<CommandResult>((resolve) => {
    let settled = false
    let timedOut = false
    let aborted = false

    const child = spawn(options.command, [...options.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    const finish = (result: Pick<CommandResult, 'code'> & { spawnError?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, timedOut, aborted, ...result })
    }

    // `kill()` 在进程已退出时是空操作，但个别平台会抛 —— 包起来免得盖住真正的结果。
    const kill = (): void => {
      try {
        child.kill()
      } catch {
        // 已经退出了：结果由 close 事件给出。
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutMs)

    const onAbort = (): void => {
      aborted = true
      kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error: Error) => {
      // 加前缀是为了让调用方能把「起不来」与「跑完但非零退出」分开：
      // 前者该报 `not-configured`（可执行文件不在），后者该报 `command-failed`。
      finish({ code: null, spawnError: `spawn: ${error.message}` })
    })
    child.on('close', (code: number | null) => {
      finish({ code })
    })
  })
}

/**
 * 跑一条命令。
 *
 * @param options 命令与预算。
 * @param spawnImpl 可注入的实现；默认生产实现。
 */
export function runCommand(
  options: RunCommandOptions,
  spawnImpl: SpawnImpl = defaultSpawnImpl,
): Promise<CommandResult> {
  return spawnImpl(options)
}
