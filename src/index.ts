/**
 * dsh-session-chime: a chime when a session really stops.
 *
 * The host half publishes {@link Config} — the volatile row schema the Plugins
 * page renders — and mounts nothing else. Every decision and every sound lives
 * in the browser half, which watches the public client services (session
 * running state, job rosters, subagent lineage, the goal projection) and rings
 * only when a top-level session has no running turn, no live job owned by it
 * and no working subagent left.
 *
 * There is no host-side interception and no background timer: with the page
 * closed, nothing rings, which is exactly the intended contract.
 *
 * @see ./config.ts for the schema.
 */
import { Config, resolveRowConfig, type RowConfigInput } from './config.ts'

/** Registered plugin name. */
export const name = 'session-chime'

/** The host half needs no service: the chime is browser-side. */
export const inject: readonly string[] = []

/** The Schemastery schema DSH renders on the plugin card. */
export { Config } from './config.ts'

export type { RowConfig, RowConfigInput, ResolvedRowConfig, SoundId } from './config.ts'

/** Minimal structural view of the host context this plugin uses. */
interface HostContext {
  /** The host logger, used for the one mount line. */
  readonly logger: { debug(message: string): void }
}

/**
 * Validate the row configuration and record the mount.
 *
 * The browser half reads the same row through the public settings service, so
 * nothing is stored here and no listener is registered.
 *
 * @param ctx - host context.
 * @param config - row configuration; defaults live in the schema.
 */
export function apply(ctx: HostContext, config: RowConfigInput = {}): void {
  const resolved = resolveRowConfig(config)
  ctx.logger.debug(
    `session-chime: mounted (enabled=${resolved.enabled}, soundDone=${resolved.soundDone}, ` +
    `soundBlocked=${resolved.soundBlocked}, volume=${resolved.volume}, durationMs=${resolved.durationMs}, ` +
    `debounceMs=${resolved.debounceMs}) — the browser half owns every chime.`,
  )
}

/** Mountable plugin value, also usable from tests and manual compositions. */
export const sessionChime = { name, inject, apply, Config }
