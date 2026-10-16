/**
 * profile 与安装形态的只读读取。
 *
 * 全部只读：`readFile` / `readdir` / `lstat` / `stat`，**没有**任何写操作。
 * 路径一律由 `dshHome` + `profile` 拼出，不写死盘符。
 */
import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { asRecord, isString, messageOf } from './errors.js'

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

/** 一个「在不在」的**三值**判定：`unknown` 表示**没能查到**，不是「不存在」。 */
export type Presence = 'present' | 'missing' | 'unknown'

/**
 * 包是从哪条锚点解析到的。
 *
 * 宿主自己的顺序是「**安装锚点优先、profile 其次**」（`dsh-app-boot` 的 `resolveBundleDir`），
 * 所以这里也必须同序 —— 顺序反了会把官方包误判成「profile 本地没装」。
 */
export type ResolutionSource = 'installation' | 'profile' | 'unresolved'

/** `checkInstalledEntry` 的可选解析锚点。 */
export interface EntryCheckOptions {
  /**
   * dsh 安装处的 `package.json`（宿主的 `installAnchor`）。
   *
   * 省略时从**当前进程**认：本插件跑在宿主进程里，所以宿主入口脚本
   * （`process.argv[1]`）就是这条锚点的来源。认不出来时**不猜路径**，
   * 结果会退化成 `unknown`（不是 `missing`）。
   */
  installAnchor?: string
}

/** 一个包声明的 patch 文件。 */
export interface PatchFileCheck {
  /** 声明里的原始**包内相对路径**。 */
  file: string
  /** 它的绝对路径。 */
  path: string
  exists: boolean
}

/**
 * patch 声明的整体状态。
 *
 * 为什么不是一个布尔：宿主对 patch 的失败方式是**整层 skip**
 * （`skipping profile bundle …: dsh.bundle.patch must be a file path or a list of file paths`），
 * 而「没声明」「声明坏了」「查不到」与「文件真的不在」是四件不同的事。
 */
export type PatchState = 'present' | 'missing' | 'malformed' | 'undeclared' | 'unknown'

/** 已安装包的入口检查结果。 */
export interface EntryCheck {
  packageName: string
  /** `<profileDir>/node_modules/<pkg>`：**profile 本地**的期望路径（安装形态仍认这一处）。 */
  packageDir: string
  /** 真正解析到的包目录；解析不到时没有。 */
  resolvedDir?: string
  /** 从哪条锚点解析到的。 */
  resolvedFrom: ResolutionSource
  version?: string
  /** `main`（或 `exports['.']` 的 import / default）指向的**绝对**路径。 */
  entry?: string
  /**
   * 入口存在性（三值）。
   *
   * - `present`：清单写了入口、文件在；
   * - `missing`：清单写了入口、文件**不在**（这条会让组合层整条丢弃该插件）；
   * - `unknown`：包解析不到，或清单里没有我们能读出来的入口 —— 两者都**不许**当成「缺失」。
   */
  entryState: Presence
  /**
   * 兼容字段：`present` → `true`，`missing` → `false`，**`unknown` → 省略**。
   * 不许用 `false` 冒充「不存在」（缺 A 的假红就是从这里出去的）。
   */
  entryExists?: boolean
  /** 入口文件的 mtime（毫秒）；读不到时为 `undefined`。 */
  entryMtimeMs?: number
  /** 声明里**全部** patch 文件（有序；`dsh.bundle.patch` 是数组时不止一个）。 */
  patches: PatchFileCheck[]
  /** 声明里的**第一个** patch 文件（历史字段；单文件声明等价于全部）。 */
  patch?: string
  /** 兼容字段：全部声明都存在才 `true`；`malformed` / `unknown` 时省略。 */
  patchExists?: boolean
  /** patch 声明的整体状态（见 {@link PatchState}）。 */
  patchState: PatchState
}

/**
 * 检查已安装包的入口文件与 patch 文件**在不在**。
 *
 * 为什么这是必要的：组合期错被 `skipping` **整条丢弃**时插件会静默消失（SKILL §3.1），
 * 而「产物路径写错 / patch 文件漏发」是它最常见的两个成因。
 *
 * **包在哪里解析**：宿主不是只看 `<profileDir>/node_modules`，而是「安装锚点优先、profile 其次」。
 * 官方包（`@deepseek-ai/dsh-base` 这一类）**只**住在安装锚点下 —— 只看 profile 本地会把它们
 * 全部判成「缺文件」，而用户看到的是「你的插件缺文件」（缺 A 的假红）。
 * 这里照宿主的顺序走两条锚点，**解析不到时报 `unknown`**，绝不冒充「缺失」。
 *
 * @param dir profile 目录。
 * @param packageName 包名。
 * @param options 可选解析锚点（省略时从进程认）。
 */
export async function checkInstalledEntry(
  dir: string,
  packageName: string,
  options: EntryCheckOptions = {},
): Promise<EntryCheck> {
  const packageDir = join(dir, 'node_modules', ...packageName.split('/'))
  const resolved = await resolvePackageDir(dir, packageName, options)
  const base: EntryCheck = {
    packageName,
    packageDir,
    resolvedFrom: resolved.source,
    ...(resolved.dir === undefined ? {} : { resolvedDir: resolved.dir }),
    // 先声明「未知」，只有真的读出清单来才可能收紧成 present / missing。
    entryState: 'unknown',
    patches: [],
    patchState: 'unknown',
  }
  if (resolved.dir === undefined) return base

  const text = await readTextIfExists(join(resolved.dir, 'package.json'))
  let record: Record<string, unknown> | undefined
  try {
    record = text === undefined ? undefined : asRecord(JSON.parse(text))
  } catch {
    record = undefined
  }
  // 包目录解析到了、清单却读不出来：同样是**未知**，不是「缺文件」。
  if (record === undefined) return base

  const version = isString(record['version']) ? record['version'] : undefined
  const entryRelative = resolveEntry(record)
  const entry = entryRelative === undefined ? undefined : join(resolved.dir, entryRelative)
  const entryPresent = entry !== undefined && (await exists(entry))
  const entryState: Presence =
    entryRelative === undefined ? 'unknown' : entryPresent ? 'present' : 'missing'
  const entryMtimeMs = entry === undefined ? undefined : await mtimeMsOf(entry)

  const declaration = parsePatchDeclaration(asRecord(asRecord(record['dsh'])?.['bundle'])?.['patch'])
  const patches: PatchFileCheck[] = []
  for (const file of declaration.files) {
    const path = join(resolved.dir, file)
    patches.push({ file, path, exists: await exists(path) })
  }
  const patchState = patchStateOf(declaration, patches)
  const firstPatch = declaration.files[0]

  return {
    ...base,
    ...(version === undefined ? {} : { version }),
    ...(entry === undefined ? {} : { entry }),
    entryState,
    ...(entryState === 'unknown' ? {} : { entryExists: entryState === 'present' }),
    ...(entryMtimeMs === undefined ? {} : { entryMtimeMs }),
    patches,
    ...(firstPatch === undefined ? {} : { patch: firstPatch }),
    ...(patchState === 'malformed' || patchState === 'unknown'
      ? {}
      : { patchExists: patchState === 'present' }),
    patchState,
  }
}

/** 包目录的解析结果。 */
interface ResolvedPackageDir {
  /** 解析到的包目录；`unresolved` 时没有。 */
  dir?: string
  source: ResolutionSource
}

/**
 * 按宿主的顺序解析包目录：安装锚点优先、profile 其次（`dsh-app-boot` 的 `resolveBundleDir`）。
 *
 * @param dir profile 目录。
 * @param packageName 包名。
 * @param options 解析锚点。
 */
async function resolvePackageDir(
  dir: string,
  packageName: string,
  options: EntryCheckOptions,
): Promise<ResolvedPackageDir> {
  const anchors: Array<{ file: string; source: ResolutionSource }> = []
  const installAnchor = options.installAnchor ?? installationAnchorFromProcess()
  if (installAnchor !== undefined) anchors.push({ file: installAnchor, source: 'installation' })
  // profile 的 `package.json` 不必真的存在：Node 的解析只用它的**位置**往上走父级 `node_modules`。
  anchors.push({ file: join(dir, 'package.json'), source: 'profile' })
  for (const anchor of anchors) {
    const resolvedDir = await packageDirFromAnchor(anchor.file, packageName)
    if (resolvedDir !== undefined) return { dir: resolvedDir, source: anchor.source }
  }
  return { source: 'unresolved' }
}

/**
 * 从一条锚点解析出包目录。**绝不抛。**
 *
 * 两步：
 * 1. `createRequire(anchor).resolve('<pkg>/package.json')` —— Node 会向上走父级
 *    `node_modules`，这就是「安装锚点」的自然取法，不需要我们猜任何盘符；
 * 2. 取不到时退到宿主的算法 `require.resolve.paths('<pkg>')` 再逐个查 `package.json` ——
 *    有些包的 `exports` **不暴露** `./package.json`，而宿主明说解析**不要求**包导出它
 *    （`packageDirFromAnchor` 用的正是第 2 步这个形状）。
 *
 * @param anchor 锚点文件（`package.json` 的绝对路径，文件本身不必存在）。
 * @param packageName 包名。
 */
async function packageDirFromAnchor(anchor: string, packageName: string): Promise<string | undefined> {
  let require: NodeJS.Require
  try {
    require = createRequire(anchor)
  } catch {
    return undefined
  }
  try {
    return dirname(require.resolve(`${packageName}/package.json`))
  } catch {
    // 落到第 2 步：包的 exports 里可能没有 `./package.json`。
  }
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, ...packageName.split('/'))
    if (await exists(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * 从**当前进程**认出 dsh 安装锚点。
 *
 * 宿主自己的锚点是「dsh 包目录下的 `package.json`」（`INSTALL_ANCHOR = new URL('../package.json', import.meta.url)`），
 * 而本插件跑在宿主进程里 —— 宿主入口脚本（`process.argv[1]`）就是那条锚点的来源。
 * **不猜路径**：只有真的能从它解析出 `@deepseek-ai/dsh/package.json` 才算认出来
 * —— 解析成功本身就证明了那是哪个包。认不出来时返回 `undefined`，结果退化成 `unknown`。
 */
function installationAnchorFromProcess(): string | undefined {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return undefined
  try {
    return createRequire(entry).resolve('@deepseek-ai/dsh/package.json')
  } catch {
    return undefined
  }
}

/** 一份 `dsh.bundle.patch` 声明解析后的样子。 */
interface PatchDeclaration {
  /** 声明里的**全部**包内相对路径，按声明顺序。 */
  files: string[]
  /** 既不是字符串、也不是「全是字符串的数组」—— 宿主会抛错并 skip 整层。 */
  malformed: boolean
}

/**
 * 解析 `dsh.bundle.patch` 的两种形状（宿主的 `bundlePatchFiles` 同义）。
 *
 * **逐个元素看**，不只看第一个：数组形态下第二个元素缺失同样会让宿主 skip 整层，
 * 而 `find(isString)` 只看第一个 → 工具判绿、宿主静默丢插件（缺 B）。
 *
 * @param raw `dsh.bundle` 的 `patch` 字段原值。
 */
function parsePatchDeclaration(raw: unknown): PatchDeclaration {
  if (raw === undefined) return { files: [], malformed: false }
  const declared: unknown = isString(raw) ? [raw] : raw
  if (!Array.isArray(declared) || !declared.every(isString)) return { files: [], malformed: true }
  return { files: [...declared], malformed: false }
}

/**
 * 由声明与逐文件结果算整体状态。
 *
 * 「坏声明」必须是独立、可判的一档：宿主读到它会**抛错**，而抛错 = 整层 skip
 * —— 含糊成「文件不在」会让人以为是漏发产物。
 *
 * @param declaration 解析后的声明。
 * @param patches 逐文件结果。
 */
function patchStateOf(
  declaration: PatchDeclaration,
  patches: readonly PatchFileCheck[],
): PatchState {
  if (declaration.malformed) return 'malformed'
  if (patches.length === 0) return 'undeclared'
  return patches.every((item) => item.exists) ? 'present' : 'missing'
}

/**
 * 取文件的 mtime（毫秒）。
 *
 * ⚠️ **它单独不足以判「宿主端跑的是旧产物」**（2026-10-15 纠正）：与**进程启动时刻**相比，
 * 在宿主能**就地热替换插件**的前提下推不出结论 —— 「产物更新」与「跑的就是新产物」可同时成立。
 * 要判加载面得看 fiber 相位与注册面是否缺失，不是看这两个时间戳。
 * 判据形态见 `dsh_diagnose_plugin_load.ts` 的 `ArtifactFreshness`（三值，含「推不出来」那一档）。
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
 * `listStartupLogs` 的结果。
 *
 * 为什么不是裸数组：「读不到那个目录」与「目录里没有日志」表面上都是「一条都没有」，
 * 而前者是**未知**、后者才是好消息。把两者混成一个 `[]`，就是活跃坑 18 那种
 * 「让判据自己看起来通过了」的静默坏（缺 D）。
 *
 * 调用方要这样读：
 * - `readError !== undefined` → **未知**：日志目录读不到，绝不等于「没有失败日志」；
 * - `dirExisted === false` 且没有 `readError` → **确定**没有（目录不存在）；
 * - `dirExisted === true` → 真列过了，`logs` 就是全部。
 */
export interface StartupLogsResult {
  logs: StartupLog[]
  /** `logs` 目录是否存在；读目录失败时为 `undefined`（**不知道**，不等于不存在）。 */
  dirExisted?: boolean
  /** 读目录失败的原因（英文，可能进工具输出）；成功时为 `undefined`。 */
  readError?: string
}

/**
 * 列 `$DSH_HOME/logs/startup-*.log`。
 *
 * **只在启动失败时生成**（SKILL §3.8）—— 所以「一条都没有」是好消息，不是缺数据。
 * 工具输出里必须把这句话说清楚，否则模型会把「空列表」读成「还没查」。
 *
 * 但「读不到目录」不能跟着一起说成好消息，所以返回的是
 * {@link StartupLogsResult}（三值：列到了 / 确定不存在 / 读不到）。
 *
 * @param dshHome DSH_HOME 目录。
 */
export async function listStartupLogs(dshHome: string): Promise<StartupLogsResult> {
  const dir = logsDir(dshHome)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    // 只有「路径不存在」才是确定的「没有日志」；别的失败（权限 / 不是目录 / IO 错）
    // 都是**未知** —— 两者都不许伪装成「没有失败日志」。
    return isMissingPathError(error)
      ? { logs: [], dirExisted: false }
      : { logs: [], readError: messageOf(error) }
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
  return { logs: logs.sort((left, right) => right.mtimeMs - left.mtimeMs), dirExisted: true }
}

/**
 * 是不是「路径不存在」（ENOENT）那一类错误。
 *
 * `ENOTDIR`（中间某一段不是目录）**不算**「不存在」：那是路径本身有问题，属于未知。
 *
 * @param error 捕获到的错误。
 */
function isMissingPathError(error: unknown): boolean {
  return codeOf(error) === 'ENOENT'
}

/**
 * 取错误的 `code` 字段（`ENOENT` / `EACCES` 这类）。
 *
 * @param error 任意值。
 */
function codeOf(error: unknown): string | undefined {
  const code = asRecord(error)?.['code']
  return isString(code) ? code : undefined
}

/**

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
    for (const name of fromBundles) evidence.push(`dsh.profile.bundles contains ${name}`)
    if (fromBundles.length > 0) return { present: true, evidence }
    const fromDeps = Object.keys(manifest.dependencies).filter((name) => name.includes('hmr'))
    for (const name of fromDeps) evidence.push(`dependencies contains ${name}`)
    if (fromDeps.length > 0) return { present: true, evidence }
  }
  const installed = await exists(join(dir, 'node_modules', ...HMR_PACKAGE.split('/')))
  if (installed) {
    evidence.push(`${HMR_PACKAGE} is present in node_modules`)
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
  // `default` 条件（例如 `{".": {"types": …, "default": "./lib/index.js"}}`）。
  // **没有 `main` 又读不出 `default`** 时返回 `undefined`，调用方会把它算成
  // **未知**（不是「缺文件」）—— 本机实测 `dsh-cpa-switch` 就是靠 `exports.default` 的。
  const defaultField = asRecord(root)?.['default']
  if (isString(defaultField)) return defaultField
  return undefined
}

// `asRecord` 的唯一实现在 errors.ts（2026-10-16 审计 A3 收敛，本文件原有一份已删）。

/**
 * 取一个值的字符串字典视图（丢掉非字符串项）。
 *
 * @param value 任意值。
 */
// `isString` 的唯一实现同样在 errors.ts（审计 A3）。
function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (record === undefined) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (isString(item)) result[key] = item
  }
  return result
}
