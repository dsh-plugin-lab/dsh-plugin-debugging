/**
 * `test/tools/**` 的共用夹具。
 *
 * 两条纪律：
 * 1. **不依赖真机**：`$DSH_HOME` 用临时目录现造，profile / 凭证 / 日志都是写出来的假文件；
 * 2. **不 mock 类**：外部 IO 只从注入点进（`spawn` / `fetch`），
 *    其余（文件系统）用真的 —— 打真文件比打替身更能照出路径拼接的错。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach } from 'vitest'

import type { ResolvedConfig } from '../../src/contracts.ts'
import type { CommandResult, RunCommandOptions, SpawnImpl } from '../../src/lib/exec.ts'
import type { FetchImpl } from '../../src/lib/http.ts'
import { createToolDeps, type ToolDeps } from '../../src/tools/shared.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ToolResult } from '../../src/lib/errors.ts'

/** 建过的临时目录，测试结束统一清掉。 */
const created: string[] = []

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** 造一个临时 `$DSH_HOME`。 */
export async function tempDshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-debug-test-'))
  created.push(dir)
  return dir
}

/** 写一个 JSON 文件（自动建父目录）。 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2))
}

/** 写一个文本文件（自动建父目录）。 */
export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** 建一个目录软链（Windows 上用 junction，不需要管理员权限）。 */
export async function linkDir(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await symlink(target, path, 'junction')
}

/** 写一份 profile 的 `package.json`。 */
export async function writeProfile(
  dshHome: string,
  profile: string,
  value: { bundles?: string[]; dependencies?: Record<string, string> },
): Promise<string> {
  const dir = join(dshHome, 'profiles', profile)
  await writeJson(join(dir, 'package.json'), {
    name: `dsh-profile-${profile}`,
    dsh: { profile: { bundles: value.bundles ?? [] } },
    dependencies: value.dependencies ?? {},
  })
  return dir
}

/**
 * 造一个已安装的包（`node_modules/<pkg>` + 产物文件）。
 *
 * @param profileDir profile 目录。
 * @param packageName 包名。
 * @param options `entry` 为假时不写产物文件（用来造「entry 不在」）。
 */
export async function writeInstalledPackage(
  profileDir: string,
  packageName: string,
  options: { entry?: string; writeEntryFile?: boolean; patch?: string } = {},
): Promise<string> {
  const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
  const entry = options.entry ?? './lib/index.js'
  await writeJson(join(packageDir, 'package.json'), {
    name: packageName,
    version: '0.0.1',
    main: entry,
    ...(options.patch === undefined ? {} : { dsh: { bundle: { patch: options.patch } } }),
  })
  if (options.writeEntryFile !== false) await writeText(join(packageDir, entry), '// 产物\n')
  if (options.patch !== undefined) await writeText(join(packageDir, options.patch), '[]\n')
  return packageDir
}

/** 造配置。 */
export function configFor(
  dshHome: string,
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return { dshHome, profile: 'web', port: 0, timeoutMs: 15_000, ...overrides }
}

/** 造 deps（IO 用假实现，其余默认）。 */
export function depsFor(
  config: ResolvedConfig,
  overrides: {
    spawn?: SpawnImpl
    fetch?: FetchImpl
    env?: NodeJS.ProcessEnv
    now?: () => number
  } = {},
): ToolDeps {
  return createToolDeps(config, {
    spawn: overrides.spawn ?? neverSpawn(),
    fetch: overrides.fetch ?? neverFetch,
    env: overrides.env ?? {},
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  })
}

/** 一次只会失败的 spawn：测试里没显式给 spawn 时用它，避免真起进程。 */
export function neverSpawn(): SpawnImpl {
  return async () => {
    throw new Error('测试未提供 spawn 实现：这条路径不该起子进程')
  }
}

/** 一次只会失败的 fetch。 */
export const neverFetch: FetchImpl = async () => {
  throw new Error('测试未提供 fetch 实现：这条路径不该发 HTTP')
}

/** 记录调用的 spawn 包装。 */
export interface RecordingSpawn {
  spawn: SpawnImpl
  calls: RunCommandOptions[]
}

/**
 * 造一个「按调用脚本返回结果」的 spawn，并记录每次调用参数。
 *
 * @param handler 根据参数给结果。
 */
export function recordingSpawn(
  handler: (options: RunCommandOptions) => CommandResult | Promise<CommandResult>,
): RecordingSpawn {
  const calls: RunCommandOptions[] = []
  return {
    calls,
    spawn: async (options) => {
      calls.push(options)
      return await handler(options)
    },
  }
}

/** 造一个成功的命令结果。 */
export function cmdResult(partial: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, ...partial }
}

/** 造一个 exec（只需要 signal）。 */
export function execWith(signal: AbortSignal = new AbortController().signal): ToolRunContext {
  return { signal } as unknown as ToolRunContext
}

/**
 * 造一个「一用就过期」的时钟。
 *
 * 为什么要它：`defineTool` 拒绝非正的 `timeoutMs`（实测
 * `defineTool(x): timeoutMs must be a positive finite number`），所以
 * **不能**用 `timeoutMs: 0` 去构造「预算已耗尽」。改成让时钟第二次读就跳过一个完整预算：
 * `createDeadline` 第一次读作为基准，之后 `elapsed >= totalMs` → `expired()` 立刻为真。
 *
 * @param totalMs 配置里的工具预算。
 */
export function jumpingClock(totalMs: number): () => number {
  let calls = 0
  return () => {
    calls += 1
    return calls === 1 ? 0 : totalMs + 1
  }
}

/** 跑一个工具并拿到结构化结果。 */
export async function run(
  tool: ToolDefinition,
  args: unknown,
  exec: ToolRunContext = execWith(),
): Promise<ToolResult<unknown>> {
  return (await tool.execute(args, exec)) as unknown as ToolResult<unknown>
}

/** 断言成功并取出 `data`。 */
export function expectOk(result: ToolResult<unknown>): Record<string, unknown> {
  if (!result.ok) throw new Error(`期望成功，实际失败：${JSON.stringify(result.error)}`)
  return result.data as Record<string, unknown>
}

/** 断言失败并取出 `error`。 */
export function expectFail(result: ToolResult<unknown>): {
  kind: string
  message: string
  hint: string
} {
  if (result.ok) throw new Error(`期望失败，实际成功：${JSON.stringify(result.data)}`)
  return result.error
}
