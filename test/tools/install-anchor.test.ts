/**
 * 缺 A / 缺 B / 缺 D 的判据 —— **既有代码在骗人**的那三处。
 *
 * | 缺 | 旧行为（骗人） | 本文件的判据 |
 * |---|---|---|
 * | **A** 安装锚点 | 只看 `<profileDir>/node_modules` → 官方包全被判「缺文件」 | 从**安装锚点**解析得到 `present`；两条锚点都没有时必须是 `unknown`，**不许是 `false`** |
 * | **B** patch 数组 | `find(isString)` 只看第一个 → 第二个缺失时宿主 skip 整层而工具判绿 | 逐个元素查；任一缺失 → `patchState: 'missing'` |
 * | **D** 读目录吞错 | `readdir` 失败 → `[]`（「读不到」装成「没有」） | `logs`/`dirExisted`/`readError` 三值可判 |
 *
 * 三条纪律（抄 `test/redlines.test.ts` 的两层写法）：
 * 1. **夹具自造**：不碰真机、不碰别的测试文件的 helper（并发写者正在改 `test/tools/helpers.ts`）；
 * 2. **每条判据都要能被否证**：现场造一个假的安装锚点 / 假的 profile 目录结构，
 *    把旧逻辑改回去就必须红（变异测试见任务回报，这里留的是**构造性**反例）；
 * 3. **自证非空**：正例里连「第一个 patch 真的在」一起断言 —— 否则 `missing` 可能因为别的原因成立。
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { checkInstalledEntry, listStartupLogs } from '../../src/lib/profile.ts'

/** 本文件建过的临时根，测试结束统一清掉。 */
const created: string[] = []

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** 造一个临时根。 */
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-install-anchor-'))
  created.push(dir)
  return dir
}

/** 写一个文本文件（自动建父目录）。 */
async function writeTextFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** 写一个 JSON 文件（自动建父目录）。 */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, JSON.stringify(value, null, 2))
}

/**
 * 在某个根下造一个「装好的包」：`<base>/node_modules/<pkg>/package.json` + 给定的产物文件。
 *
 * @param base 锚点所在的那个包根目录（安装处或 profile 目录）。
 * @param pkg 包名（可含 scope）。
 * @param manifest `package.json` 的内容。
 * @param files 包内相对路径 → 内容（用来造「产物在」与「产物不在」）。
 * @returns 包目录的绝对路径。
 */
async function writePackage(
  base: string,
  pkg: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<string> {
  const packageDir = join(base, 'node_modules', ...pkg.split('/'))
  await writeJsonFile(join(packageDir, 'package.json'), manifest)
  for (const [relative, text] of Object.entries(files)) {
    await writeTextFile(join(packageDir, relative), text)
  }
  return packageDir
}

/**
 * 造一个假的 **dsh 安装**：`<root>/installation/package.json`（锚点）+ 它自己的 `node_modules`。
 *
 * 这就是宿主「安装锚点优先」的那条锚点 —— 锚点文件本身不必存在内容语义，
 * 它的作用只是给 Node 一个向上找 `node_modules` 的**位置**。
 *
 * @param root 临时根。
 * @returns `{ anchor, base }`：锚点文件路径与它所在的包根目录。
 */
async function fakeInstallation(root: string): Promise<{ anchor: string; base: string }> {
  const base = join(root, 'installation')
  const anchor = join(base, 'package.json')
  await writeJsonFile(anchor, { name: '@deepseek-ai/dsh', version: '0.0.0-test' })
  return { anchor, base }
}

/**
 * 造一个假的 **profile 目录**（含 `dsh.profile.bundles`）。
 *
 * @param root 临时根。
 * @param bundles bundle 列表。
 */
async function fakeProfile(root: string, bundles: readonly string[]): Promise<string> {
  const dir = join(root, 'profiles', 'web')
  await writeJsonFile(join(dir, 'package.json'), {
    name: 'dsh-profile-web',
    dsh: { profile: { bundles: [...bundles] } },
    dependencies: {},
  })
  return dir
}

describe('缺 A：包从安装锚点解析，解析不到报 unknown（不是 missing）', () => {
  it('官方形状：包只在安装锚点下 → present，且 resolvedFrom=installation', async () => {
    const root = await tempRoot()
    const { anchor, base } = await fakeInstallation(root)
    const pkg = '@deepseek-ai/dsh-base'
    await writePackage(
      base,
      pkg,
      { name: pkg, version: '9.9.9', main: './lib/index.js' },
      {
        'lib/index.js': '// built artifact\n',
      },
    )
    const profileDir = await fakeProfile(root, [pkg])

    const entry = await checkInstalledEntry(profileDir, pkg, { installAnchor: anchor })

    // 这是缺 A 的**核心**：旧代码只看 profile 本地，这一条必然红（entryExists=false）。
    expect(entry.resolvedFrom).toBe('installation')
    expect(entry.entryState).toBe('present')
    expect(entry.entryExists).toBe(true)
    expect(entry.entryMtimeMs).toBeGreaterThan(0)
    // 历史字段仍然是 profile 本地的期望路径（安装形态判定认这一处，不能被这次修复悄悄改掉）。
    expect(entry.packageDir).toBe(join(profileDir, 'node_modules', ...pkg.split('/')))
    // 包不在 profile 本地，但它是**真的装了** —— 解析到的目录必须落在安装锚点那棵树里。
    expect(entry.resolvedDir?.startsWith(base)).toBe(true)
  })

  it('两条锚点都没有这个包 → unknown；`entryExists` 必须缺席，不许是 false', async () => {
    const root = await tempRoot()
    const { anchor } = await fakeInstallation(root)
    const profileDir = await fakeProfile(root, ['pkg-not-anywhere'])

    const entry = await checkInstalledEntry(profileDir, 'pkg-not-anywhere', {
      installAnchor: anchor,
    })

    expect(entry.entryState).toBe('unknown')
    expect(entry.resolvedFrom).toBe('unresolved')
    // 旧代码在这里返回 `entryExists: false` —— 那是把「没查到」说成「不存在」。
    expect(entry.entryExists).toBeUndefined()
    expect('entryExists' in entry).toBe(false)
    expect(entry.patchState).toBe('unknown')
  })

  it('profile 本地装了（没给安装锚点）→ resolvedFrom=profile', async () => {
    const root = await tempRoot()
    const pkg = 'pkg-local'
    const profileDir = await fakeProfile(root, [pkg])
    await writePackage(
      profileDir,
      pkg,
      { name: pkg, version: '0.0.1', main: './lib/index.js' },
      {
        'lib/index.js': '// built\n',
      },
    )

    // 不给 `installAnchor`：走「从进程认」那条路，认不出来也不该影响 profile 锚点。
    const entry = await checkInstalledEntry(profileDir, pkg)

    expect(entry.resolvedFrom).toBe('profile')
    expect(entry.entryState).toBe('present')
    expect(entry.entryExists).toBe(true)
  })

  it('真缺失（解析到了包，但清单指向的入口文件不在）→ missing + entryExists=false', async () => {
    const root = await tempRoot()
    const { anchor, base } = await fakeInstallation(root)
    const pkg = 'pkg-broken'
    // 清单写了入口，但**不写**那个文件 —— 这是真的坏，不是「没查到」。
    await writePackage(base, pkg, { name: pkg, version: '0.0.1', main: './lib/index.js' })
    const profileDir = await fakeProfile(root, [pkg])

    const entry = await checkInstalledEntry(profileDir, pkg, { installAnchor: anchor })

    expect(entry.entryState).toBe('missing')
    expect(entry.entryExists).toBe(false)
    expect(entry.resolvedFrom).toBe('installation')
  })

  it('清单里读不出入口（exports 条件形态）→ unknown，不报 missing（防新的假红）', async () => {
    const root = await tempRoot()
    const { anchor, base } = await fakeInstallation(root)
    const pkg = 'pkg-conditional'
    // 我们只认 `exports['.']` 的字符串与 `.import`；这种条件嵌套读不出入口路径。
    await writePackage(
      base,
      pkg,
      { name: pkg, version: '0.0.1', exports: { '.': { node: { import: './lib/index.js' } } } },
      { 'lib/index.js': '// built\n' },
    )
    const profileDir = await fakeProfile(root, [pkg])

    const entry = await checkInstalledEntry(profileDir, pkg, { installAnchor: anchor })

    expect(entry.entryState).toBe('unknown')
    expect(entry.entryExists).toBeUndefined()
  })

  it('锚点给的是「包目录在、清单读不出」时也是 unknown（不是 missing）', async () => {
    const root = await tempRoot()
    const { anchor } = await fakeInstallation(root)
    const pkg = 'pkg-bad-manifest'
    const profileDir = await fakeProfile(root, [pkg])
    // 目录在、package.json 不是 JSON：只能报「未知」。
    const packageDir = join(profileDir, 'node_modules', ...pkg.split('/'))
    await writeTextFile(join(packageDir, 'package.json'), '{ not json\n')

    const entry = await checkInstalledEntry(profileDir, pkg, { installAnchor: anchor })

    expect(entry.resolvedFrom).toBe('profile')
    expect(entry.entryState).toBe('unknown')
    expect(entry.entryExists).toBeUndefined()
  })

  it('包的 exports 不暴露 ./package.json 时也能解析到（宿主明说不要求导出它）', async () => {
    const root = await tempRoot()
    const { anchor, base } = await fakeInstallation(root)
    const pkg = 'pkg-no-pkg-export'
    await writePackage(
      base,
      pkg,
      { name: pkg, version: '0.0.1', exports: { '.': './lib/index.js' } },
      { 'lib/index.js': '// built\n' },
    )
    const profileDir = await fakeProfile(root, [pkg])

    const entry = await checkInstalledEntry(profileDir, pkg, { installAnchor: anchor })

    expect(entry.resolvedFrom).toBe('installation')
    expect(entry.entryState).toBe('present')
  })

  it('入口只写在 `exports["."].default` 里 → present（本机 dsh-cpa-switch 就是这种）', async () => {
    const root = await tempRoot()
    const pkg = 'pkg-default-only'
    const profileDir = await fakeProfile(root, [pkg])
    // 没有 `main`，只有条件对象里的 `default` —— 旧 `resolveEntry` 读不出来，
    // 会把一个**入口文件明明在**的包报成「读不出入口」。
    await writePackage(
      profileDir,
      pkg,
      {
        name: pkg,
        version: '0.0.1',
        exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } },
      },
      { 'lib/index.js': '// built\n' },
    )

    const entry = await checkInstalledEntry(profileDir, pkg)

    // `EntryCheck.entry` 是**绝对路径**（历史形状）。
    expect(entry.entry?.endsWith(join('lib', 'index.js'))).toBe(true)
    expect(entry.entryState).toBe('present')
    expect(entry.entryExists).toBe(true)
  })
})

describe('缺 B：patch 是数组时逐个元素都查（不只看第一个）', () => {
  it('数组里第二个缺失 → missing（旧代码只看第一个 → 会判成存在）', async () => {
    const root = await tempRoot()
    const pkg = 'pkg-web-app-like'
    // 本机真实声明就是 5 个（`@deepseek-ai/dsh-web-app` 的 package.json 实测）。
    const declared = [
      './cordis.patch.yml',
      './presets/standard.patch.yml',
      './presets/ptc.patch.yml',
    ]
    const profileDir = await fakeProfile(root, [pkg])
    // 只写第一个：旧的 `find(isString)` 会拿它当真，工具判绿而宿主要 skip 整层。
    await writePackage(
      profileDir,
      pkg,
      { name: pkg, version: '0.0.1', main: './lib/index.js', dsh: { bundle: { patch: declared } } },
      { 'lib/index.js': '// built\n', './cordis.patch.yml': '[]\n' },
    )

    const entry = await checkInstalledEntry(profileDir, pkg)

    expect(entry.patches.map((item) => item.file)).toEqual(declared)
    // 自证：第一个**真的在**。否则这条 `missing` 可能是因为别的原因成立，判据就没在测「第二个」。
    expect(entry.patches[0]?.exists).toBe(true)
    expect(entry.patches[1]?.exists).toBe(false)
    expect(entry.patchState).toBe('missing')
    expect(entry.patchExists).toBe(false)
    // 历史字段仍指向第一个（兼容），但它**不再**代表整体结论。
    expect(entry.patch).toBe(declared[0])
  })

  it('数组全部存在 → present', async () => {
    const root = await tempRoot()
    const pkg = 'pkg-all-patches'
    const declared = ['./a.yml', './b.yml']
    const profileDir = await fakeProfile(root, [pkg])
    await writePackage(
      profileDir,
      pkg,
      { name: pkg, version: '0.0.1', main: './lib/index.js', dsh: { bundle: { patch: declared } } },
      { 'lib/index.js': '// built\n', './a.yml': '[]\n', './b.yml': '[]\n' },
    )

    const entry = await checkInstalledEntry(profileDir, pkg)

    expect(entry.patchState).toBe('present')
    expect(entry.patchExists).toBe(true)
    expect(entry.patches.every((item) => item.exists)).toBe(true)
  })

  it('单个字符串声明（回归）：在 → present，不在 → missing', async () => {
    const root = await tempRoot()
    const ok = 'pkg-single-ok'
    const bad = 'pkg-single-bad'
    const profileDir = await fakeProfile(root, [ok, bad])
    await writePackage(
      profileDir,
      ok,
      {
        name: ok,
        version: '0.0.1',
        main: './lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      { 'lib/index.js': '// built\n', './cordis.patch.yml': '[]\n' },
    )
    await writePackage(
      profileDir,
      bad,
      {
        name: bad,
        version: '0.0.1',
        main: './lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      { 'lib/index.js': '// built\n' },
    )

    const first = await checkInstalledEntry(profileDir, ok)
    const second = await checkInstalledEntry(profileDir, bad)

    expect(first.patchState).toBe('present')
    expect(second.patchState).toBe('missing')
    expect(second.patches).toHaveLength(1)
  })

  it('坏声明（数组里有非字符串）→ malformed：宿主读到它会抛错并 skip 整层', async () => {
    const root = await tempRoot()
    const pkg = 'pkg-malformed-patch'
    const profileDir = await fakeProfile(root, [pkg])
    await writePackage(
      profileDir,
      pkg,
      {
        name: pkg,
        version: '0.0.1',
        main: './lib/index.js',
        dsh: { bundle: { patch: ['./a.yml', 7] } },
      },
      { 'lib/index.js': '// built\n', './a.yml': '[]\n' },
    )

    const entry = await checkInstalledEntry(profileDir, pkg)

    // 不许含糊成 missing：`./a.yml` **在**，坏的是声明形状本身。
    expect(entry.patchState).toBe('malformed')
    expect(entry.patches).toEqual([])
    expect(entry.patchExists).toBeUndefined()
  })

  it('没声明 patch → undeclared（不许报成 present，也不许报成 missing）', async () => {
    const root = await tempRoot()
    const pkg = 'pkg-no-patch'
    const profileDir = await fakeProfile(root, [pkg])
    await writePackage(
      profileDir,
      pkg,
      { name: pkg, version: '0.0.1', main: './lib/index.js' },
      {
        'lib/index.js': '// built\n',
      },
    )

    const entry = await checkInstalledEntry(profileDir, pkg)

    expect(entry.patchState).toBe('undeclared')
    expect(entry.patches).toEqual([])
    expect(entry.patchExists).toBe(false)
  })
})

describe('缺 D：读目录失败不许伪装成「没有失败日志」', () => {
  it('logs 目录不存在 → dirExisted=false 且没有 readError（这才是确定的「没有」）', async () => {
    const root = await tempRoot()

    const result = await listStartupLogs(root)

    expect(result.logs).toEqual([])
    expect(result.dirExisted).toBe(false)
    expect(result.readError).toBeUndefined()
  })

  it('logs 存在但读不了（是文件不是目录）→ readError 有值、dirExisted 是 undefined', async () => {
    const root = await tempRoot()
    // 在「logs」这个位置上放一个**文件**：readdir 会以 ENOTDIR 失败（不是 ENOENT）。
    await writeTextFile(join(root, 'logs'), 'this is not a directory\n')

    const result = await listStartupLogs(root)

    // 旧代码这里只有 `[]` —— 「读不到」与「没有失败日志」长得一模一样。
    expect(result.logs).toEqual([])
    expect(result.readError).toBeDefined()
    expect(result.readError).not.toBe('')
    expect(result.dirExisted).toBeUndefined()
  })

  it('目录读得到时：只认 startup-*.log，并按 mtime 倒序', async () => {
    const root = await tempRoot()
    await writeTextFile(join(root, 'logs', 'other.log'), 'ignored\n')
    await writeTextFile(join(root, 'logs', 'startup-old.log'), 'boom\n')
    await writeTextFile(join(root, 'logs', 'startup-new.log'), 'boom again\n')
    // 让 mtime 有确定的先后（同一秒内创建时 mtime 可能相同）。
    const now = Date.now() / 1000
    await utimes(join(root, 'logs', 'startup-old.log'), now - 60, now - 60)

    const result = await listStartupLogs(root)

    expect(result.dirExisted).toBe(true)
    expect(result.readError).toBeUndefined()
    expect(result.logs.map((item) => item.name)).toEqual(['startup-new.log', 'startup-old.log'])
    expect(result.logs[0]?.sizeBytes).toBeGreaterThan(0)
  })
})
