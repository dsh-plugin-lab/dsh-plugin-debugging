/**
 * profile 与安装形态的只读读取。
 *
 * 全部只读：`readFile` / `readdir` / `lstat` / `stat`，**没有**任何写操作。
 * 路径一律由 `dshHome` + `profile` 拼出，不写死盘符。
 */
import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** `<dshHome>/profiles/<profile>`。 */
export function profileDir(dshHome: string, profile: string): string {
  return join(dshHome, 'profiles', profile)
}

/** `<dshHome>/logs`。 */
export function logsDir(dshHome: string): string {
  return join(dshHome, 'logs')
}

/** `<dshHome>/.credentials.yaml`。 */
export function credentialsPath(dshHome: string): string {
  return join(dshHome, '.credentials.yaml')
}

/** profile 的 `package.json` 里我们关心的字段。 */
export interface ProfileManifest {
  dir: string
  /** `dsh.profile.bundles`：有序 bundle 列表。 */
  bundles: string[]
  /** 完整 `dependencies`，用于判「已在依赖里」。 */
  dependencies: Record<string, string>
}

/**
 * 读 profile 的 `package.json`。
 *
 * @param dir profile 目录。
 * @returns manifest；文件不存在或不是合法 JSON 时返回 `undefined`。
 */
export async function readProfileManifest(dir: string): Promise<ProfileManifest | undefined> {
  const text = await readTextIfExists(join(dir, 'package.json'))
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const dsh = asRecord(record['dsh'])
    const profileSection = asRecord(dsh?.['profile'])
    const rawBundles = profileSection?.['bundles']
    const bundles = Array.isArray(rawBundles) ? rawBundles.filter(isString) : []
    const dependencies = asStringRecord(record['dependencies'])
    return { dir, bundles, dependencies }
  } catch {
    return undefined
  }
}

/** 安装形态。 */
export interface InstallShape {
  packageName: string
  /** `<profileDir>/node_modules/<pkg>` 的绝对路径。 */
  path: string
  exists: boolean
  /** `link`（本地目录 link）/ `copy`（registry 拷贝快照）/ `absent`。 */
  linkType: 'link' | 'copy' | 'absent'
  /** link 的目标（仓库路径）；只在 `linkType === 'link'` 时有值。 */
  target?: string
}

/**
 * 判一个包在 profile 里是 link 还是 copy（SKILL §3.2）。
 *
 * 这个判定的用途只有一个：**改源码要不要重装**。link 指向仓库，产物就是被读产物；
 * copy 是快照，改源码不影响已装副本。
 *
 * @param dir profile 目录。
 * @param packageName 包名（可含 scope）。
 */
export async function readInstallShape(dir: string, packageName: string): Promise<InstallShape> {
  const path = join(dir, 'node_modules', ...packageName.split('/'))
  // 不预设初值：`catch` 分支直接返回，所以**只有** lstat 成功那条路会用到这个值。
  // 写 `let link = false` 会得到一个永远不被使用的赋值（eslint `no-useless-assignment`），
  // 而且那个 `false` 会让读者以为「读不到 = 不是 link」，其实读不到是 `absent`。
  let link: boolean
  try {
    link = (await lstat(path)).isSymbolicLink()
  } catch {
    return { packageName, path, exists: false, linkType: 'absent' }
  }
  if (link) {
    let target: string | undefined
    try {
      target = await readlink(path)
    } catch {
      target = undefined
    }
    return {
      packageName,
      path,
      exists: true,
      linkType: 'link',
      ...(target === undefined ? {} : { target }),
    }
  }
  return { packageName, path, exists: true, linkType: 'copy' }
}

/** 已安装包的入口检查结果。 */
export interface EntryCheck {
  packageName: string
  packageDir: string
  version?: string
  /** `main`（或 `exports['.']` 的 import）指向的绝对路径。 */
  entry?: string
  entryExists: boolean
  /** 入口文件的 mtime（毫秒）；读不到时为 `undefined`。 */
  entryMtimeMs?: number
  /** `dsh.bundle.patch` 声明的 patch 文件绝对路径（单个）。 */
  patch?: string
  patchExists: boolean
}

/**
 * 检查已安装包的入口文件与 patch 文件**在不在**。
 *
 * 为什么这是必要的：组合期错被 `skipping` **整条丢弃**时插件会静默消失（SKILL §3.1），
 * 而「产物路径写错 / patch 文件漏发」是它最常见的两个成因。
 *
 * @param dir profile 目录。
 * @param packageName 包名。
 */
export async function checkInstalledEntry(dir: string, packageName: string): Promise<EntryCheck> {
  const packageDir = join(dir, 'node_modules', ...packageName.split('/'))
  const text = await readTextIfExists(join(packageDir, 'package.json'))
  if (text === undefined) {
    return { packageName, packageDir, entryExists: false, patchExists: false }
  }
  let record: Record<string, unknown> | undefined
  try {
    record = asRecord(JSON.parse(text))
  } catch {
    record = undefined
  }
  if (record === undefined) {
    return { packageName, packageDir, entryExists: false, patchExists: false }
  }

  const version = isString(record['version']) ? record['version'] : undefined
  const entryRelative = resolveEntry(record)
  const entry = entryRelative === undefined ? undefined : join(packageDir, entryRelative)
  const entryExists = entry !== undefined && (await exists(entry))
  const entryMtimeMs = entry === undefined ? undefined : await mtimeMsOf(entry)

  const bundle = asRecord(asRecord(record['dsh'])?.['bundle'])
  const rawPatch = bundle?.['patch']
  const firstPatch = Array.isArray(rawPatch) ? rawPatch.find(isString) : isString(rawPatch) ? rawPatch : undefined
  const patch = firstPatch === undefined ? undefined : join(packageDir, firstPatch)
  const patchExists = patch !== undefined && (await exists(patch))

  return {
    packageName,
    packageDir,
    ...(version === undefined ? {} : { version }),
    ...(entry === undefined ? {} : { entry }),
    entryExists,
    ...(entryMtimeMs === undefined ? {} : { entryMtimeMs }),
    ...(patch === undefined ? {} : { patch }),
    patchExists,
  }
}

/**
 * 取文件的 mtime（毫秒）。
 *
 * 「产物比进程新 = 宿主端跑的是旧产物」这条判据（SKILL §四）就靠它。
 *
 * @param path 文件路径。
 */
export async function mtimeMsOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/** 一条启动日志。 */
export interface StartupLog {
  name: string
  path: string
  sizeBytes: number
  mtimeMs: number
}

/**
 * 列 `$DSH_HOME/logs/startup-*.log`。
 *
 * **只在启动失败时生成**（SKILL §3.8）—— 所以「一条都没有」是好消息，不是缺数据。
 * 工具输出里必须把这句话说清楚，否则模型会把「空列表」读成「还没查」。
 *
 * @param dshHome DSH_HOME 目录。
 */
export async function listStartupLogs(dshHome: string): Promise<StartupLog[]> {
  const dir = logsDir(dshHome)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const logs: StartupLog[] = []
  for (const name of names) {
    if (!name.startsWith('startup-') || !name.endsWith('.log')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      logs.push({ name, path, sizeBytes: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // 读不到的条目直接跳过：列目录与 stat 之间文件可能被清掉。
    }
  }
  return logs.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

/** 从 profile 的**文件**里探测 hmr 的结果。 */
export interface HmrFileProbe {
  /** 有没有找到 hmr 的迹象。 */
  present: boolean
  /** 证据（人可复核）。 */
  evidence: string[]
}

/** hmr 所在的官方包名。 */
const HMR_PACKAGE = '@deepseek-ai/dsh-hmr'

/**
 * 从 profile 文件里探 hmr。
 *
 * 为什么先走文件而不是直接跑 `--dump-config`：文件判定**零子进程**、快，
 * 且 `hmr` 是随 bundle 装进来的，`bundles` 列表与 `node_modules` 都在本地。
 * 只有**否定**结论才值得再去跑一次 dump 复核（否定的代价大：它会让一切降级成重启）。
 *
 * @param dir profile 目录。
 */
export async function detectHmrFromProfileFiles(dir: string): Promise<HmrFileProbe> {
  const evidence: string[] = []
  const manifest = await readProfileManifest(dir)
  if (manifest !== undefined) {
    const fromBundles = manifest.bundles.filter((name) => name.includes('hmr'))
    for (const name of fromBundles) evidence.push(`dsh.profile.bundles 含 ${name}`)
    if (fromBundles.length > 0) return { present: true, evidence }
    const fromDeps = Object.keys(manifest.dependencies).filter((name) => name.includes('hmr'))
    for (const name of fromDeps) evidence.push(`dependencies 含 ${name}`)
    if (fromDeps.length > 0) return { present: true, evidence }
  }
  const installed = await exists(join(dir, 'node_modules', ...HMR_PACKAGE.split('/')))
  if (installed) {
    evidence.push(`node_modules 里装着 ${HMR_PACKAGE}`)
    return { present: true, evidence }
  }
  return { present: false, evidence }
}

/**
 * 读文件；不存在时返回 `undefined`（而不是抛）。
 *
 * @param path 文件路径。
 */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 文件是否存在。
 *
 * @param path 文件路径。
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 从 package.json 里解析包入口的相对路径。
 *
 * @param record package.json 内容。
 */
function resolveEntry(record: Record<string, unknown>): string | undefined {
  const main = record['main']
  if (isString(main)) return main
  const exportsField = record['exports']
  if (isString(exportsField)) return exportsField
  const root = asRecord(exportsField)?.['.']
  if (isString(root)) return root
  const importField = asRecord(root)?.['import']
  if (isString(importField)) return importField
  return undefined
}

/**
 * 取一个值的「记录」视图。
 *
 * @param value 任意值。
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 取一个值的字符串字典视图（丢掉非字符串项）。
 *
 * @param value 任意值。
 */
function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (record === undefined) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (isString(item)) result[key] = item
  }
  return result
}

/**
 * 是不是字符串。
 *
 * @param value 任意值。
 */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}
