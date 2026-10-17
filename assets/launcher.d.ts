/**
 * `assets/launcher.js` 的类型声明。
 *
 * 这个文件是**发布资产**（会被计划任务直接执行），所以它自己是纯 JS —— 不经过本仓的
 * 编译流程。类型放在这里有两件事同时成立：
 *
 * 1. 测试与任何 TypeScript 消费者拿到**真类型**，而不是一串隐式 `any`（后者会让
 *    「替身被静默丢弃」那类假绿重新长出来，坑 40）；
 * 2. 这份声明就是它的**契约**：作业文件有哪些键、哪些副作用可注入，都写在这里。
 */

/** spawn 的选项子集（只声明本文件真正用到的那些）。 */
export interface SpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  detached?: boolean
  windowsHide?: boolean
}

/** 子进程的最小子集：只需要 pid 与 `unref`。 */
export interface SpawnedChild {
  pid?: number
  unref: () => void
}

/** 一次 spawn 的记录（测试替身用）。 */
export type SpawnCall = [command: string, args: readonly string[], options: SpawnOptions]

/** 可注入的 spawn 实现。 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedChild

/** 作业文件的解析结果：键 → 值（值一律是字符串）。 */
export type JobFile = Record<string, string>

/** `runLauncher` 的可注入副作用（测试用替身）。 */
export interface LauncherDeps {
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  spawn?: SpawnImpl
  say?: (logPath: string, message: string) => void
  readPid?: (path: string) => number
}

/** 一次拉起的结论。 */
export interface LauncherOutcome {
  launched: boolean
  stopWindow?: { launched: boolean; existing: number }
}

/**
 * 把作业文件的 `key=value` 文本解析成对象。
 *
 * 只按**第一个** `=` 切分，所以值里可以有 `=`；空行与 `#` 开头的行被跳过。
 */
export declare function parseJobFile(text: string): JobFile

/** 往日志追加一行时间戳记录；永不抛异常（无人值守路径）。 */
export declare function say(logPath: string, message: string): void

/**
 * 轮询等一个 pid 消失，**上限**是 `capMs`（不是固定睡眠）。
 *
 * 一消失就返回，所以常见路径远快于上限；pid 被复用时只会多等，方向安全。
 */
export declare function waitForExit(
  pid: number,
  capMs: number,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<{ gone: boolean; waited: number }>

/** 默认的存活探针：该 pid 还有进程吗。 */
export declare function defaultIsAlive(pid: number): boolean

/**
 * 以 argv 数组起新宿主（不走 shell），注入 `DSH_HOME` 与 `DSH_DEBUG_WINDOWLESS`，
 * 并带 `windowsHide`（⇒ `CREATE_NO_WINDOW`，不会有控制台）。
 */
export declare function startHost(job: JobFile, spawnImpl?: SpawnImpl): SpawnedChild

/**
 * 确保这个端口有**恰好一个**停止窗口。
 *
 * 记下的 pid 还活着就什么都不做（这就是「N 次重启只有一个窗口」）。
 * ⚠️ 只把**路径**传给 VBS 那一跳，绝不传命令行。
 */
export declare function ensureStopWindow(
  job: JobFile,
  isAlive: (pid: number) => boolean,
  spawnImpl?: SpawnImpl,
  deps?: { readPid?: (path: string) => number },
): { launched: boolean; existing: number }

/** 读 pidfile；文件不在 / 内容非法 ⇒ 0（不抛）。 */
export declare function readPidFile(path: string): number

/** 整条仪式：等旧进程 → 起宿主 → 确保停止窗口。 */
export declare function runLauncher(job: JobFile, deps?: LauncherDeps): Promise<LauncherOutcome>
