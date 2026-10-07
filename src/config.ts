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
}

/** Validated row configuration with every default applied. */
export interface ResolvedRowConfig {
  readonly enabled: boolean
  readonly soundDone: SoundId
  readonly soundBlocked: SoundId
  readonly volume: number
  readonly durationMs: number
  readonly debounceMs: number
}

/** Configuration keys this row accepts; anything else is a composition error. */
export const knownRowKeys: readonly string[] = ['enabled', 'soundDone', 'soundBlocked', 'volume', 'durationMs', 'debounceMs']

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
    '播放时长上限（毫秒）。0＝每声完整播放一次；正数＝最多响这么久，铃声较短时自动重复（上限 8 秒）。' +
    ' Longest playback window in ms; 0 plays each chime exactly once, a positive value repeats a short chime up to that window (capped at 8 s).',
  )),
  debounceMs: live(Schema.natural().default(1500).description(
    '安静判定（毫秒）：会话停止后需要安静这么久才判定为“结束”，用来躲开回合之间的间隙。' +
    ' How long a session must stay quiet before it counts as settled; this is what keeps inter-round gaps silent.',
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
  const enabled = optionalBoolean('enabled', liveValue(config.enabled)) ?? true
  const volume = optionalUnit('volume', liveValue(config.volume)) ?? 0.8
  return {
    enabled,
    soundDone: optionalSound('soundDone', liveValue(config.soundDone)) ?? 'chime-soft',
    soundBlocked: optionalSound('soundBlocked', liveValue(config.soundBlocked)) ?? 'alert-low',
    volume,
    durationMs: optionalDuration('durationMs', liveValue(config.durationMs)) ?? 0,
    debounceMs: optionalDuration('debounceMs', liveValue(config.debounceMs)) ?? 1500,
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

function optionalUnit(field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`session-chime: ${field} must be a number between 0 and 1`)
  }
  return value
}

function optionalDuration(field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`session-chime: ${field} must be a non-negative whole number of milliseconds`)
  }
  return value
}
