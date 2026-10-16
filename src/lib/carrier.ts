/**
 * 载体（carrier）观测 —— 「这个宿主是被谁拉起来的、谁能把它带回来」。
 *
 * ## 为什么需要这一层（本仓踩到的真缺陷）
 *
 * 2026-10-15 在 Desktop profile 上真机调 `dsh_restart`：它把 `--profile web` 写进了计划任务，
 * 于是**起了一个 web 实例**（那个实例还顺手打开了默认浏览器），而 Desktop 的 Host 一退，
 * Electron 侧把它判成崩溃。结论不是「层没分好」，而是**有一维现实没被建模**：
 * 「怎么把宿主拉起来」在 `lib/dump.ts` 的 `resolveDshLaunch()` 里只有两种答案
 * （`argv[1]` 是 `bin.js` / PATH 上的 `dsh`），而实际有**三种载体**。
 *
 * 桌面端是第三种，而且它的回归路线**不存在**（对插件而言）：
 *
 * | 事实 | 出处 |
 * |---|---|
 * | Desktop 的 Host 是 Electron 以 Node 模式起的子进程，入口是 `…app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` | `apps/desktop/src/host-process.ts` 的 `spawn(…, {cwd: projectDir})` |
 * | DSH 命令行**无条件**拒绝那个保留 profile 名 | `apps/cli/src/bin.ts` 的 `rejectElectronProfile`；**本机实测**：npm CLI 与桌面内置 CLI 都回 `error: profile "desktop" is managed exclusively by the Electron application`、exit 1 |
 * | Host ↔ 壳的 IPC 是**闭集**（多发一类就把 Host SIGTERM 掉） | `apps/desktop/src/host-process.ts` 的 `isDesktopHostEvent` |
 * | 壳对页面暴露的通道里没有 restart/relaunch | 装好的 `app.asar` 里 `ipcMain.*` 全表 |
 *
 * ⇒ 桌面端**只能由 Electron 壳自己** `app.relaunch()`；插件侧没有那条通道。
 * 所以本层存在的意义是：让「能不能回来」变成一个**显式观测**，而不是继续靠
 * 「命令行拼得出来」推断出来 —— 后者正是那次真机缺陷的成因。
 *
 * ## 这一层是纯函数
 *
 * 不碰 `node:fs`、不碰 Cordis、不碰 `process`（三个输入都有默认值读进程，但都可注入）。
 * 与 `restart.ts` 同一族：**判定与 IO 分开**，所以每个分支都能用普通对象直接单测，
 * 而且 `withPlatform` 那种显式平台声明在判据里天然成立（坑 25）。
 *
 * ## 三个消费者（一处探、三处用，别各读各的 env）
 *
 * | 消费者 | 用哪一格 |
 * |---|---|
 * | `dsh_restart` 闸④ | {@link relaunchRouteFor} —— 没有已实测路线就**动手前**拒绝 |
 * | `dsh_dump_config` | {@link isReservedDesktopProfile} —— 保留 profile 的 CLI **dump 不了** |
 * | `dsh_check_effect_mode` | 同上 + {@link CarrierObservation} 决定 `nextStep` 走工具还是走人 |
 */

/**
 * 宿主是被谁拉起来的。
 *
 * `unknown` 是**真的一格**（三值纪律）：认不出来时不许印成 `cli` ——
 * 那会把「不知道能不能回来」印成「有已实测的路线」。
 */
export type CarrierKind =
  /** 普通命令行启动：`argv[1]` 是 `bin.js`，或有非空 `profileContext.name`。 */
  | 'cli'
  /** Electron 以 Node 模式起的 Desktop Host（保留 profile `desktop`）。 */
  | 'desktop-host'
  /** 认不出来 —— **不猜**。 */
  | 'unknown'

/**
 * 命中的是哪一条判据。
 *
 * 它进 `audit`（给人复核）：只报 `kind` 时，「为什么判成 desktop」这件事在事后是查不到的，
 * 而这一层的结论**会**导致一次拒绝 —— 拒绝的理由必须可复核。
 */
export type CarrierRule =
  | 'profile-context-desktop'
  | 'desktop-host-entry'
  | 'bin-js-entry'
  | 'profile-context-present'
  | 'unrecognized'

/** 载体观测（**不可变**；进 `key` / `audit` 前一律经 {@link carrierAuditOf} 投影）。 */
export interface CarrierObservation {
  kind: CarrierKind
  /**
   * 运行时真源给的 profile 名（`profileContext.name`）。
   *
   * ⚠️ **它是 profile 身份的唯一真源**，`env.DSH_PROFILE` 不是 —— 后者的形状是
   * 「启动这个 Electron 进程的那个 shell 里恰好有什么」，与「这个宿主管的是哪个 profile」
   * 无关（那次真机缺陷正是这么来的）。
   *
   * `undefined` = **取不到**（不猜）：进 `audit` 时该键整个不印（见 {@link carrierAuditOf}），
   * 因为 `{profile: undefined}` 过不了宿主「可无损落 JSON」那条边界（B26）。
   */
  profile: string | undefined
  /** 观测那一刻的 `process.platform`（**调用时读**，坑 25）。 */
  platform: string
  /** 命中的判据（机器码）。 */
  rule: CarrierRule
  /** 人可复核的证据行（英文，逐条事实）。 */
  evidence: readonly string[]
}

/** {@link observeCarrier} 的输入；每一项都可注入（默认读当前进程）。 */
export interface CarrierProbeInput {
  /** 进程参数，默认 `process.argv`。 */
  argv?: readonly string[]
  /** 环境变量，默认 `process.env`。 */
  env?: NodeJS.ProcessEnv
  /** 平台，默认 `process.platform`。 */
  platform?: string
  /**
   * 运行时的 profile 上下文（结构性取 `name`）。
   *
   * 真实调用方给 `ctx.get('profileContext')`；形状不认识时按「取不到」处理 ——
   * 宿主换版本时表现为降级，不是抛（`src/lib/AGENTS.md` 的纪律）。
   */
  profileContext?: unknown
}

/**
 * Desktop **保留**的 profile 名（`package.json` 那一侧也用它拼目录）。
 *
 * 为什么是常量而不是散落的字面量：它的**唯一性质**是「DSH 命令行无条件拒绝它」
 * （`rejectElectronProfile`），而本仓有两处要引用这条性质 —— 不许抄第二份。
 */
export const RESERVED_DESKTOP_PROFILE = 'desktop'

/** 桌面宿主入口的形状片段（**形状**判据，不是绝对路径 —— 不绑任何一台机器）。 */
const DESKTOP_ENTRY_MARKERS: readonly string[] = ['app.asar', 'dsh-desktop-host'] as const

/** 普通命令行入口的文件名（与 `lib/dump.ts` 的 `resolveDshLaunch` 同一判据）。 */
const BIN_JS_ENTRY = /(?:^|[\\/])bin\.js$/u

/**
 * 观测这个宿主的载体。
 *
 * 判据顺序**是设计**（越权威越靠前）：
 * 1. `profileContext.name === 'desktop'` —— **权威**：这个名字只由 Electron 的保留 profile 用，
 *    而且命令行拒绝它 ⇒ 零假阳性；
 * 2. `argv[1]` 的形状命中桌面宿主入口（`app.asar` / `dsh-desktop-host`）—— 与第 1 条
 *    **互为独立来源**（profile 名字被改过的边缘情形仍然认得出来）；
 * 3. `argv[1]` 是 `bin.js` ⇒ 普通命令行；
 * 4. 有非空 `profileContext.name` ⇒ 也是命令行启动（入口不叫 `bin.js` 的启动器，
 *    例如 SDK / app-boot 那条路）；
 * 5. 其余 ⇒ `unknown`。
 *
 * 第 3/4 条与第 1/2 条的顺序不可换：`profileContext.name === 'desktop'` 必须**先**判，
 * 否则桌面宿主的 `argv[1]`（不是 `bin.js`）会落到第 4 条、被印成 `cli`。
 *
 * @param input 可注入的观测输入。
 */
export function observeCarrier(input: CarrierProbeInput = {}): CarrierObservation {
  const argv = input.argv ?? process.argv
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const entry = typeof argv[1] === 'string' ? argv[1] : undefined
  const profile = profileNameOf(input.profileContext)
  const evidence: string[] = []

  if (entry === undefined) evidence.push('argv[1] is absent')
  else evidence.push(`argv[1] = ${entry}`)
  evidence.push(
    profile === undefined ? 'profileContext.name is unavailable' : `profileContext.name = ${profile}`,
  )
  // `DSH_CLIENT_VERSION` 由桌面壳在**起 Host 子进程时**注入（`main.ts` 的 `hostEnvironment`），
  // 所以它是**佐证**：只记一行，从不单独决定 kind。
  const clientVersion = env.DSH_CLIENT_VERSION
  if (typeof clientVersion === 'string' && clientVersion !== '') {
    evidence.push(`DSH_CLIENT_VERSION is set (${clientVersion}), which the Desktop shell injects`)
  }

  if (profile === RESERVED_DESKTOP_PROFILE) {
    return { kind: 'desktop-host', profile, platform, rule: 'profile-context-desktop', evidence }
  }
  if (entry !== undefined && DESKTOP_ENTRY_MARKERS.some((marker) => entry.includes(marker))) {
    return { kind: 'desktop-host', profile, platform, rule: 'desktop-host-entry', evidence }
  }
  if (entry !== undefined && BIN_JS_ENTRY.test(entry)) {
    return { kind: 'cli', profile, platform, rule: 'bin-js-entry', evidence }
  }
  if (profile !== undefined) {
    return { kind: 'cli', profile, platform, rule: 'profile-context-present', evidence }
  }
  return { kind: 'unknown', profile, platform, rule: 'unrecognized', evidence }
}

/**
 * 取 `profileContext.name`（结构性；形状不认识按**取不到**处理）。
 *
 * @param profileContext 运行时的 profile 上下文。
 */
function profileNameOf(profileContext: unknown): string | undefined {
  if (typeof profileContext !== 'object' || profileContext === null) return undefined
  const name = (profileContext as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : undefined
}

/** 已**实测**过的回归路线（不是「理论上能拼出命令」）。 */
export type RelaunchRoute =
  /** Windows 计划任务：无需提权、父进程是 `svchost.exe`、不在宿主 job 里（`HOST-CONTRACTS` §2.2.2）。 */
  | 'task-scheduler'
  /** 没有已实测的路线 —— 调用方**动手前**拒绝。 */
  | 'none'

/**
 * 「这个载体能不能把宿主带回来」—— **只看这张表，不看命令拼不拼得出来**。
 *
 * | 载体 | win32 | 其它平台 |
 * |---|---|---|
 * | `cli` | `task-scheduler` | `none`（未实测） |
 * | `desktop-host` | **`none`**（插件无通道；只有 Electron 壳能 `app.relaunch()`） | `none` |
 * | `unknown` | `none`（不猜） | `none` |
 *
 * @param observation 载体观测。
 */
export function relaunchRouteFor(observation: CarrierObservation): RelaunchRoute {
  if (observation.kind === 'desktop-host') return 'none'
  if (observation.kind === 'cli' && observation.platform === 'win32') return 'task-scheduler'
  return 'none'
}

/** 一条拒绝的两半：为什么、以及人能做什么。 */
export interface RelaunchRefusal {
  /** 为什么（英文，会逐字进 `data.verdict`）。 */
  reason: string
  /** 怎么解（英文，进 `nextStep.why`）。 */
  remedy: string
}

/**
 * 没有回归路线时的那两句话 —— **按载体分岔**，因为「人能做什么」三档完全不同：
 * 桌面端要退出 App（插件没有通道），非 Windows 只能手动起，认不出来时只能手动起。
 *
 * ⚠️ 三档的措辞必须**彼此可分**：压成同一句就等于把三值压成两值，
 * 而人恰恰是靠这句话决定下一步做什么（与 `approvalRemedy` 按 outcome 分岔同一条理由）。
 *
 * ⚠️ **不含任何路径 / 版本号之类的会漂的值**（它们进 `audit` 的 evidence，不进这里）。
 *
 * @param observation 载体观测。
 */
export function relaunchRefusalFor(observation: CarrierObservation): RelaunchRefusal {
  switch (observation.kind) {
    case 'desktop-host':
      return {
        reason:
          'this host runs as the Desktop application Host child, whose reserved profile the DSH command line refuses, and no plugin-facing channel can restart the Electron application',
        remedy:
          'ask the user to quit the application from the tray and start it again; only the Desktop shell can relaunch this host',
      }
    case 'cli':
      return {
        reason: unverifiedRelaunchReason(observation.platform),
        remedy:
          'start the host again yourself, or run this where the relaunch route has been measured (Windows)',
      }
    case 'unknown':
      return {
        reason:
          'the launching carrier of this host could not be identified, so no relaunch route can be confirmed',
        remedy:
          'start the host again yourself; this tool does not guess how to bring an unidentifiable host back',
      }
  }
}

/**
 * 非 Windows 平台上「没有已实测回归路线」的措辞 —— **唯一落点**。
 *
 * 这句话此前有三处：本函数、`dsh_restart.ts` 的 `launchCommandFrom`（逐字第二份）与
 * `relaunchViaTaskScheduler`（截断第三份）。而 `restart.ts` 的注释声称「三档措辞
 * 只写在这里一处」—— 那是一句假话。现在两个调用方都改调这里，注释重新为真。
 *
 * @param platform 当前平台（进程实测值）。
 */
export function unverifiedRelaunchReason(platform: string): string {
  return `no relaunch route has been verified on ${platform}; only the Windows task scheduler was measured`
}

/**
 * 这个 profile 名是不是 Desktop 的**保留**名。
 *
 * 判它的用途只有一个：**DSH 命令行无条件拒绝它** ⇒ `dsh <profile> --dump-config` 这条
 * 读组合树的路在**任何载体上**都走不通（本机实测，npm CLI 与桌面内置 CLI 都拒）。
 * 所以「按 profile 名拒绝」比「按载体拒绝」更准：从 web 会话里 dump desktop 同样做不到。
 *
 * @param profile 要判的 profile 名。
 */
export function isReservedDesktopProfile(profile: string): boolean {
  return profile.trim().toLowerCase() === RESERVED_DESKTOP_PROFILE
}

/**
 * 把观测投影成**可无损落 JSON** 的审计记录。
 *
 * 存在的理由是三值纪律与宿主边界的一次相撞：`profile` 在类型上是
 * `string | undefined`（「取不到」是真的一格），而 `{profile: undefined}` 过不了宿主
 * 「可无损落 JSON」那条判据（B26：往返后该键会消失）。⇒ 投影时**整个键不印**，
 * 而不是喂一个 `undefined` 或一个冒充的 `''`。
 *
 * @param observation 载体观测。
 */
export function carrierAuditOf(observation: CarrierObservation): {
  kind: CarrierKind
  platform: string
  rule: CarrierRule
  evidence: string[]
  profile?: string
} {
  return {
    kind: observation.kind,
    platform: observation.platform,
    rule: observation.rule,
    evidence: [...observation.evidence],
    ...(observation.profile === undefined ? {} : { profile: observation.profile }),
  }
}

/**
 * 「取不到载体」时的兜底观测。
 *
 * ⚠️ **它不是 `cli`**：夹具与降级路径都需要一个「什么都没观测到」的形状，
 * 而把它写成 `cli` 会让 `relaunchRouteFor` 在 win32 上返回 `task-scheduler`
 * —— 那就是「把不知道印成有能力」，正是这一层要消灭的东西。
 */
export const UNKNOWN_CARRIER: CarrierObservation = Object.freeze({
  kind: 'unknown',
  profile: undefined,
  platform: '',
  rule: 'unrecognized',
  evidence: Object.freeze(['no carrier observation was supplied']),
})
