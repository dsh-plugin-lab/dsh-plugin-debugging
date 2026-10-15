/**
 * 浏览器半体：侧边栏「插件（Plugins）」→「已安装（Installed）」组 → **点 dsh-plugin-debugging
 * 进它的详情页**，配置卡片就内联在描述与「包含的组件」之间 —— 没有多一次 Configure。
 *
 * 挂载点是插件管理页声明的 `plugins.bundle.config` 槽，key 是**包名**。
 * 这个槽**只渲染 `view: 'page'`**，而且座位里**没有** `form`（已回 0.2.0-rc.2 的
 * `dsh-client-ui-plugin-manager/lib/client.js` 核过：页面那处是
 * `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`，
 * 只递 `view` 与 `entryKey`）—— 表单因此由卡片自己向 `ctx.configForms.get(<loader entry id>)` 取，
 * 这也是该槽唯一的官方取表单路径。
 *
 * ⚠️ **槽契约的 `.d.ts` 里 `owner` 声明了可选的 `form` 字段，而页面从不递它** ——
 * 照那个声明去写「形参里有 form」会在运行时拿到 undefined，且类型上完全说得过去（它是可选的）。
 * 取表单只能自己取。
 *
 * 于是有两个**今天同串、却不是一回事**的 id：
 * - 槽 key = [package.json](../../package.json) 的 `name`（包名）；
 * - `get()` 的实参 = [cordis.patch.yml](../../cordis.patch.yml) 那条 insert 的 `id`（loader entry id）。
 *
 * 写错前者 = 整块配置不出现；写错后者 = 卡片照常出现、**永远只读且不报错**。
 *
 * 卡片只承载**一个布尔**：宿主侧 `Config.enableRestart`（`dsh_restart` 的总闸，默认关）。
 * 字段名由宿主侧的 schema 决定，本文件**只渲染与写值，不定义它**。
 * ⚠️ **绝不碰任何 secret 字段**：本仓 `dsh_sign_cookie` 是唯一经手密钥的工具，
 * 而活动 profile 的 Cordis patch 是明文可读的 —— 任何落进 `form.mutate` 的值都会出现在那里。
 *
 * 文案全部走 DSH 的 locale 服务（`ctx.locale`），不硬编码 —— 字典在 [locales.ts](./locales.ts)。
 */

import { useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// 类型导入即声明：`plugins.bundle.config` 槽由插件管理页的浏览器半体合并进共享的 SlotMap，
// 结构类型复制不出来，所以这条类型边必须留（`dsh.client.inject` 提供运行时）。
// 表单则**不欠** `dsh-client-ui-settings` 任何类型边：它经 `ctx.configForms` 拿，
// 形状在本文件用结构类型就地收窄（见 ConfigFormFace）。
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// 类型导入即声明：`ctx.locale` 由 locale 包的浏览器半体合并进 Context。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型导入即声明：ctx.slots 由 ui-renderer 的浏览器半体合并进 Context。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LOCALE_NS, RESTART_TOGGLE_LOCALES } from './locales.js'

/** 依赖的浏览器端服务。
 *
 * `slots` 与 `locale` 都是硬依赖：注册与渲染就需要它们，缺席时 DSH 会直接报错而不是降级。
 * 标准 web 装配必然带这两个（`ui-renderer` 与 `dsh-client-locale`）。
 *
 * ⚠️ **`configForms` 刻意不在这里**：inject 是**激活门禁**，把一个并非每个宿主都有的服务
 * 写进模块级 inject，会让那些宿主上的整个客户端半体 pending（连字典注册都轮不上）。
 * 它走嵌套的 `ctx.inject(['configForms'], …)`，缺席时降级限制在「卡片不注册」这一件事上。
 */
export const inject = ['slots', 'locale']

/**
 * 槽 key：bundle 的**包名** = [package.json](../../package.json) 的 `name`。
 *
 * 页面按包名寻址一个 bundle 的配置，写错的表现是整块配置不出现、页面也不报错。
 * 本处手写一份字面量是因为浏览器半体不 import package.json。
 */
const BUNDLE_NAME = 'dsh-plugin-debugging'

/**
 * loader entry id = [cordis.patch.yml](../../cordis.patch.yml) 那条 insert 的 `id`。
 *
 * 它是 `ctx.configForms.get()` 的实参：该服务按**设置命名空间**取表单，而命名空间就是
 * Host 插件条目的 id。
 *
 * ⚠️ **与 {@link BUNDLE_NAME} 今天同串，但是两个不同的东西**：改 patch 的 `id` 时槽 key
 * 仍然对得上（卡片照常出现），`get()` 却查不到命名空间 —— 卡片永远只读，**且不报错**。
 */
const ENTRY_ID = 'dsh-plugin-debugging'

/**
 * 总闸字段名，对应宿主侧 `Config.enableRestart`。
 *
 * ⚠️ **本仓与宿主侧那条线（[config.ts](../config.ts)）的唯一耦合点就是这串**。
 * 两处必须逐字一致；本文件不决定它是什么，只决定怎么渲染与写值。
 */
const ENABLE_FIELD = 'enableRestart'

/**
 * 能力探测的窗口。
 *
 * 探测的是**能力**不是版本号：版本在插件侧取不到，而「卡片拿不拿得到表单」这条链上有两环、
 * 各自当场可观测 —— 服务 `configForms` 在不在（嵌套 `ctx.inject` 的回调来不来），
 * 以及槽 `plugins.bundle.config` 在不在（`ctx.slots.inject` 的回调来不来）。
 * 两者缺席都不报错（静默），所以缺席时界面整个不见了、而用户只看到「这个插件没有设置项」。
 *
 * **为什么不能只盯槽名**：该槽在 0.1.7 与 0.2.0 上**都不传 `form`**，所以「槽在不在」
 * 推不出「拿不拿得到表单」。只换槽名会得到一个自相矛盾的探测，而它盯的那个真实故障是
 * **服务缺席**：那种宿主上卡片整个不注册，界面静默缺席。
 *
 * 窗口刻意给宽：迟到的声明只多留一条撤销提示，窗口太短反而会打扰正常装配上的用户。
 */
const PROBE_TIMEOUT_MS = 10_000

/**
 * `configForms` 服务缺席时的提示。英文、`[WARN]` 前缀、无 emoji；落点是**客户端控制台** ——
 * 本插件唯一的界面（这张卡片）就长在缺席的那个面里，没有跨版本的 UI 面可落。
 */
const SERVICE_MISSING_WARNING =
  '[WARN] dsh-plugin-debugging: this Host provides no client configuration service (configForms), so the settings card cannot be registered. All eight tools keep working; the dsh_restart master switch stays off. Upgrade the Host to the version range this package declares in engines.dsh.'

/** 提示必须可撤销：服务迟于窗口才到账时补一条，声明前一条作废。 */
const SERVICE_LATE_INFO =
  '[INFO] dsh-plugin-debugging: the client configuration service appeared after the probe window, so the earlier warning is withdrawn and the settings card is registered.'

/**
 * 槽缺席时的提示。`configForms` 在、槽不在 —— 那是**另一个**故障，所以文案里点名的槽
 * 必须是实际注册的那一个：探测说要装 A、卡片装进 B，是最坏的一种说谎。
 */
const SLOT_MISSING_WARNING =
  '[WARN] dsh-plugin-debugging: this Host renders no plugins.bundle.config entry, so the settings card cannot be shown. All eight tools keep working. Mount the plugin as a bundle (dsh plugin --profile web add) to configure it in place.'

/** 槽迟到：同上，补一条撤销。 */
const SLOT_LATE_INFO =
  '[INFO] dsh-plugin-debugging: plugins.bundle.config appeared after the probe window, so the earlier warning is withdrawn and the settings card is registered.'

/** 框架注入的 `t` 座位类型，绑定到本卡片的字典命名空间。 */
type CardTranslate = TranslateNS<typeof LOCALE_NS>

/** 本卡片看到的配置段：一个布尔，仅此而已。 */
interface RestartSection {
  enableRestart?: boolean
}

/** 一条字段写入操作里能出现的 JSON 值。 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * 一条字段写入操作。
 *
 * 用**结构类型**就地收窄，不引 `@deepseek-ai/dsh-api-remotes` 或
 * `@deepseek-ai/dsh-client-ui-settings` 的类型边 —— 只为几个字段的形状多背一个客户端装配包
 * 不划算。**`path` 必须是可变的 `string[]`**，写成 `readonly` 就不可赋值给服务的方法参数。
 */
type PathOp = { op: 'set'; path: string[]; value: JsonValue } | { op: 'unset'; path: string[] }

/** 卡片用到的那部分表单快照。 */
interface ConfigFormSnapshotFace {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: RestartSection | undefined
  readonly user: unknown
  readonly revision: number | undefined
  readonly writable: boolean
}

/**
 * 卡片用到的配置表单面：一个 Host 插件条目的共享表单值与写入队列。
 *
 * 结构类型而非 `import type`。`getSnapshot` 必须返回**稳定引用**（宿主原文「stable reference
 * until the next change」），否则 {@link RestartCard} 的 `useSyncExternalStore` 会陷入重渲染。
 */
interface ConfigFormFace {
  getSnapshot(): ConfigFormSnapshotFace
  /** 订阅快照替换；返回撤销函数。 */
  subscribe(listener: () => void): () => void
  /** 一次原子写入；`expectedRevision` 是栅栏，false = 宿主拒绝。 */
  mutate(ops: readonly PathOp[], expectedRevision?: number): Promise<boolean>
}

/**
 * `ctx.configForms` 在本卡片用到的最小面。
 *
 * 用结构类型取服务：**类型转换只在编译期**，运行时仍是 Cordis 的属性代理，
 * `inject` 那道门禁照旧生效。
 */
interface ConfigFormsFace {
  get(entryId: string): ConfigFormFace
}

/**
 * 取 `ctx.configForms` 并收窄到 {@link ConfigFormsFace}。
 *
 * 属性访问要求服务名逐字出现在某个 fiber 的 `inject` 里 —— 本文件用的是**嵌套**
 * `ctx.inject(['configForms'], …)`。
 *
 * @param ctx - 浏览器端 Cordis 上下文。
 * @returns 收窄后的配置服务面。
 */
function configFormsOf(ctx: Context): ConfigFormsFace {
  return (ctx as unknown as { configForms: ConfigFormsFace }).configForms
}

/**
 * 浏览器计时器没有 `unref`；Node 里有 —— 产物契约测试会在 Node 里求值本模块，
 * 不 unref 就有一条计时器吊着事件循环。有就调，没有就跳过。
 *
 * @param timer - `setTimeout` 的返回值（浏览器是数字，Node 是带 `unref` 的对象）。
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate: unknown = timer
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'unref' in candidate &&
    typeof candidate.unref === 'function'
  ) {
    candidate.unref()
  }
}

// 取值逐条对齐官方配置表单的样式表（`ui-primitives/src/settings-form/`）：
// 无外框、无圆角、无底色、无内边距 —— 一列控件直接铺在插件页的 `data-plugin-config` 区里；
// 没有折叠头（标题与面包屑由插件页自己画）。
const S = {
  form: { display: 'flex', flexDirection: 'column' },
  readOnly: {
    margin: '12px 0 0',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' },
  // 开关行：逐条对齐官方 SubagentModelSelectionCard 的 .toggleRow / .toggleLabel，
  // 右侧放原生 `Switch`（同一个 ui-primitives 包），因此外观与官方卡片一致。
  toggleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-primary)',
  },
  toggleLabel: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5 },
  // 状态行：比说明行重一档（secondary 对 tertiary），一行说清开关当前的含义。
  stateNote: {
    margin: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-secondary)',
  },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  // 失败文本占满剩余宽度（flex:1），没有失败文本时按钮就靠左。
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingTop: 16,
  },
  // 保存按钮：**逐条对齐官方 `SettingsForm.module.css` 的 `.save`**（维护者 2026-10-15 指定）——
  // 官方设置页**不用**共享 Button（那是 md 档 36px 高），而是这一款紧凑定制按钮（5px 14px / 13px）。
  // 用共享 Button 会与同一张 Plugins 页上其它插件的保存按钮**长得不一样**，而它们本该是同一款。
  save: {
    appearance: 'none',
    border: '1px solid transparent',
    borderRadius: 'var(--dsw-radius-md)',
    padding: '5px 14px',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.5,
    cursor: 'pointer',
    background: 'var(--dsw-alias-label-primary)',
    color: 'var(--dsw-alias-bg-layer-3)',
  },
  // 官方 `.save:disabled` 的 opacity 0.4 与默认光标，等价改写成对象形式。
  saveDisabled: { opacity: 0.4, cursor: 'default' },
  // 错误色用有定义的那个令牌：原生照抄来的 `label-error` 在 ui-theme 里从未定义，
  // 写了不会报错但不会生效（见 [AGENTS.md](./AGENTS.md)）。
  failed: {
    flex: 1,
    minWidth: 0,
    margin: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-state-error-primary)',
  },
} satisfies Record<string, CSSProperties>

/** 卡片 props；`t` 由框架按注册时声明的 locale 命名空间注入。 */
interface CardProps {
  /**
   * 为**本插件的 loader 条目**取到的表单读写面（{@link ENTRY_ID}）。
   *
   * `configForms.get()` 从不返回 undefined，所以这里**必有**；命名空间不在册时
   * 快照的 `status` 是 `'unavailable'`、`writable` 是 false，卡片按既有只读文案渲染 ——
   * 「宿主不提供这个命名空间」与「描述还没回来」对用户是同一件事，因此不新增可见状态。
   */
  readonly form: ConfigFormFace
  readonly t: CardTranslate
}

/**
 * 一张配置卡片：一个总闸开关，底部一次性写入。
 *
 * 草稿只活在组件本地状态里 —— 卸载即丢弃（原生表单同款语义），因此没有「放弃」控件；
 * 保存成功同时清空草稿，失败则保留草稿与诊断供修正。
 *
 * **快照归卡片自己订阅**：`plugins.bundle.config` 的座位里没有 `form`，所以没有
 * 「页面重渲染把新值推进来」这条路 —— 卡片自己 `getSnapshot` + `subscribe`，宿主在别处改了
 * 配置（或 `mutate` 把应答折回镜像）时卡片就会更新。
 *
 * @param props - 本插件条目的表单面，以及框架注入的翻译座位。
 * @returns 卡片元素。
 */
function RestartCard({ form, t }: CardProps): JSX.Element {
  const snapshot = useSyncExternalStore(
    (onChange) => form.subscribe(onChange),
    () => form.getSnapshot(),
  )
  const section = snapshot.value ?? {}

  const [draft, setDraft] = useState<boolean | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState('')

  const writable = snapshot.status === 'ready' && snapshot.writable
  const disabled = !writable || saving
  // 只认 `=== true`：这一格是布尔总闸，别的形状（如缺席）一律读作「关」——
  // 而「关」正是默认值，也正是安全侧那一端。
  const effective = section[ENABLE_FIELD] === true
  const shown = draft ?? effective
  const dirty = draft !== undefined && draft !== effective
  const blocked = !dirty || disabled

  const save = async (): Promise<void> => {
    setSaving(true)
    setFailed('')
    try {
      // 一次**原子**写，走同一个 revision 栅栏。
      // 显式写 `false` 而不是 unset：默认已经是 false，写 false 让用户层保持「有这条决定」，
      // 界面与盘上的配置不会分道扬镳。
      const ops: PathOp[] = [{ op: 'set', path: [ENABLE_FIELD], value: shown }]
      // `mutate` 返回 boolean：false = 宿主拒绝（多半是 revision 冲突），传输错误仍然 reject，
      // 由下面的 catch 一起收口。拒绝必须说出来 —— 悄悄丢弃草稿等于让用户以为保存成功了。
      if (!(await form.mutate(ops, snapshot.revision))) throw new Error(t('saveRejected'))
      setDraft(undefined)
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={S.form}>
      {/* 命名空间不在册（`status === 'unavailable'`）或宿主不可写时落到这里：读作「不可写」，
          不新增可见状态。描述还没回来（`loading`）时不显示，免得闪一行假提示。 */}
      {!writable && snapshot.status !== 'loading' ? (
        <p style={S.readOnly} role="status">
          {t('readOnly')}
        </p>
      ) : null}

      <div style={S.field}>
        <div style={S.toggleRow}>
          <span style={S.toggleLabel}>{t('enableRestartLabel')}</span>
          <Switch
            checked={shown}
            label={t('enableRestartLabel')}
            disabled={disabled}
            onChange={(next) => {
              setDraft(next)
            }}
          />
        </div>
        {/* 状态行：拨动即换文案，用户不必从开关位置反推它到底做了什么。 */}
        <p style={S.stateNote}>{t(shown ? 'enableRestartOn' : 'enableRestartOff')}</p>
        {/* 「改值不用重启」与「装上客户端半边要重启一次」是**两件事**，所以合成一句时用「例外」把
            一次性安装代价显式带出来 —— 压掉后半句，用户就会在首次装上之后以为「说好的不用重启」。
            维护者 2026-10-15 要求这张卡片就是三行（标题 + 两行说明），故合并到这一行。 */}
        <p style={S.hint}>{t('enableRestartHint')}</p>
      </div>

      <div style={S.footer}>
        {failed !== '' ? (
          <p style={S.failed} role="status">
            {failed}
          </p>
        ) : null}
        {/* 原生 button + 官方 `.save` 的逐条取值：官方设置页就是这么渲染的。
            ⚠️ 官方 CSS 还有 `.save:focus-visible`（outline + offset）—— 内联样式**表达不了伪类**，
            所以这一条**没搬**（参照仓也没搬）。它不是可用性缺口：默认的 UA focus ring 仍在。 */}
        <button
          type="button"
          disabled={blocked}
          style={blocked ? { ...S.save, ...S.saveDisabled } : S.save}
          onClick={() => {
            void save()
          }}
        >
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  )
}

/**
 * 注册配置卡片与它的字典。
 *
 * 槽是插件管理页的 `plugins.bundle.config`，`key` 是**包名**（见 {@link BUNDLE_NAME}）：
 * 页面按它寻址一个 bundle 的配置，写错即整块不出现。**只给 `page`** ——
 * 该槽只渲染 `page`，`summary` 没有任何渲染路径，所以不留那条死文案。
 *
 * `configForms` 走**嵌套 `ctx.inject`** 而不是写进模块级 {@link inject}：
 * 后者是**激活门禁**，会让更早宿主上的整个客户端半体 pending（字典、探测连发声机会都没有）。
 * 嵌套的代价只是「卡片可选」，而且这个缺席**可观测**（探测的那条 WARN 正是报它）。
 *
 * 字典注册进 `ctx.effect`，插件卸载时随之注销（`register` 返回 disposer）。
 *
 * @param ctx - 浏览器端 Cordis 上下文。
 */
export function apply(ctx: Context): void {
  // **typed 形态** `register(ns, dicts)`：一次注册全部语言，界面跟随语言切换。
  // 维护者 2026-10-15 拍板要中英文 —— 顺带这也拿回了「key 拼错即编译错误」这道护栏
  // （单语言形态下它会退化，理由见 [locales.ts](./locales.ts)）。
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, RESTART_TOGGLE_LOCALES),
    'dsh-plugin-debugging: card dictionaries',
  )

  // 能力探测：**只新增提示路径**，注册的槽名 / key / 时机一字不动。
  //
  // 「拿不到表单」这条链上有两环，各自会独立地断、表现都是静默，所以**各给一个窗口**：
  // 一个盯服务 `configForms` 到没到，一个盯槽 `plugins.bundle.config` 到没到。
  // 分开计时是为了让「哪一环缺席」这件事本身不含糊 —— 合用一个窗口时，服务迟到会把槽那一条
  // 提示一起撤掉，而槽可能压根不会来（那正是要报的另一种缺席）。
  //
  // 两个窗口都在 `apply` 期开：**探测不改变注册时机**，只是给这段时间加一个观察者。
  // 状态活在 apply 的闭包里（模块顶层不得有状态），计时器由 ctx.effect 拥有并释放。
  let serviceDeclared = false
  let slotDeclared = false

  /** 一环的探测状态：一个窗口、一个「窗口已过、正等它到账」的标记、一个撤销口。 */
  interface ProbeRing {
    timer: ReturnType<typeof setTimeout> | undefined
    /** 窗口过去了而它还没到 —— 无论当时报没报（不值得报的那一环会是静默的）。 */
    announced: boolean
    /** 到账时调用：停掉窗口；窗口已过就补一条 INFO（当时没报过的环也是——它迟到了）。 */
    settle: () => void
  }

  /**
   * 给一环开窗口。
   *
   * 到点时仍没到账就发一条 WARN（不值得报的那一环只记下「窗口过了」）；到账则停掉窗口，
   * 窗口已过就补一条 INFO。两环**各自**持有窗口与标记，所以一环迟到不会误撤另一环的提示。
   *
   * @param warning - 到点仍未到账时写客户端控制台的那条。
   * @param info - 迟到时撤销自己那条的那条。
   * @param isDeclared - 这一环到没到账。
   * @param relevant - 这一环还值不值得**报**；缺省恒真。槽那一个用它把自己压住 ——
   *   服务都没到时就报「槽缺席」是在替另一环说话（而且一次超时会变成两条，噪音）。
   *   注意它只压住「报」，不压住「撤」：到点时还不值得报的环仍然保持待命，
   *   之后真到账了照样补一条 INFO —— 迟到的到账本来就该有回音。
   */
  const armProbe = (
    warning: string,
    info: string,
    isDeclared: () => boolean,
    relevant: () => boolean = () => true,
  ): ProbeRing => {
    const ring: ProbeRing = { timer: undefined, announced: false, settle: () => undefined }
    ring.timer = setTimeout(() => {
      ring.timer = undefined
      if (isDeclared()) return
      ring.announced = true
      if (relevant()) console.warn(warning)
    }, PROBE_TIMEOUT_MS)
    unrefTimer(ring.timer)
    ring.settle = () => {
      if (ring.timer !== undefined) clearTimeout(ring.timer)
      ring.timer = undefined
      if (!ring.announced) return
      ring.announced = false
      console.info(info)
    }
    return ring
  }

  let serviceProbe: ProbeRing | undefined

  ctx.effect(() => {
    serviceProbe = armProbe(SERVICE_MISSING_WARNING, SERVICE_LATE_INFO, () => serviceDeclared)
    return () => {
      if (serviceProbe?.timer !== undefined) clearTimeout(serviceProbe.timer)
      serviceProbe = undefined
    }
  }, 'dsh-plugin-debugging: configuration service probe')

  let slotProbe: ProbeRing | undefined

  ctx.effect(() => {
    // 服务缺席时这一环不发声：那时「槽在不在」还没到判的时候，报出来是替服务那一环说话。
    slotProbe = armProbe(
      SLOT_MISSING_WARNING,
      SLOT_LATE_INFO,
      () => slotDeclared,
      () => serviceDeclared,
    )
    return () => {
      if (slotProbe?.timer !== undefined) clearTimeout(slotProbe.timer)
      slotProbe = undefined
    }
  }, 'dsh-plugin-debugging: configuration slot probe')

  ctx.inject(['configForms'], (scoped) => {
    serviceDeclared = true
    serviceProbe?.settle()

    // 表单在这个作用域里取一次即可：服务按 entry id 缓存，返回同一个对象，
    // 所以不必每次渲染重取。
    const form = configFormsOf(scoped).get(ENTRY_ID)

    ctx.slots.inject('plugins.bundle.config', () => {
      slotDeclared = true
      slotProbe?.settle()

      return ctx.slots.register(
        { name: 'plugins.bundle.config', key: BUNDLE_NAME, locale: LOCALE_NS },
        (seat: { t: CardTranslate; view: 'page' }) => <RestartCard form={form} t={seat.t} />,
      )
    })
  })
}
