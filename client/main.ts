/**
 * Browser half of dsh-session-chime: watch every top-level session of this
 * instance and ring when one really stops.
 *
 * "Really stops" is complete quiescence — the session is not running, owns no
 * live background job and has no working subagent — so an agent that merely
 * waits on background work stays silent. A goal that becomes blocked rings on
 * its own chime. The settings row is this bundle's `plugins.row.config` entry:
 * sound choice, volume, playback window and the quiet-period threshold all save
 * through the public settings service and apply at once.
 *
 * The web shell fetches this file as a classic script and concatenates several
 * bundles into one combo response, so it has to stay a script: no ESM syntax
 * anywhere, and every declaration inside the single registration factory below so
 * that nothing can collide with another bundle sharing the same response.
 * @module dsh-session-chime/client
 */

interface Window {
  /** The shell's module-loader facade: each plugin registers one factory. */
  __ModuleLoader__: {
    load(entry: { id: string; factory(require: (name: string) => unknown): unknown }): void
  }
  /** Browser audio constructor, unprefixed or the legacy prefixed name. */
  webkitAudioContext?: new () => AudioContext
}

/** The chime table scripts/build-client.mjs prepends from client/sounds.generated.js. */
declare const __CHIME_SOUNDS: Record<string, { label: string; durationMs: number; data: string }>

window.__ModuleLoader__.load({
  id: 'dsh-session-chime',
  factory(require) {
    // Type-only views of the published platform contracts. `import(...)` in a type
    // position is erased at build time, so this file keeps compiling as a script
    // instead of turning into a module with ESM syntax of its own.
    type ClientContext = import('./public.js').ClientContext
    type ConfigForm = import('./public.js').ConfigForm
    type ConfigFormSnapshot = import('./public.js').ConfigFormSnapshot
    type ChimeReason = import('./public.js').ChimeReason
    type ChimeSettings = import('./public.js').ChimeSettings
    type JobRow = import('./public.js').JobRow
    type PathOperation = import('./public.js').PathOperation
    type ReactRuntime = import('./public.js').ReactRuntime
    type RingInfo = import('./public.js').RingInfo
    type SessionListSnapshot = import('./public.js').SessionListSnapshot

    const React = require('react') as ReactRuntime

    /** Loader row id declared by this bundle's patch. */
    const ROW_ID = 'session-chime'

    /** The bundle id the shell registers; must match the npm package name. */
    const BUNDLE_ID = 'dsh-session-chime'

    /** Job statuses that count as live work for the owning session. */
    const LIVE_JOB = ['running', 'stopping']

    /** Longest playback window a saved duration can request (mirrors src/config.ts). */
    const MAX_WINDOW_MS = 6 * 60 * 60 * 1000

    /** Local `HH:mm`, or the empty string for "always". */
    const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/

    /** Gap between repeats when a short chime is stretched over a longer window. */
    const REPEAT_GAP_SECONDS = 0.12

    /** Shortest gap between two chimes for one session. */
    const COOLDOWN_MS = 3000

    /** How long a session stays on the watch list after its last running observation. */
    const WATCH_TAIL_MS = 10 * 60 * 1000

    /**
     * The settle predicate, exported for tests: a session is settled when no turn
     * is running, it owns no live job and no working subagent, and its goal is not
     * active. `blocked` counts as settled because a blocked goal stops on purpose;
     * the immediate blocked chime is deduplicated by the per-session cooldown.
     * @param input - the four observations that decide it.
     * @returns whether the session counts as stopped.
     */
    function isSettled(input: {
      running: boolean
      liveJobs: number
      liveChildren: number
      goalPhase: string | null
    }): boolean {
      return !input.running && input.liveJobs === 0 && input.liveChildren === 0 && input.goalPhase !== 'active'
    }

    /**
     * Watch every top-level session and decide when one settles.
     *
     * All timers and services are injected so the logic runs under a fake clock in
     * tests. `watch(sessionId)`/`unwatch(sessionId)` mirror the job-roster
     * subscription the runtime holds for recently active sessions.
     */
    function createWatcher(deps: {
      now(): number
      setTimer(callback: () => void, delayMs: number): unknown
      clearTimer(handle: unknown): void
      readSettings(): ChimeSettings
      ring(reason: ChimeReason, session: { id: string; title: string }): void
      watch(sessionId: string): void
      unwatch(sessionId: string): void
    }): { update(sessions: SessionListSnapshot, jobs: { readonly rows: Readonly<Record<string, readonly JobRow[]>> } | undefined): void } {
      interface Tracked {
        /** Last observed running state (undefined until the first observation). */
        running: boolean | undefined
        /** Last observed goal phase. */
        phase: string | null
        /** Whether this session has been seen running since the page loaded. */
        sawBusy: boolean
        /** Whether the current quiet stretch already rang. */
        notified: boolean
        /** Last time the session was observed running. */
        lastBusyAt: number
        /** Pending settle check. */
        timer: unknown
        /** Whether a job-roster subscription is held. */
        watched: boolean
        /** Latest observation, kept so the debounced check reads fresh numbers. */
        observation: { running: boolean; liveJobs: number; liveChildren: number; goalPhase: string | null }
        /** Human-facing label, so the banner can name the session. */
        title: string
      }

      const tracked = new Map<string, Tracked>()

      /** Live jobs owned by one session (an unowned job is visible to every roster). */
      function liveJobsOf(sessionId: string, jobs: { readonly rows: Readonly<Record<string, readonly JobRow[]>> } | undefined): number {
        const rows = jobs?.rows?.[sessionId]
        if (rows === undefined) return 0
        let live = 0
        for (const job of rows) {
          if (job.owner !== sessionId) continue
          if (LIVE_JOB.includes(String(job.status))) live += 1
        }
        return live
      }

      /** Working direct children of one session, from the catalog's own running flags. */
      function liveChildrenOf(sessionId: string, sessions: SessionListSnapshot): number {
        let live = 0
        for (const childId of sessions.ids) {
          const child = sessions.byId[childId]
          if (child === undefined || child.parentId !== sessionId) continue
          if (child.running === true) live += 1
        }
        return live
      }

      /** The catalog's human-facing label for one row. */
      function titleOf(row: unknown): string {
        const source = row as { displayTitle?: unknown; title?: unknown; id?: unknown } | undefined
        if (typeof source?.displayTitle === 'string' && source.displayTitle !== '') return source.displayTitle
        if (typeof source?.title === 'string' && source.title !== '') return source.title
        return typeof source?.id === 'string' ? source.id : ''
      }

      /** The session's current goal phase, absent when it has no goal capability or no goal. */
      function phaseOf(row: unknown): string | null {
        const values = (row as { projectionValues?: { goal?: { goal?: { phase?: unknown } } | null } } | undefined)?.projectionValues
        const phase = values?.goal?.goal?.phase
        return typeof phase === 'string' ? phase : null
      }

      /** Run the settle check for one session after its quiet period elapsed. */
      function check(sessionId: string): void {
        const state = tracked.get(sessionId)
        if (state === undefined) return
        state.timer = undefined
        if (state.notified) return
        if (!isSettled(state.observation)) return
        state.notified = true
        deps.ring('done', { id: sessionId, title: state.title })
      }

      /** Schedule the debounced settle check for one session. */
      function schedule(sessionId: string): void {
        const state = tracked.get(sessionId)
        if (state === undefined || state.timer !== undefined || state.notified) return
        const { debounceMs } = deps.readSettings()
        if (debounceMs <= 0) {
          check(sessionId)
          return
        }
        state.timer = deps.setTimer(() => check(sessionId), debounceMs)
      }

      /** Drop every trace of a session that left the catalog. */
      function forget(sessionId: string, state: Tracked): void {
        if (state.timer !== undefined) deps.clearTimer(state.timer)
        if (state.watched) deps.unwatch(sessionId)
        tracked.delete(sessionId)
      }

      return {
        update(sessions, jobs) {
          const now = deps.now()
          const seen = new Set<string>()
          for (const sessionId of sessions.ids) {
            const row = sessions.byId[sessionId]
            if (row === undefined) continue
            // Subagent sessions are part of their parent's quiet period, never a
            // chime of their own.
            if (row.parentId !== undefined || row.origin === 'subagent') continue
            seen.add(sessionId)
            let state = tracked.get(sessionId)
            const first = state === undefined
            if (state === undefined) {
              state = {
                running: undefined, phase: null, sawBusy: false, notified: false,
                lastBusyAt: 0, timer: undefined, watched: false, title: titleOf(row),
                observation: { running: false, liveJobs: 0, liveChildren: 0, goalPhase: null },
              }
              tracked.set(sessionId, state)
            }

            const running = row.running === true
            const phase = phaseOf(row)
            state.title = titleOf(row)
            state.observation = {
              running,
              liveJobs: liveJobsOf(sessionId, jobs),
              liveChildren: liveChildrenOf(sessionId, sessions),
              goalPhase: phase,
            }
            if (running) state.lastBusyAt = now

            // The job roster is subscribed only while the session looks alive (or
            // was a moment ago), so an instance with hundreds of idle sessions opens
            // no streams at all.
            const wantsWatch = running || state.observation.liveJobs > 0 || now - state.lastBusyAt < WATCH_TAIL_MS
            if (wantsWatch && !state.watched) {
              state.watched = true
              deps.watch(sessionId)
            } else if (!wantsWatch && state.watched) {
              state.watched = false
              deps.unwatch(sessionId)
            }

            if (first) {
              // A page that loads while a session is already idle must not ring for
              // it: the first observation only seeds the baseline.
              state.running = running
              state.phase = phase
              state.sawBusy = running
              continue
            }

            // A blocked goal is a stop in its own right and rings at once.
            if (phase === 'blocked' && state.phase !== 'blocked' && state.phase !== null) {
              deps.ring('blocked', { id: sessionId, title: state.title })
            }
            state.phase = phase

            if (running) {
              state.sawBusy = true
              state.notified = false
              if (state.timer !== undefined) {
                deps.clearTimer(state.timer)
                state.timer = undefined
              }
            } else if (state.sawBusy) {
              schedule(sessionId)
            }
            state.running = running
          }
          for (const [sessionId, state] of tracked) if (!seen.has(sessionId)) forget(sessionId, state)
        },
      }
    }

    /** A tiny observable boolean, so one switch can subscribe to a slice of the form. */
    function createFlag(initial: boolean): { getSnapshot(): boolean; subscribe(listener: () => void): () => void; set(value: boolean): void } {
      const listeners = new Set<() => void>()
      let value = initial
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          if (next === value) return
          value = next
          for (const listener of listeners) listener()
        },
      }
    }

    /** A tiny observable holding the ring the banner describes. */
    function createBanner(): {
      getSnapshot(): RingInfo | undefined
      subscribe(listener: () => void): () => void
      show(entry: RingInfo): void
      hide(seq: number): void
    } {
      const listeners = new Set<() => void>()
      let value: RingInfo | undefined
      const publish = (next: RingInfo | undefined): void => {
        value = next
        for (const listener of listeners) listener()
      }
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        show(entry) {
          publish(entry)
        },
        hide(seq) {
          // A newer ring owns the banner; an older promise must not clear it.
          if (value !== undefined && value.seq === seq) publish(undefined)
        },
      }
    }

    /**
     * Whether a gesture may stop the ring that started at `startedAt`.
     *
     * The shortest-ring guard is what keeps a long ring audible: activity before
     * `minRingMs` is ignored, so the chime is always heard for at least that long.
     * The banner's own stop button never goes through this test.
     *
     * @param startedAt - page wall-clock ms of the ring, or undefined when silent.
     * @param now - current page wall-clock ms.
     * @param minRingMs - configured shortest ring.
     * @returns true when a gesture may stop the ring.
     */
    function shouldStopOnGesture(startedAt: number | undefined, now: number, minRingMs: number): boolean {
      return startedAt !== undefined && now - startedAt >= minRingMs
    }

    /**
     * Whether a gesture may stop the current ring, banner placement included.
     *
     * The masked modal is the one placement that ignores activity by design: its
     * whole point is "acknowledge this", so only the button (or the window
     * running out) ends the ring there.
     *
     * @param placement - configured banner placement.
     * @param bannerShown - whether the banner is on at all; without it, no placement applies.
     * @param startedAt - page wall-clock ms of the ring, or undefined when silent.
     * @param now - current page wall-clock ms.
     * @param minRingMs - configured shortest ring.
     * @returns true when a gesture may stop the ring.
     */
    function gestureStopsRing(
      placement: string,
      bannerShown: boolean,
      startedAt: number | undefined,
      now: number,
      minRingMs: number,
    ): boolean {
      if (bannerShown && placement === 'modal') return false
      return shouldStopOnGesture(startedAt, now, minRingMs)
    }

    /** Decode one embedded data URL into raw bytes. */
    function decodeBase64(data: string): ArrayBuffer {
      const comma = data.indexOf(',')
      const binary = atob(comma >= 0 ? data.slice(comma + 1) : data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    }

    /**
     * The audio engine: one lazily created AudioContext, decoded buffers cached by
     * id, and a playback window that repeats a short chime when the saved duration
     * asks for longer than the clip.
     */
    function createAudio(readSettings: () => ChimeSettings): { unlock(): void; play(id: string, windowMs: number): Promise<void>; stop(): void } {
      let context: AudioContext | undefined
      let stopCurrent: (() => void) | undefined
      const buffers = new Map<string, AudioBuffer>()

      function ensure(): AudioContext | undefined {
        if (context !== undefined) return context
        const Ctor = window.AudioContext ?? window.webkitAudioContext
        if (typeof Ctor !== 'function') return undefined
        try {
          context = new Ctor()
        } catch {
          return undefined
        }
        return context
      }

      /** Browsers start audio suspended until a user gesture; every gesture retries. */
      function unlock(): void {
        const audio = ensure()
        if (audio === undefined) return
        if (audio.state === 'suspended') {
          void audio.resume().catch(() => {})
        }
      }

      return {
        unlock,
        stop() {
          stopCurrent?.()
        },
        /**
         * Play one chime for one window.
         *
         * One ring at a time: a new chime replaces whatever is still playing, and a
         * long window is filled by replaying the clip until it runs out.
         *
         * @param id - shipped chime id.
         * @param windowMs - playback window decided by the caller.
         * @returns a promise resolving when the ring ends, however it ends.
         */
        play(id, windowMs) {
          return new Promise<void>(resolve => {
            const spec = __CHIME_SOUNDS[id]
            if (spec === undefined || windowMs <= 0) {
              resolve()
              return
            }
            void (async () => {
              const audio = ensure()
              if (audio === undefined) {
                resolve()
                return
              }
              if (audio.state === 'suspended') {
                try {
                  await audio.resume()
                } catch {
                  // A blocked context stays silent; the next gesture retries.
                }
              }
              let buffer = buffers.get(id)
              if (buffer === undefined) {
                try {
                  buffer = await audio.decodeAudioData(decodeBase64(spec.data))
                } catch {
                  resolve()
                  return
                }
                buffers.set(id, buffer)
              }
              stopCurrent?.()
              const settings = readSettings()
              const gain = audio.createGain()
              gain.gain.value = Math.max(0, Math.min(1, settings.volume))
              gain.connect(audio.destination)
              let cancelled = false
              let timer: ReturnType<typeof setTimeout> | undefined
              let source: AudioBufferSourceNode | undefined
              const deadline = Date.now() + windowMs
              const finish = (): void => {
                if (cancelled) return
                cancelled = true
                if (timer !== undefined) clearTimeout(timer)
                timer = undefined
                try {
                  source?.stop()
                } catch {
                  // Already ended.
                }
                source = undefined
                try {
                  gain.disconnect()
                } catch {
                  // The context may already be gone; nothing to release.
                }
                if (stopCurrent === finish) stopCurrent = undefined
                resolve()
              }
              stopCurrent = finish
              const step = (): void => {
                if (cancelled) return
                const remainingMs = deadline - Date.now()
                if (remainingMs <= 0) {
                  finish()
                  return
                }
                const sliceSeconds = Math.min(buffer!.duration, remainingMs / 1000)
                source = audio!.createBufferSource()
                source.buffer = buffer!
                source.connect(gain)
                source.start(0, 0, sliceSeconds)
                const nextMs = sliceSeconds * 1000 + REPEAT_GAP_SECONDS * 1000
                timer = setTimeout(remainingMs > nextMs ? step : finish, remainingMs > nextMs ? nextMs : remainingMs + 20)
              }
              step()
            })()
          })
        },
      }
    }

    /** One bilingual string; the platform locale service picks the active language. */
    interface Text {
      readonly en: string
      readonly zh: string
    }

    /** The slice of the client locale service this bundle uses, resolved optionally. */
    interface LocaleLike {
      getLocale(): { readonly active: string }
      subscribe(listener: () => void): () => void
      resolveText(text: unknown): string
    }

    /** One editable field on the settings page. */
    interface FieldSpec {
      /** Configuration path, also the editor state key. */
      readonly key: string
      readonly kind: 'boolean' | 'enum' | 'number' | 'time' | 'range'
      /** Section this field is grouped under, in first-appearance order. */
      readonly section: Text
      readonly label: Text
      readonly hint: Text
      /** Choice list for `enum` fields. */
      readonly choices?: readonly { readonly value: string; readonly label: string | Text }[]
      readonly min?: number
      readonly max?: number
      readonly step?: number
      /** Parse a number field's text; returns a value or a message. */
      readonly parse?: (text: string) => { readonly value?: number; readonly error?: string }
      /** Validate a `time` field's text; returns a message or undefined. */
      readonly check?: (text: string) => string | undefined
      /** Read the field out of an accepted snapshot, defaulting the way the host does. */
      readonly seed: (value: unknown) => string | boolean
    }

    /**
     * Minutes since local midnight for one `HH:mm` string.
     * @param text - the clock text.
     * @returns minutes, or null when the text is empty or malformed.
     */
    function parseClock(text: unknown): number | null {
      if (typeof text !== 'string') return null
      const trimmed = text.trim()
      if (!CLOCK.test(trimmed)) return null
      const [hours, minutes] = trimmed.split(':')
      return Number(hours) * 60 + Number(minutes)
    }

    /**
     * Whether the local time falls inside the configured do-not-disturb window.
     *
     * An empty, malformed or zero-length window is off. An end earlier than the
     * start crosses midnight, which is the usual "22:00–08:00" case.
     *
     * @param now - the instant to test, in local time.
     * @param startText - window start, `HH:mm`.
     * @param endText - window end, `HH:mm`.
     * @returns whether the window is active now.
     */
    function inQuietHours(now: Date, startText: unknown, endText: unknown): boolean {
      const start = parseClock(startText)
      const end = parseClock(endText)
      if (start === null || end === null || start === end) return false
      const minutes = now.getHours() * 60 + now.getMinutes()
      return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
    }

    /**
     * The playback window one chime gets right now, in milliseconds.
     *
     * Zero means "play nothing": either the master switch is off, or a quiet
     * period is configured as silent. Inside a quiet period a `short` style caps
     * the window at `quietShortMs`; otherwise the saved duration (or one full
     * play-through when that is 0) applies.
     *
     * @param settings - resolved settings.
     * @param clipMs - the chime's own length.
     * @param now - the instant to test against the do-not-disturb window.
     * @returns the playback window in milliseconds, 0 to skip the chime.
     */
    function effectiveWindowMs(settings: ChimeSettings, clipMs: number, now: Date): number {
      if (!settings.enabled) return 0
      const base = settings.durationMs > 0 ? Math.min(settings.durationMs, MAX_WINDOW_MS) : clipMs
      const quiet = settings.restMode || inQuietHours(now, settings.dndStart, settings.dndEnd)
      if (!quiet) return base
      if (settings.quietStyle === 'silent') return 0
      return Math.min(base, settings.quietShortMs)
    }

    /** Parse a non-negative whole number of milliseconds. */
    function parseDuration(text: string): { value?: number; error?: string } {
      const trimmed = String(text).trim()
      if (!/^\d+$/.test(trimmed)) return { error: '请填非负整数毫秒（0＝完整播放一次）。' }
      const value = Number(trimmed)
      if (!Number.isSafeInteger(value)) return { error: '这个时长超出可表示范围。' }
      if (value > MAX_WINDOW_MS) return { error: '最长 21600000 毫秒（6 小时）。' }
      return { value }
    }

    /** Parse a 0–1 gain. */
    function parseVolume(text: string): { value?: number; error?: string } {
      const trimmed = String(text).trim()
      if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(trimmed)) return { error: '音量请填 0 到 1 之间的数，例如 0.8。' }
      return { value: Number(trimmed) }
    }

    /** Accept an empty string or a local `HH:mm` clock. */
    function checkTime(text: string): string | undefined {
      const trimmed = text.trim()
      if (trimmed === '' || CLOCK.test(trimmed)) return undefined
      return '请填 24 小时制的 HH:mm（例如 22:00），或留空表示不用。'
    }

    /** Read the chime choice list out of the generated sound table, in shipped order. */
    const SOUND_CHOICES: readonly { value: string; label: Text }[] = Object.keys(__CHIME_SOUNDS)
      .map(id => ({ value: id, label: { zh: __CHIME_SOUNDS[id]!.label + '（' + id + '）', en: id } }))

    /** Section labels, in display order. */
    const SECTIONS: readonly Text[] = [
      { zh: '提示音', en: 'Chimes' },
      { zh: '安静规则', en: 'Quiet hours' },
      { zh: '停止与提示卡', en: 'Stopping and the card' },
    ]
    const SOUNDS_SECTION = SECTIONS[0]!
    const QUIET_SECTION = SECTIONS[1]!
    const STOP_SECTION = SECTIONS[2]!

    /** Every editable field, in display order. */
    const FIELDS: readonly FieldSpec[] = [
      {
        key: 'enabled', kind: 'boolean', section: SOUNDS_SECTION,
        label: { zh: '启用铃声', en: 'Enable chimes' },
        hint: {
          zh: '关闭后不再播放任何提示音；插件行与本页设置都保留，随时可以打开。',
          en: 'No chime plays while this is off; the row and these settings stay, ready to switch back on.',
        },
        seed: value => booleanOf(value, 'enabled', true),
      },
      {
        key: 'soundDone', kind: 'enum', section: SOUNDS_SECTION,
        label: { zh: '完成提示音', en: 'Finished chime' },
        hint: {
          zh: '主 agent 完全停下时播放：没有运行中的回合、没有它自己的后台作业、没有在工作的子代理。',
          en: 'Plays when the agent truly stops: no running turn, no live job of its own, no working subagent.',
        },
        choices: SOUND_CHOICES,
        seed: value => soundOf(value, 'soundDone', 'chime-soft'),
      },
      {
        key: 'soundBlocked', kind: 'enum', section: SOUNDS_SECTION,
        label: { zh: '受阻提示音', en: 'Blocked chime' },
        hint: {
          zh: '会话的目标进入 blocked（受阻）状态时播放，与“完成”区分开。',
          en: 'Plays when the session’s goal becomes blocked, so it is audibly different from “finished”.',
        },
        choices: SOUND_CHOICES,
        seed: value => soundOf(value, 'soundBlocked', 'alert-low'),
      },
      {
        key: 'volume', kind: 'range', section: SOUNDS_SECTION,
        label: { zh: '音量', en: 'Volume' },
        hint: {
          zh: '0＝静音，1＝原始音量。保存后在下一声生效。',
          en: '0 is silent, 1 is the clip’s own level; applies from the next chime.',
        },
        min: 0, max: 1, step: 0.05, parse: parseVolume,
        seed: value => numberOf(value, 'volume', 0.8),
      },
      {
        key: 'durationMs', kind: 'number', section: SOUNDS_SECTION,
        label: { zh: '播放时长（毫秒）', en: 'Playback window (ms)' },
        hint: {
          zh: '0＝每声完整播放一次；正数＝最多响这么久，铃声较短时按间隔重复（上限 6 小时）。',
          en: '0 plays each chime once; a positive value repeats a short chime until the window runs out (max 6 hours).',
        },
        min: 0, step: 1000, parse: parseDuration,
        seed: value => numberOf(value, 'durationMs', 0),
      },
      {
        key: 'debounceMs', kind: 'number', section: SOUNDS_SECTION,
        label: { zh: '安静判定（毫秒）', en: 'Settle delay (ms)' },
        hint: {
          zh: '会话停下后需要安静这么久才判定为“结束”，用来躲开自动续行等回合间隙。',
          en: 'How long a session must stay quiet before it counts as finished; keeps inter-round gaps silent.',
        },
        min: 0, step: 100, parse: parseDuration,
        seed: value => numberOf(value, 'debounceMs', 1500),
      },
      {
        key: 'quietStyle', kind: 'enum', section: QUIET_SECTION,
        label: { zh: '勿扰 / 休息时怎么响', en: 'Inside a quiet period' },
        hint: {
          zh: '安静期间（勿扰时段或休息模式）把铃声缩短，还是完全静默。',
          en: 'Shorten the chime, or stay completely silent, during a do-not-disturb window or rest mode.',
        },
        choices: [
          { value: 'short', label: { zh: '短响（用下面的短响时长）', en: 'Shorten it (using the window below)' } },
          { value: 'silent', label: { zh: '不响（静默）', en: 'Stay silent' } },
        ],
        seed: value => quietStyleOf(value),
      },
      {
        key: 'quietShortMs', kind: 'number', section: QUIET_SECTION,
        label: { zh: '短响时长（毫秒）', en: 'Short chime window (ms)' },
        hint: {
          zh: '安静期间“短响”用多长。',
          en: 'How long the shortened chime plays inside a quiet period.',
        },
        min: 0, step: 100, parse: parseDuration,
        seed: value => numberOf(value, 'quietShortMs', 600),
      },
      {
        key: 'dndStart', kind: 'time', section: QUIET_SECTION,
        label: { zh: '勿扰时段开始', en: 'Do-not-disturb from' },
        hint: {
          zh: '本地时间 HH:mm，例如 22:00。留空、或与结束相同＝不启用勿扰时段。',
          en: 'Local HH:mm, e.g. 22:00. Empty, or equal to the end, disables the window.',
        },
        check: checkTime,
        seed: value => clockOf(value, 'dndStart'),
      },
      {
        key: 'dndEnd', kind: 'time', section: QUIET_SECTION,
        label: { zh: '勿扰时段结束', en: 'Do-not-disturb until' },
        hint: {
          zh: '结束早于开始表示跨午夜（22:00 → 08:00）。',
          en: 'An end earlier than the start crosses midnight (22:00 → 08:00).',
        },
        check: checkTime,
        seed: value => clockOf(value, 'dndEnd'),
      },
      {
        key: 'restMode', kind: 'boolean', section: QUIET_SECTION,
        label: { zh: '休息模式', en: 'Rest mode' },
        hint: {
          zh: '打开后一直按上面的安静规则处理；也可以点侧边栏底部的 🌙 按钮直接切换。',
          en: 'Treats every chime as inside a quiet period; the 🌙 switch at the sidebar foot toggles it too.',
        },
        seed: value => booleanOf(value, 'restMode', false),
      },
      {
        key: 'minRingMs', kind: 'number', section: STOP_SECTION,
        label: { zh: '最短响铃（毫秒）', en: 'Shortest ring (ms)' },
        hint: {
          zh: '在这之前鼠标/键盘活动不会打断铃声，保证长响铃至少被听到这么久；卡片上的“停止铃声”按钮不受限制。',
          en: 'Pointer or key activity cannot stop a ring before this, so a long ring is always heard; the card’s stop button ignores it.',
        },
        min: 0, step: 500, parse: parseDuration,
        seed: value => numberOf(value, 'minRingMs', 3000),
      },
      {
        key: 'banner', kind: 'boolean', section: STOP_SECTION,
        label: { zh: '响铃时显示停止卡片', en: 'Show the stop card' },
        hint: {
          zh: '弹出卡片写明是哪个会话完成/受阻，并带一个“停止铃声”按钮（按钮点下去立即停）。',
          en: 'A card names the finished session and offers one stop button that ends the ring immediately.',
        },
        seed: value => booleanOf(value, 'banner', true),
      },
      {
        key: 'bannerPlacement', kind: 'enum', section: STOP_SECTION,
        label: { zh: '卡片位置', en: 'Card position' },
        hint: {
          zh: '默认底部居中，最不容易和其它 UI 插件的角落控件打架；选“modal”是带半透明遮罩的居中弹窗，必须点按钮才消失，鼠标/键盘活动也不会停铃声。',
          en: 'Bottom-centre by default, the spot least likely to collide with another plugin’s corner widget. “modal” adds a translucent mask that only the button clears and ignores pointer and key activity.',
        },
        choices: [
          { value: 'bottom-center', label: { zh: '底部居中（默认）', en: 'Bottom centre (default)' } },
          { value: 'bottom-right', label: { zh: '右下角', en: 'Bottom right' } },
          { value: 'bottom-left', label: { zh: '左下角', en: 'Bottom left' } },
          { value: 'top-right', label: { zh: '右上角', en: 'Top right' } },
          { value: 'top-left', label: { zh: '左上角', en: 'Top left' } },
          { value: 'center', label: { zh: '居中（无遮罩）', en: 'Centre, no mask' } },
          { value: 'modal', label: { zh: '居中 + 半透明遮罩（必须点按钮）', en: 'Centre with a mask (button only)' } },
        ],
        seed: value => placementOf(value),
      },
    ]

    /** Field names in display order. */
    const FIELD_KEYS: readonly string[] = FIELDS.map(field => field.key)

    function section(value: unknown): Record<string, unknown> {
      return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    }

    function booleanOf(value: unknown, key: string, fallback: boolean): boolean {
      const raw = section(value)[key]
      return typeof raw === 'boolean' ? raw : fallback
    }

    function soundOf(value: unknown, key: string, fallback: string): string {
      const raw = section(value)[key]
      return typeof raw === 'string' && __CHIME_SOUNDS[raw] !== undefined ? raw : fallback
    }

    function numberOf(value: unknown, key: string, fallback: number): string {
      const raw = section(value)[key]
      return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : String(fallback)
    }

    /** Read a quiet-period style, defaulting the way the host does. */
    function quietStyleOf(value: unknown): string {
      const raw = section(value).quietStyle
      return raw === 'silent' ? 'silent' : 'short'
    }

    /** Every banner placement, in display order. */
    const PLACEMENTS: readonly string[] = [
      'bottom-center', 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'modal',
    ]

    /** Read a banner placement, defaulting the way the host does. */
    function placementOf(value: unknown): string {
      const raw = section(value).bannerPlacement
      return typeof raw === 'string' && PLACEMENTS.includes(raw) ? raw : 'bottom-center'
    }

    /** Read a local clock field, defaulting to "always" (empty). */
    function clockOf(value: unknown, key: string): string {
      const raw = section(value)[key]
      return typeof raw === 'string' && CLOCK.test(raw.trim()) ? raw.trim() : ''
    }

    /** The settings the runtime applies, read from the accepted row snapshot. */
    function settingsOf(value: unknown): ChimeSettings {
      const raw = section(value)
      const volume = raw.volume
      const duration = raw.durationMs
      const debounce = raw.debounceMs
      const short = raw.quietShortMs
      const minRing = typeof raw.minRingMs === 'number' && Number.isSafeInteger(raw.minRingMs) && raw.minRingMs >= 0
        ? Math.min(raw.minRingMs, MAX_WINDOW_MS)
        : 3000
      return {
        enabled: booleanOf(value, 'enabled', true),
        soundDone: soundOf(value, 'soundDone', 'chime-soft'),
        soundBlocked: soundOf(value, 'soundBlocked', 'alert-low'),
        volume: typeof volume === 'number' && Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8,
        durationMs: typeof duration === 'number' && Number.isSafeInteger(duration) && duration >= 0 ? Math.min(duration, MAX_WINDOW_MS) : 0,
        debounceMs: typeof debounce === 'number' && Number.isSafeInteger(debounce) && debounce >= 0 ? debounce : 1500,
        quietStyle: quietStyleOf(value) as ChimeSettings['quietStyle'],
        quietShortMs: typeof short === 'number' && Number.isSafeInteger(short) && short >= 0 ? Math.min(short, MAX_WINDOW_MS) : 600,
        dndStart: clockOf(value, 'dndStart'),
        dndEnd: clockOf(value, 'dndEnd'),
        restMode: booleanOf(value, 'restMode', false),
        minRingMs: minRing,
        banner: booleanOf(value, 'banner', true),
        bannerPlacement: placementOf(value) as ChimeSettings['bannerPlacement'],
      }
    }

    /** Editor state: every field staged as text (numbers) or its own type. */
    interface EditorState {
      status: string
      writable: boolean
      revision: number | undefined
      values: Record<string, string | boolean>
      dirty: boolean
      saving: boolean
      error: string
      conflict: boolean
    }

    /**
     * Create the page editor. Edits stage locally; Save submits one revision-fenced
     * atomic mutation so a concurrent change can never be overwritten silently.
     * @param form - the shared form for this plugin's Host entry.
     * @returns the editor control surface used by the React view.
     */
    function createEditor(form: ConfigForm): {
      getSnapshot(): EditorState
      subscribe(listener: () => void): () => void
      start(): () => void
      edit(field: string, value: string | boolean): void
      discard(): void
      reset(): void
      save(): Promise<boolean>
    } {
      const listeners = new Set<() => void>()
      let accepted: ConfigFormSnapshot = form.getSnapshot()
      let baseline: number | undefined
      let resets = new Set<string>()
      let unsubscribe: (() => void) | undefined
      let active = false

      function seed(snapshot: ConfigFormSnapshot): EditorState {
        const values: Record<string, string | boolean> = {}
        for (const field of FIELDS) values[field.key] = field.seed(snapshot.value)
        return {
          status: snapshot.status, writable: snapshot.writable, revision: snapshot.revision,
          values, dirty: false, saving: false, error: '', conflict: false,
        }
      }

      let state = seed(accepted)
      function publish(next: EditorState): void {
        state = next
        for (const listener of listeners) listener()
      }
      function refresh(): void {
        accepted = form.getSnapshot()
        if (!state.dirty && !state.saving) {
          baseline = undefined
          resets = new Set()
          publish(seed(accepted))
          return
        }
        publish({ ...state, status: accepted.status, writable: accepted.writable, conflict: accepted.revision !== baseline })
      }
      function canEdit(): boolean {
        return active && state.status === 'ready' && state.writable && !state.saving
      }
      function begin(): void {
        if (!state.dirty) baseline = accepted.revision
      }
      /**
       * The operations a save would submit for the current draft.
       *
       * Every field compares against its SEEDED value, never the raw snapshot:
       * an absent row field means "inherit the default", so a saved value equal
       * to that default must not be written back as an explicit override.
       */
      function operations(): { ops?: PathOperation[]; error?: string } {
        const ops: PathOperation[] = []
        for (const field of FIELDS) {
          const staged = state.values[field.key]!
          if (resets.has(field.key)) {
            ops.push({ op: 'unset', path: [field.key] })
            continue
          }
          const seeded = field.seed(accepted.value)
          if (field.kind === 'number' || field.kind === 'range') {
            const parsed = field.parse!(String(staged))
            if (parsed.error !== undefined) return { error: parsed.error }
            if (parsed.value !== Number(seeded)) ops.push({ op: 'set', path: [field.key], value: parsed.value })
            continue
          }
          if (field.kind === 'time') {
            const text = String(staged).trim()
            const problem = field.check?.(text)
            if (problem !== undefined) return { error: problem }
            if (text !== String(seeded)) ops.push({ op: 'set', path: [field.key], value: text })
            continue
          }
          if (staged !== seeded) ops.push({ op: 'set', path: [field.key], value: staged })
        }
        return { ops }
      }
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        start() {
          active = true
          unsubscribe?.()
          unsubscribe = form.subscribe(refresh)
          refresh()
          return () => {
            active = false
            unsubscribe?.()
            unsubscribe = undefined
          }
        },
        edit(field, value) {
          if (!FIELD_KEYS.includes(field) || !canEdit()) return
          begin()
          resets.delete(field)
          publish({ ...state, values: { ...state.values, [field]: value }, dirty: true, error: '', conflict: false })
        },
        discard() {
          baseline = undefined
          resets = new Set()
          publish(seed(accepted))
        },
        reset() {
          if (!canEdit()) return
          begin()
          resets = new Set(FIELD_KEYS)
          publish({ ...seed(accepted), dirty: true })
        },
        async save() {
          if (!canEdit() || !state.dirty) return false
          const prepared = operations()
          if (prepared.error !== undefined) {
            publish({ ...state, error: prepared.error })
            return false
          }
          const ops = prepared.ops ?? []
          if (ops.length === 0) {
            publish({ ...state, dirty: false, error: '' })
            return true
          }
          if (!Number.isSafeInteger(baseline) || state.conflict) {
            publish({ ...state, conflict: true, error: '配置已在其他页面更新。草稿已保留；请先放弃草稿并重新读取，再编辑保存。' })
            return false
          }
          publish({ ...state, saving: true, error: '' })
          try {
            const ok = await form.mutate(ops, baseline)
            if (!active) return ok
            if (ok) {
              baseline = undefined
              resets = new Set()
              accepted = form.getSnapshot()
              publish(seed(accepted))
            } else {
              accepted = form.getSnapshot()
              publish({
                ...state, saving: false,
                conflict: accepted.revision !== baseline,
                error: '保存未被接受，草稿已保留。若配置已更新，请放弃草稿后重新编辑。',
              })
            }
            return ok
          } catch {
            if (active) publish({ ...state, saving: false, error: '无法保存配置，草稿已保留。请检查连接后重试。' })
            return false
          }
        },
      }
    }

    const styles: Record<string, Record<string, unknown>> = {
      root: { display: 'grid', gap: 14, color: 'var(--dsw-alias-label-primary)', fontSize: 13, paddingBottom: 4 },
      header: { display: 'flex', gap: 12, alignItems: 'center' },
      headerBadge: {
        display: 'grid', placeItems: 'center', width: 38, height: 38, flexShrink: 0,
        borderRadius: 'var(--dsw-radius-lg)', fontSize: 18,
        background: 'var(--dsw-alias-interactive-bg-hover-accent)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      headerCopy: { display: 'grid', gap: 3 },
      title: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.3 },
      subtitle: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
      card: {
        display: 'grid', gap: 14, padding: '14px 16px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-lg)',
      },
      sectionTitle: {
        margin: 0, paddingLeft: 8, fontSize: 12, fontWeight: 600, letterSpacing: '0.06em',
        color: 'var(--dsw-alias-label-secondary)',
        borderLeft: '3px solid var(--dsw-alias-brand-primary)',
      },
      field: { display: 'grid', gap: 7 },
      label: { fontWeight: 600 },
      hint: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
      select: {
        boxSizing: 'border-box', width: '100%', padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit',
      },
      switchRow: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between' },
      switchText: { color: 'var(--dsw-alias-brand-text)', fontWeight: 600 },
      check: { display: 'flex', gap: 8, alignItems: 'center' },
      checkbox: { width: 16, height: 16, accentColor: 'var(--dsw-alias-brand-primary)' },
      rangeRow: { display: 'flex', gap: 10, alignItems: 'center' },
      range: { flex: 1, accentColor: 'var(--dsw-alias-brand-primary)' },
      rangeValue: {
        minWidth: 44, textAlign: 'right', fontWeight: 600,
        color: 'var(--dsw-alias-brand-text)', fontVariantNumeric: 'tabular-nums',
      },
      number: {
        boxSizing: 'border-box', width: '100%', padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit',
      },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      button: {
        padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)', font: 'inherit', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
      },
      primaryButton: {
        padding: '7px 16px', border: '1px solid transparent', fontWeight: 600, cursor: 'pointer',
        borderRadius: 'var(--dsw-radius-md)', font: 'inherit',
        color: 'var(--dsw-alias-label-primary-foreground)',
        background: 'var(--dsw-alias-button-primary-fill)',
      },
      accentButton: {
        padding: '7px 12px', cursor: 'pointer', fontWeight: 600, font: 'inherit',
        borderRadius: 'var(--dsw-radius-md)',
        color: 'var(--dsw-alias-brand-text)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-interactive-bg-hover-accent)',
      },
      error: { margin: 0, color: 'var(--dsw-alias-label-error)', lineHeight: 1.6 },
      resting: {
        padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)', font: 'inherit',
        color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
      },
      bannerCard: {
        position: 'fixed', zIndex: 60, display: 'flex', gap: 18, alignItems: 'center',
        maxWidth: 'min(560px, calc(100vw - 48px))', padding: '16px 20px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-bg-layer-1)', boxShadow: '0 12px 32px rgba(0, 0, 0, 0.28)',
        color: 'var(--dsw-alias-label-primary)',
        // The overlay layer is click-through; the card opts back in.
        pointerEvents: 'auto',
      },
      bannerMask: {
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)', pointerEvents: 'auto',
      },
      bannerText: { display: 'grid', gap: 4, fontSize: 13, lineHeight: 1.5 },
      bannerTitle: { fontWeight: 600, fontSize: 15, wordBreak: 'break-word' },
      bannerButton: {
        flexShrink: 0, padding: '10px 18px', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)', font: 'inherit', fontWeight: 600, cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
      },
    }

    /** Short description shown on the plugin card while no editor is open. */
    const summary = {
      zh: '会话真正停下（无运行回合、无后台作业、无工作子代理）或目标受阻时响铃；铃声、音量、播放时长、安静规则与停止卡片都在这里设置。',
      en: 'Ring when a session truly stops — no running turn, no live job, no working subagent — or when its goal becomes blocked. Chimes, volume, the playback window, quiet rules and the stop card live here.',
    }

    /** Services Cordis activates before this bundle runs; `jobs` is optional. */
    const inject = { required: ['slots', 'configForms', 'sessions'], optional: ['jobs'] }

    /**
     * Mount the watcher and the configuration page on the shared platform React.
     * @param ctx - client context carrying the session catalog and settings service.
     */
    function apply(ctx: ClientContext): void {
      const form = ctx.configForms.get(ROW_ID)
      const audio = createAudio(() => settingsOf(form.getSnapshot().value))
      let latest: ChimeSettings = settingsOf(form.getSnapshot().value)
      /** The sidebar switch reads this flag instead of the whole settings object. */
      const restFlag = createFlag(booleanOf(form.getSnapshot().value, 'restMode', false))
      form.subscribe(() => {
        latest = settingsOf(form.getSnapshot().value)
        restFlag.set(latest.restMode)
      })

      const jobs = typeof ctx.get === 'function' ? (ctx.get('jobs') as import('./public.js').JobsService | undefined) : undefined
      const releases = new Map<string, () => void>()
      const banner = createBanner()
      /** The ring currently playing, if any; the banner and the min-ring guard read it. */
      let activeRing: RingInfo | undefined
      let ringSeq = 0

      /**
       * Start one ring: decide its window from the live settings, remember it, put
       * the banner up and play.
       *
       * @param reason - why the chime plays; drives which sound and what the banner says.
       * @param session - the session that settled, or a preview placeholder.
       * @param soundId - the chime to play.
       */
      function playRing(reason: ChimeReason, session: { id: string; title: string }, soundId: string): void {
        const settings = latest
        const clipMs = __CHIME_SOUNDS[soundId]?.durationMs ?? 0
        const windowMs = effectiveWindowMs(settings, clipMs, new Date())
        if (windowMs <= 0) return
        ringSeq += 1
        const entry: RingInfo = {
          seq: ringSeq, reason, sessionId: session.id, title: session.title,
          startedAt: Date.now(), soundId, windowMs,
        }
        activeRing = entry
        if (settings.banner) banner.show(entry)
        void audio.play(soundId, windowMs).then(() => {
          if (activeRing !== undefined && activeRing.seq === entry.seq) {
            activeRing = undefined
            banner.hide(entry.seq)
          }
        })
      }

      /** Silence everything and take the banner down. */
      function stopRing(): void {
        const entry = activeRing
        activeRing = undefined
        audio.stop()
        if (entry !== undefined) banner.hide(entry.seq)
      }

      const watcher = createWatcher({
        now: () => Date.now(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: handle => {
          clearTimeout(handle as ReturnType<typeof setTimeout>)
        },
        readSettings: () => latest,
        ring(reason, session) {
          playRing(reason, session, reason === 'blocked' ? latest.soundBlocked : latest.soundDone)
        },
        watch(sessionId) {
          if (jobs === undefined || releases.has(sessionId)) return
          try {
            releases.set(sessionId, jobs.watchRows(sessionId))
          } catch {
            // A roster that cannot be opened only costs the job half of the test.
          }
        },
        unwatch(sessionId) {
          const release = releases.get(sessionId)
          if (release === undefined) return
          releases.delete(sessionId)
          try {
            release()
          } catch {
            // The stream is already gone; nothing to release.
          }
        },
      })

      ctx.effect(() => {
        const list = ctx.sessions.list
        const jobsState = jobs?.state
        const pump = (): void => watcher.update(list.getSnapshot(), jobsState?.getSnapshot())
        pump()
        const stopSessions = list.subscribe(pump)
        const stopJobs = jobsState?.subscribe(pump)
        return () => {
          stopSessions()
          stopJobs?.()
          for (const sessionId of [...releases.keys()]) {
            const release = releases.get(sessionId)
            releases.delete(sessionId)
            try {
              release?.()
            } catch {
              // Nothing left to release.
            }
          }
        }
      }, 'dsh-session-chime: session watcher')

      // Browsers keep audio suspended until the user interacts. Past the shortest-ring
      // guard, a gesture also stops a ringing chime: a long window is a legitimate
      // setting, but a click or key press means the human is back and has heard it.
      const onGesture = (): void => {
        audio.unlock()
        if (gestureStopsRing(latest.bannerPlacement, latest.banner, activeRing?.startedAt, Date.now(), latest.minRingMs)) stopRing()
      }
      window.addEventListener('pointerdown', onGesture, { capture: true, passive: true })
      window.addEventListener('keydown', onGesture, { capture: true, passive: true })
      ctx.effect(() => () => {
        window.removeEventListener('pointerdown', onGesture, { capture: true })
        window.removeEventListener('keydown', onGesture, { capture: true })
        audio.stop()
      }, 'dsh-session-chime: audio unlock and stop-on-gesture')

      // The platform locale service is optional: with it every string below renders in
      // the active language (zh/en), without it Chinese is the fallback.
      const locale = typeof ctx.get === 'function' ? (ctx.get('locale') as LocaleLike | undefined) : undefined
      const t = (text: string | Text): string => (typeof text === 'string' ? text : locale !== undefined ? locale.resolveText(text) : text.zh)
      const localeTick = createFlag(false)
      if (locale !== undefined) {
        ctx.effect(() => locale.subscribe(() => localeTick.set(!localeTick.getSnapshot())), 'dsh-session-chime: locale')
      }

      const h = React.createElement
      function EditorView({ configForm }: { configForm: ConfigForm }): unknown {
        const [instance] = React.useState(() => createEditor(configForm))
        React.useEffect(() => instance.start(), [instance])
        const state = React.useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot)
        // A locale switch must repaint these strings; the value itself is unused.
        void React.useSyncExternalStore(localeTick.subscribe, localeTick.getSnapshot, localeTick.getSnapshot)
        if (state.status !== 'ready') {
          return h('p', { style: styles.hint, role: 'status' }, state.status === 'loading'
            ? t({ zh: '正在读取插件配置…', en: 'Reading this row’s configuration…' })
            : t({ zh: '此插件当前未提供可编辑配置。', en: 'This plugin exposes no editable configuration.' }))
        }
        const disabled = !state.writable || state.saving

        /** One labelled control with its hint. */
        function field(spec: FieldSpec): unknown {
          const id = 'dsh-session-chime-' + spec.key
          const value = state.values[spec.key]!
          const label = h('span', { key: 'label', style: styles.label }, t(spec.label))
          const hint = h('p', { key: 'hint', id: id + '-hint', style: styles.hint }, t(spec.hint))
          let control: unknown
          if (spec.kind === 'boolean') {
            control = h('label', { style: styles.check, htmlFor: id },
              h('input', {
                id, type: 'checkbox', checked: value === true, disabled,
                style: styles.checkbox,
                'aria-describedby': id + '-hint',
                onChange: (event: { target: { checked: boolean } }) => instance.edit(spec.key, event.target.checked),
              }),
              h('span', { style: styles.switchText }, value === true
                ? t({ zh: '已开启', en: 'On' })
                : t({ zh: '已关闭', en: 'Off' })))
          } else if (spec.kind === 'range') {
            control = h('div', { style: styles.rangeRow },
              h('input', {
                id, type: 'range', min: spec.min, max: spec.max, step: spec.step, disabled,
                style: styles.range, value: String(value),
                'aria-describedby': id + '-hint',
                onChange: (event: { target: { value: string } }) => instance.edit(spec.key, event.target.value),
              }),
              h('span', { style: styles.rangeValue }, String(value)))
          } else if (spec.kind === 'enum') {
            control = h('select', {
              id, style: styles.select, value: String(value), disabled,
              'aria-describedby': id + '-hint',
              onChange: (event: { target: { value: string } }) => instance.edit(spec.key, event.target.value),
            }, (spec.choices ?? []).map(choice => h('option', { key: choice.value, value: choice.value }, t(choice.label))))
          } else {
            control = h('input', {
              id, type: spec.kind === 'time' ? 'time' : 'number',
              min: spec.min, max: spec.max, step: spec.step, inputMode: 'decimal',
              style: styles.number, value: String(value), disabled,
              'aria-describedby': id + '-hint',
              onChange: (event: { target: { value: string } }) => instance.edit(spec.key, event.target.value),
            })
          }
          return h('div', { key: spec.key, style: styles.field },
            spec.kind === 'boolean' ? h('div', { style: styles.switchRow }, label, control) : label,
            spec.kind === 'boolean' ? undefined : control,
            hint)
        }

        const grouped = SECTIONS.map(section => ({
          section,
          fields: FIELDS.filter(spec => spec.section === section),
        })).filter(group => group.fields.length > 0)

        return h('form', {
          style: styles.root,
          'aria-label': t({ zh: '会话铃声设置', en: 'Session chime settings' }),
          'aria-busy': state.saving,
          onSubmit: (event: { preventDefault(): void }) => {
            event.preventDefault()
            void instance.save()
          },
        },
        h('header', { key: 'header', style: styles.header },
          h('span', { key: 'badge', style: styles.headerBadge }, '🔔'),
          h('div', { key: 'copy', style: styles.headerCopy },
            h('h2', { key: 'title', style: styles.title }, t({ zh: '会话铃声', en: 'Session chime' })),
            h('p', { key: 'subtitle', style: styles.subtitle }, t({
              zh: '会话真正停下（无运行回合、无后台作业、无工作子代理）或目标受阻时响铃；铃声与安静规则在这里设置，保存即生效。',
              en: 'Ring when a session truly stops — no running turn, no live job, no working subagent — or when its goal becomes blocked. Everything here applies the moment you save.',
            })))),
        !state.writable && h('p', { key: 'readonly', style: styles.hint, role: 'status' }, t({
          zh: '当前连接或配置文档为只读。',
          en: 'This connection or configuration document is read-only.',
        })),
        grouped.map(group => h('section', { key: group.section.en, style: styles.card },
          h('h3', { key: 'title', style: styles.sectionTitle }, t(group.section)),
          group.fields.map(field))),
        h('p', { key: 'note', style: styles.hint }, t({
          zh: '保存即生效：浏览器半边直接读这份配置，改铃声、音量或时长会在下一声立刻生效。',
          en: 'Saved values apply at once: the browser half reads this row directly, so the next chime already uses them.',
        })),
        state.conflict && !state.error && h('p', { key: 'conflict', role: 'alert', style: styles.error }, t({
          zh: '配置已更新；为避免覆盖他人的修改，请放弃草稿后重新编辑。',
          en: 'The configuration changed elsewhere. Discard the draft before editing again so nobody’s edit is overwritten.',
        })),
        state.error && h('p', { key: 'error', role: 'alert', style: styles.error }, state.error),
        h('div', { key: 'actions', style: styles.actions },
          h('button', { type: 'submit', style: disabled || !state.dirty || state.conflict ? styles.button : styles.primaryButton, disabled: disabled || !state.dirty || state.conflict },
            state.saving ? t({ zh: '正在保存…', en: 'Saving…' }) : t({ zh: '保存', en: 'Save' })),
          h('button', { type: 'button', style: styles.button, disabled: state.saving || !state.dirty, onClick: () => instance.discard() },
            t({ zh: '放弃草稿', en: 'Discard' })),
          h('button', { type: 'button', style: styles.button, disabled, onClick: () => instance.reset() },
            t({ zh: '恢复默认（保存后生效）', en: 'Reset to defaults' })),
          h('button', {
            type: 'button', style: styles.accentButton, disabled: state.saving,
            onClick: () => {
              audio.unlock()
              // The preview obeys the live settings, quiet rules included, and shows
              // the same stop banner the real ring would.
              playRing('done', { id: 'preview', title: t({ zh: '（试听）', en: '(preview)' }) }, String(state.values.soundDone ?? 'chime-soft'))
            },
          }, t({ zh: '试听完成音', en: 'Preview the chime' }))))
      }

      function ConfigView(props: { view?: string; configForm: ConfigForm }): unknown {
        return props.view === 'summary' ? t(summary) : h(EditorView, { configForm: props.configForm })
      }

      ctx.effect(() => ctx.configForms.whileServed?.([ROW_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: BUNDLE_ID + '#' + ROW_ID,
        inject: () => ({ configForm: form }),
      }, ConfigView))), 'dsh-session-chime: configuration page')

      /** Flip rest mode straight from the sidebar switch. */
      async function toggleRestMode(): Promise<void> {
        const snapshot = form.getSnapshot()
        if (snapshot.status !== 'ready' || !snapshot.writable) return
        const next = !booleanOf(snapshot.value, 'restMode', false)
        try {
          await form.mutate([{ op: 'set', path: ['restMode'], value: next }], snapshot.revision)
        } catch {
          // The settings page reports write failures; the switch simply stays put.
        }
      }

      /** The sidebar-foot switch: one click between working and resting. */
      function RestModeSwitch({ wide }: { wide?: boolean }): unknown {
        const resting = React.useSyncExternalStore(restFlag.subscribe, restFlag.getSnapshot, restFlag.getSnapshot)
        return h('button', {
          type: 'button',
          style: resting ? styles.resting : styles.button,
          title: resting ? '休息模式：安静中，点击恢复正常' : '工作模式：正常响铃，点击进入休息',
          'aria-pressed': resting === true,
          onClick: () => {
            void toggleRestMode()
          },
        }, resting ? (wide === false ? '🌙' : '🌙 休息中') : (wide === false ? '🔔' : '🔔 正常'))
      }

      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'session-chime-rest',
        order: 50,
        label: () => '休息模式',
      }, RestModeSwitch)), 'dsh-session-chime: rest-mode switch')

      /**
       * Position one banner card inside the frame-wide overlay layer.
       *
       * Corners are offered because no single spot suits every setup: another UI
       * plugin's widget usually owns one of them, so which corner is free is a
       * deployment question, not a design one. `bottom-center` stays the default
       * for exactly that reason.
       *
       * @param placement - configured placement.
       * @returns the card's style object.
       */
      function bannerFrame(placement: string): Record<string, unknown> {
        const inset = 28
        switch (placement) {
          case 'bottom-right': return { ...styles.bannerCard, right: inset, bottom: inset }
          case 'bottom-left': return { ...styles.bannerCard, left: inset, bottom: inset }
          case 'top-right': return { ...styles.bannerCard, right: inset, top: inset }
          case 'top-left': return { ...styles.bannerCard, left: inset, top: inset }
          case 'center':
          case 'modal': return { ...styles.bannerCard, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
          default: return { ...styles.bannerCard, left: '50%', bottom: inset, transform: 'translateX(-50%)' }
        }
      }

      /** The frame-wide card that names the finished session and offers the stop button. */
      function ChimeBanner(): unknown {
        const entry = React.useSyncExternalStore(banner.subscribe, banner.getSnapshot, banner.getSnapshot)
        if (entry === undefined) return null
        const done = entry.reason === 'done'
        const seconds = Math.max(1, Math.round(entry.windowMs / 1000))
        const minSeconds = Math.max(0, Math.round(latest.minRingMs / 1000))
        const masked = latest.bannerPlacement === 'modal'
        const hint = masked
          ? t({
            zh: `铃声会响到 ${seconds} 秒用完。这个位置带遮罩：只能点下面的按钮结束铃声并关闭它。`,
            en: `The chime runs for ${seconds} s. This position is masked: only the button below ends it and clears the card.`,
          })
          : minSeconds > 0
            ? t({
              zh: `铃声会响到 ${seconds} 秒用完；响够 ${minSeconds} 秒后，点一下页面或按任意键也会停。`,
              en: `The chime runs for ${seconds} s; after ${minSeconds} s, a click or key press also stops it.`,
            })
            : t({
              zh: `铃声会响到 ${seconds} 秒用完；点一下页面或按任意键也会停。`,
              en: `The chime runs for ${seconds} s; a click or key press also stops it.`,
            })
        // Green for a clean finish, amber for a blocked goal: the accent is the
        // fastest way to read which one happened.
        const accent = done ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'
        const card = h('div', {
          style: { ...(masked ? styles.bannerCard : bannerFrame(latest.bannerPlacement)), borderLeft: '3px solid ' + accent },
          role: 'status',
          'aria-live': 'polite',
        },
        h('div', { style: styles.bannerText },
          h('strong', { style: { color: accent } }, done
            ? t({ zh: '🔔 会话已完成', en: '🔔 Session finished' })
            : t({ zh: '⚠️ 目标受阻', en: '⚠️ Goal blocked' })),
          h('span', { style: styles.bannerTitle }, entry.title === '' ? entry.sessionId : entry.title),
          h('span', { style: styles.hint }, hint)),
        h('button', { type: 'button', style: styles.primaryButton, onClick: () => stopRing() },
          t({ zh: '停止铃声', en: 'Stop the chime' })))
        if (!masked) return card
        // The mask swallows every pointer event on purpose; the layer is still
        // click-through for the rest of the shell because only the mask opts in.
        return h('div', { style: styles.bannerMask }, card)
      }

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-chime-banner',
        order: 100,
      }, ChimeBanner)), 'dsh-session-chime: stop banner')
    }

    // The shell reads named exports off the factory result, exactly like the
    // Harness' own client bundles, so the shape is an explicit namespace object.
    const exported: Record<string, unknown> = {}
    Object.defineProperty(exported, Symbol.toStringTag, { value: 'Module' })
    exported.inject = inject
    exported.apply = apply
    exported.isSettled = isSettled
    exported.createWatcher = createWatcher
    exported.createEditor = createEditor
    exported.settingsOf = settingsOf
    exported.parseDuration = parseDuration
    exported.parseVolume = parseVolume
    exported.parseClock = parseClock
    exported.inQuietHours = inQuietHours
    exported.effectiveWindowMs = effectiveWindowMs
    exported.checkTime = checkTime
    exported.shouldStopOnGesture = shouldStopOnGesture
    exported.gestureStopsRing = gestureStopsRing
    exported.PLACEMENTS = PLACEMENTS
    exported.summary = summary
    exported.ROW_ID = ROW_ID
    exported.FIELDS = FIELDS.map(field => field.key)
    exported.SOUND_IDS = Object.keys(__CHIME_SOUNDS)
    return exported
  },
})
