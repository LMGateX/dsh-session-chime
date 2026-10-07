/**
 * Row configuration: the Schemastery schema the Plugins page renders.
 *
 * The schema is a native Schemastery node exported as `Config` from the package
 * entry, because DSH only generates a configuration form for rows whose module
 * publishes one. Two host rules shape it:
 *
 * - The settings service builds a form only from VOLATILE fields (`volatileForm`
 *   returns undefined when no field carries `meta.volatile`), and `write`
 *   rejects every path that is not beneath one. Every field here is therefore
 *   volatile, which also means "applies live": the browser half re-reads the
 *   accepted value on every change and rings with the new settings at once.
 * - The volatile marker belongs on each field only. Cordis rejects a volatile
 *   node beneath a volatile ancestor, so the union branches stay plain and are
 *   covered by the volatile union above them.
 *
 * The sound ids mirror the generated browser table (`client/sounds.generated.js`,
 * written by `scripts/generate-sounds.ts`); `npm run check:bundle` asserts the
 * two lists agree.
 */
import Schema from '@deepseek-ai/schemastery'

/** Shipped chime ids, in the order the settings page lists them. */
export const soundIds = ['chime-soft', 'bell-bright', 'marimba', 'alert-low', 'alert-sharp', 'blip'] as const

/** One shipped chime. */
export type SoundId = (typeof soundIds)[number]

/** How a quiet period (do-not-disturb window, rest mode) treats a chime. */
export const quietStyles = ['short', 'silent'] as const

/** One quiet-period style. */
export type QuietStyle = (typeof quietStyles)[number]

/**
 * Upper bound for any duration field: six hours.
 *
 * A long ring is a legitimate choice — it repeats the chime until the window
 * elapses and stops on the next click or key press — so the cap is only there to
 * keep a typo from ringing for a week.
 */
export const MAX_DURATION_MS = 6 * 60 * 60 * 1000

/** `HH:mm` in 24-hour local time, or the empty string for "always". */
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** One configuration field as the loader may hand it over: a plain value or a volatile accessor. */
export type Live<T> = T | { get(): T }

/** Raw row configuration as the loader passes it in. Every field is optional. */
export interface RowConfig {
  /** Master switch; false silences every chime without touching the row. */
  readonly enabled?: Live<boolean>
  /** Chime played when a session settles with nothing left to do. */
  readonly soundDone?: Live<SoundId>
  /** Chime played when the session's goal becomes blocked. */
  readonly soundBlocked?: Live<SoundId>
  /** Output gain, 0–1. */
  readonly volume?: Live<number>
  /** Longest playback window in milliseconds; 0 plays each chime exactly once. */
  readonly durationMs?: Live<number>
  /** How long a session must stay quiet before it counts as settled. */
  readonly debounceMs?: Live<number>
  /** What a quiet period does: shorten the chime or drop it. */
  readonly quietStyle?: Live<QuietStyle>
  /** Playback window used inside a quiet period when `quietStyle` is `short`. */
  readonly quietShortMs?: Live<number>
  /** Do-not-disturb window start (`HH:mm`, local time); empty disables the window. */
  readonly dndStart?: Live<string>
  /** Do-not-disturb window end (`HH:mm`, local time); empty disables the window. */
  readonly dndEnd?: Live<string>
  /** Rest mode: treat every chime as if it were inside the do-not-disturb window. */
  readonly restMode?: Live<boolean>
  /** Shortest ring before pointer or key activity may stop it. */
  readonly minRingMs?: Live<number>
  /** Whether a ring shows the stop banner. */
  readonly banner?: Live<boolean>
}

/** Plain row configuration, as tests and hand-written compositions pass it. */
export interface RowConfigInput {
  /** Master switch; false silences every chime without touching the row. */
  readonly enabled?: boolean
  /** Chime played when a session settles with nothing left to do. */
  readonly soundDone?: SoundId
  /** Chime played when the session's goal becomes blocked. */
  readonly soundBlocked?: SoundId
  /** Output gain, 0–1. */
  readonly volume?: number
  /** Longest playback window in milliseconds; 0 plays each chime exactly once. */
  readonly durationMs?: number
  /** How long a session must stay quiet before it counts as settled. */
  readonly debounceMs?: number
  /** What a quiet period does: shorten the chime or drop it. */
  readonly quietStyle?: QuietStyle
  /** Playback window used inside a quiet period when `quietStyle` is `short`. */
  readonly quietShortMs?: number
  /** Do-not-disturb window start (`HH:mm`, local time); empty disables the window. */
  readonly dndStart?: string
  /** Do-not-disturb window end (`HH:mm`, local time); empty disables the window. */
  readonly dndEnd?: string
  /** Rest mode: treat every chime as if it were inside the do-not-disturb window. */
  readonly restMode?: boolean
  /** Shortest ring before pointer or key activity may stop it. */
  readonly minRingMs?: number
  /** Whether a ring shows the stop banner. */
  readonly banner?: boolean
}

/** Validated row configuration with every default applied. */
export interface ResolvedRowConfig {
  readonly enabled: boolean
  readonly soundDone: SoundId
  readonly soundBlocked: SoundId
  readonly volume: number
  readonly durationMs: number
  readonly debounceMs: number
  readonly quietStyle: QuietStyle
  readonly quietShortMs: number
  readonly dndStart: string
  readonly dndEnd: string
  readonly restMode: boolean
  readonly minRingMs: number
  readonly banner: boolean
}

/** Configuration keys this row accepts; anything else is a composition error. */
export const knownRowKeys: readonly string[] = [
  'enabled', 'soundDone', 'soundBlocked', 'volume', 'durationMs', 'debounceMs',
  'quietStyle', 'quietShortMs', 'dndStart', 'dndEnd', 'restMode', 'minRingMs', 'banner',
]

/**
 * Read one field, unwrapping the volatile accessor when the loader provided one.
 *
 * Booleans, strings and numbers are never volatile values themselves, so the
 * duck-typed check cannot misfire on this schema; it is deliberately not an
 * import of the host's `isVolatile`, so the package keeps its dependency set.
 *
 * @param value - the raw field value or accessor.
 * @returns the current value, or undefined when the field was not configured.
 */
export function liveValue<T>(value: Live<T> | undefined): T | undefined {
  if (value === null || typeof value !== 'object') return value as T | undefined
  const read = Reflect.get(value, 'get')
  return typeof read === 'function' ? (read.call(value) as T) : (value as T)
}

/** Mark one schema node live: the host renders and writes only volatile fields. */
function live<T extends Schema>(node: T): T {
  return node.volatile() as T
}

/**
 * The row schema the Plugins page renders; every field applies live.
 *
 * Descriptions are bilingual because the generated form prints them verbatim.
 */
export const Config = Schema.object({
  enabled: live(Schema.boolean().default(true).description(
    '总开关。关闭后不再有任何提示音，但插件行与本页设置都保留。' +
    ' Master switch: no chime plays while this is off; the row and its settings stay.',
  )),
  soundDone: live(Schema.union(soundIds.map(id => Schema.const(id).description(id))).default('chime-soft').description(
    '主 agent 完全停下（没有运行中的回合、没有后台作业、没有在工作的子代理）时播放的铃声。' +
    ' Chime for a session that settled with nothing left to do. Default: chime-soft.',
  )),
  soundBlocked: live(Schema.union(soundIds.map(id => Schema.const(id).description(id))).default('alert-low').description(
    '会话的目标进入 blocked（受阻）状态时播放的铃声。' +
    ' Chime for a goal that became blocked. Default: alert-low.',
  )),
  volume: live(Schema.number().min(0).max(1).default(0.8).description(
    '音量，0–1。保存后在下一声生效。' +
    ' Output gain, 0–1; applies from the next chime.',
  )),
  durationMs: live(Schema.natural().default(0).description(
    '播放时长上限（毫秒，最大 21600000＝6 小时）。0＝每声完整播放一次；正数＝最多响这么久，短铃声按间隔重复到时长用完为止。' +
    ' Longest playback window in ms (max 21600000 = 6 h). 0 plays each chime exactly once; a positive value repeats a short chime until the window is used up.',
  )),
  debounceMs: live(Schema.natural().default(1500).description(
    '安静判定（毫秒）：会话停止后需要安静这么久才判定为“结束”，用来躲开回合之间的间隙。' +
    ' How long a session must stay quiet before it counts as settled; this is what keeps inter-round gaps silent.',
  )),
  quietStyle: live(Schema.union([
    Schema.const('short').description('短响：只响 quietShortMs 那么久。 Shorten the chime to quietShortMs.'),
    Schema.const('silent').description('不响：静默，什么都不播。 Stay silent.'),
  ]).default('short').description(
    '勿扰时段与休息模式下怎么处理提示音。' +
    ' What a quiet period (do-not-disturb window or rest mode) does with a chime. Default: short.',
  )),
  quietShortMs: live(Schema.natural().default(600).description(
    '安静期间“短响”的时长（毫秒）。' +
    ' Playback window used inside a quiet period when the style is “short” (ms).',
  )),
  dndStart: live(Schema.string().default('').description(
    '勿扰时段开始（本地时间 HH:mm，例如 22:00）。留空表示不用勿扰时段；开始与结束相同也视为关闭。' +
    ' Do-not-disturb window start (local HH:mm, e.g. 22:00). Empty disables it; equal start and end also disables it.',
  )),
  dndEnd: live(Schema.string().default('').description(
    '勿扰时段结束（本地时间 HH:mm，例如 08:00）。结束早于开始表示跨午夜。' +
    ' Do-not-disturb window end (local HH:mm, e.g. 08:00). An end earlier than the start crosses midnight.',
  )),
  restMode: live(Schema.boolean().default(false).description(
    '休息模式：打开后等同于一直处于勿扰时段（按上面的方式短响或静默）；这个开关也可以从侧边栏底部的按钮直接切换。' +
    ' Rest mode: while on, every chime is treated as inside the do-not-disturb window. The sidebar footer button toggles it directly.',
  )),
  minRingMs: live(Schema.natural().default(3000).description(
    '最短响铃（毫秒）：在这之前鼠标/键盘活动不会打断铃声，保证长响铃至少被听到这么久；卡片上的“停止铃声”按钮不受此限制。' +
    ' Shortest ring in ms: pointer or key activity cannot stop a chime before this, so a long ring is always heard; the banner stop button ignores it.',
  )),
  banner: live(Schema.boolean().default(true).description(
    '响铃时在界面上弹出提示卡，写明是哪个会话完成/受阻，并带一个“停止铃声”按钮。' +
    ' Show a stop banner while ringing: it names the session and offers one big stop button.',
  )),
})

/**
 * Validate raw row configuration, read every live field, and apply defaults.
 *
 * @param config - the raw config the loader passed to the plugin.
 * @returns the resolved row policy, as of this call.
 * @throws Error naming the offending field, so a bad composition fails at load.
 */
export function resolveRowConfig(config: RowConfig | RowConfigInput = {}): ResolvedRowConfig {
  for (const key of Object.keys(config)) {
    if (!knownRowKeys.includes(key)) throw new Error(`session-chime: unknown configuration option "${key}"`)
  }
  return {
    enabled: optionalBoolean('enabled', liveValue(config.enabled)) ?? true,
    soundDone: optionalSound('soundDone', liveValue(config.soundDone)) ?? 'chime-soft',
    soundBlocked: optionalSound('soundBlocked', liveValue(config.soundBlocked)) ?? 'alert-low',
    volume: optionalUnit('volume', liveValue(config.volume)) ?? 0.8,
    durationMs: optionalDuration('durationMs', liveValue(config.durationMs)) ?? 0,
    debounceMs: optionalDuration('debounceMs', liveValue(config.debounceMs)) ?? 1500,
    quietStyle: optionalQuietStyle(liveValue(config.quietStyle)) ?? 'short',
    quietShortMs: optionalDuration('quietShortMs', liveValue(config.quietShortMs)) ?? 600,
    dndStart: optionalClock('dndStart', liveValue(config.dndStart)) ?? '',
    dndEnd: optionalClock('dndEnd', liveValue(config.dndEnd)) ?? '',
    restMode: optionalBoolean('restMode', liveValue(config.restMode)) ?? false,
    minRingMs: optionalDuration('minRingMs', liveValue(config.minRingMs)) ?? 3000,
    banner: optionalBoolean('banner', liveValue(config.banner)) ?? true,
  }
}

function optionalBoolean(field: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`session-chime: ${field} must be a boolean`)
  return value
}

function optionalSound(field: string, value: unknown): SoundId | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(soundIds as readonly string[]).includes(value)) {
    throw new Error(`session-chime: ${field} must be one of ${soundIds.join(', ')}`)
  }
  return value as SoundId
}

function optionalQuietStyle(value: unknown): QuietStyle | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(quietStyles as readonly string[]).includes(value)) {
    throw new Error(`session-chime: quietStyle must be one of ${quietStyles.join(', ')}`)
  }
  return value as QuietStyle
}

function optionalUnit(field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`session-chime: ${field} must be a number between 0 and 1`)
  }
  return value
}

function optionalDuration(field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_DURATION_MS) {
    throw new Error(`session-chime: ${field} must be a whole number of milliseconds between 0 and ${MAX_DURATION_MS}`)
  }
  return value
}

function optionalClock(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || (value !== '' && !CLOCK.test(value))) {
    throw new Error(`session-chime: ${field} must be an empty string or a local HH:mm time`)
  }
  return value
}
