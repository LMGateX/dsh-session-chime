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
    type SessionListSnapshot = import('./public.js').SessionListSnapshot

    const React = require('react') as ReactRuntime

    /** Loader row id declared by this bundle's patch. */
    const ROW_ID = 'session-chime'

    /** The bundle id the shell registers; must match the npm package name. */
    const BUNDLE_ID = 'dsh-session-chime'

    /** Job statuses that count as live work for the owning session. */
    const LIVE_JOB = ['running', 'stopping']

    /** Longest playback window a saved duration can request. */
    const MAX_WINDOW_MS = 8000

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
      ring(reason: ChimeReason): void
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
        deps.ring('done')
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
                lastBusyAt: 0, timer: undefined, watched: false,
                observation: { running: false, liveJobs: 0, liveChildren: 0, goalPhase: null },
              }
              tracked.set(sessionId, state)
            }

            const running = row.running === true
            const phase = phaseOf(row)
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
            if (phase === 'blocked' && state.phase !== 'blocked' && state.phase !== null) deps.ring('blocked')
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
    function createAudio(readSettings: () => ChimeSettings): { unlock(): void; play(id: string): Promise<void> } {
      let context: AudioContext | undefined
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
        async play(id) {
          const spec = __CHIME_SOUNDS[id]
          if (spec === undefined) return
          const audio = ensure()
          if (audio === undefined) return
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
              return
            }
            buffers.set(id, buffer)
          }
          const settings = readSettings()
          const gain = audio.createGain()
          gain.gain.value = Math.max(0, Math.min(1, settings.volume))
          gain.connect(audio.destination)
          const windowSeconds = settings.durationMs > 0
            ? Math.min(settings.durationMs, MAX_WINDOW_MS) / 1000
            : buffer.duration
          const stride = buffer.duration + REPEAT_GAP_SECONDS
          const repeats = Math.max(1, Math.min(6, Math.ceil((windowSeconds + REPEAT_GAP_SECONDS) / stride)))
          const startAt = audio.currentTime + 0.01
          let last: AudioBufferSourceNode | undefined
          for (let index = 0; index < repeats; index += 1) {
            const offset = index * stride
            if (offset >= windowSeconds) break
            const source = audio.createBufferSource()
            source.buffer = buffer
            source.connect(gain)
            source.start(startAt + offset, 0, Math.min(buffer.duration, windowSeconds - offset))
            last = source
          }
          if (last !== undefined) {
            last.onended = () => {
              try {
                gain.disconnect()
              } catch {
                // The context may already be gone; nothing to release.
              }
            }
          }
        },
      }
    }

    /** One editable field on the settings page. */
    interface FieldSpec {
      /** Configuration path, also the editor state key. */
      readonly key: string
      readonly kind: 'boolean' | 'enum' | 'number'
      readonly label: string
      readonly hint: string
      /** Choice list for `enum` fields. */
      readonly choices?: readonly { readonly value: string; readonly label: string }[]
      readonly min?: number
      readonly max?: number
      readonly step?: number
      /** Parse a number field's text; returns a value or a message. */
      readonly parse?: (text: string) => { readonly value?: number; readonly error?: string }
      /** Read the field out of an accepted snapshot, defaulting the way the host does. */
      readonly seed: (value: unknown) => string | boolean
    }

    /** Parse a non-negative whole number of milliseconds. */
    function parseDuration(text: string): { value?: number; error?: string } {
      const trimmed = String(text).trim()
      if (!/^\d+$/.test(trimmed)) return { error: '请填非负整数毫秒（0＝完整播放一次）。' }
      const value = Number(trimmed)
      if (!Number.isSafeInteger(value)) return { error: '这个时长超出可表示范围。' }
      if (value > 600000) return { error: '最长 600000 毫秒（10 分钟）。' }
      return { value }
    }

    /** Parse a 0–1 gain. */
    function parseVolume(text: string): { value?: number; error?: string } {
      const trimmed = String(text).trim()
      if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(trimmed)) return { error: '音量请填 0 到 1 之间的数，例如 0.8。' }
      return { value: Number(trimmed) }
    }

    /** Read the chime choice list out of the generated sound table, in shipped order. */
    const SOUND_CHOICES: readonly { value: string; label: string }[] = Object.keys(__CHIME_SOUNDS)
      .map(id => ({ value: id, label: __CHIME_SOUNDS[id]!.label + '（' + id + '）' }))

    /** Every editable field, in display order. */
    const FIELDS: readonly FieldSpec[] = [
      {
        key: 'enabled', kind: 'boolean', label: '启用铃声',
        hint: '关闭后不再播放任何提示音；插件行与本页设置都保留，随时可以打开。',
        seed: value => booleanOf(value, 'enabled', true),
      },
      {
        key: 'soundDone', kind: 'enum', label: '完成提示音',
        hint: '主 agent 完全停下时播放：没有运行中的回合、没有它自己的后台作业、没有在工作的子代理。',
        choices: SOUND_CHOICES,
        seed: value => soundOf(value, 'soundDone', 'chime-soft'),
      },
      {
        key: 'soundBlocked', kind: 'enum', label: '受阻提示音',
        hint: '会话的目标进入 blocked（受阻）状态时播放，与“完成”区分开。',
        choices: SOUND_CHOICES,
        seed: value => soundOf(value, 'soundBlocked', 'alert-low'),
      },
      {
        key: 'volume', kind: 'number', label: '音量（0–1）', hint: '0＝静音，1＝原始音量。保存后在下一声生效。',
        min: 0, max: 1, step: 0.05, parse: parseVolume,
        seed: value => numberOf(value, 'volume', 0.8),
      },
      {
        key: 'durationMs', kind: 'number', label: '播放时长（毫秒）', hint: '0＝每声完整播放一次；正数＝最多响这么久，铃声较短时自动重复（上限 8 秒）。',
        min: 0, step: 100, parse: parseDuration,
        seed: value => numberOf(value, 'durationMs', 0),
      },
      {
        key: 'debounceMs', kind: 'number', label: '安静判定（毫秒）', hint: '会话停下后需要安静这么久才判定为“结束”，用来躲开自动续行等回合间隙。默认 1500。',
        min: 0, step: 100, parse: parseDuration,
        seed: value => numberOf(value, 'debounceMs', 1500),
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

    /** The settings the runtime applies, read from the accepted row snapshot. */
    function settingsOf(value: unknown): ChimeSettings {
      const raw = section(value)
      const volume = raw.volume
      const duration = raw.durationMs
      const debounce = raw.debounceMs
      return {
        enabled: booleanOf(value, 'enabled', true),
        soundDone: soundOf(value, 'soundDone', 'chime-soft'),
        soundBlocked: soundOf(value, 'soundBlocked', 'alert-low'),
        volume: typeof volume === 'number' && Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8,
        durationMs: typeof duration === 'number' && Number.isSafeInteger(duration) && duration >= 0 ? duration : 0,
        debounceMs: typeof debounce === 'number' && Number.isSafeInteger(debounce) && debounce >= 0 ? debounce : 1500,
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
          if (field.kind === 'number') {
            const parsed = field.parse!(String(staged))
            if (parsed.error !== undefined) return { error: parsed.error }
            if (parsed.value !== Number(seeded)) ops.push({ op: 'set', path: [field.key], value: parsed.value })
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
      root: { display: 'grid', gap: 16, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      field: { display: 'grid', gap: 7 },
      label: { fontWeight: 600 },
      hint: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
      select: {
        boxSizing: 'border-box', width: '100%', padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit',
      },
      check: { display: 'flex', gap: 8, alignItems: 'center' },
      number: {
        boxSizing: 'border-box', width: '100%', padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit',
      },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      button: {
        padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)', font: 'inherit',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
      },
      error: { margin: 0, color: 'var(--dsw-alias-label-error)', lineHeight: 1.6 },
    }

    /** Short description shown on the plugin card while no editor is open. */
    const summary = '会话真正停下（无运行回合、无后台作业、无工作子代理）或目标受阻时响铃；铃声、音量与播放时长在这里设置。'

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
      form.subscribe(() => {
        latest = settingsOf(form.getSnapshot().value)
      })

      const jobs = typeof ctx.get === 'function' ? (ctx.get('jobs') as import('./public.js').JobsService | undefined) : undefined
      const releases = new Map<string, () => void>()

      const watcher = createWatcher({
        now: () => Date.now(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: handle => {
          clearTimeout(handle as ReturnType<typeof setTimeout>)
        },
        readSettings: () => latest,
        ring(reason) {
          const settings = latest
          if (!settings.enabled) return
          void audio.play(reason === 'blocked' ? settings.soundBlocked : settings.soundDone)
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

      // Browsers keep audio suspended until the user interacts; every gesture retries.
      const unlock = (): void => audio.unlock()
      window.addEventListener('pointerdown', unlock, { capture: true, passive: true })
      window.addEventListener('keydown', unlock, { capture: true, passive: true })
      ctx.effect(() => () => {
        window.removeEventListener('pointerdown', unlock, { capture: true })
        window.removeEventListener('keydown', unlock, { capture: true })
      }, 'dsh-session-chime: audio unlock')

      const h = React.createElement
      function EditorView({ configForm }: { configForm: ConfigForm }): unknown {
        const [instance] = React.useState(() => createEditor(configForm))
        React.useEffect(() => instance.start(), [instance])
        const state = React.useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot)
        if (state.status !== 'ready') {
          return h('p', { style: styles.hint, role: 'status' }, state.status === 'loading'
            ? '正在读取插件配置…'
            : '此插件当前未提供可编辑配置。')
        }
        const disabled = !state.writable || state.saving
        function field(spec: FieldSpec): unknown {
          const id = 'dsh-session-chime-' + spec.key
          const value = state.values[spec.key]!
          if (spec.kind === 'boolean') {
            return h('div', { key: spec.key, style: styles.field },
              h('label', { style: styles.check, htmlFor: id },
                h('input', {
                  id, type: 'checkbox', checked: value === true, disabled,
                  'aria-describedby': id + '-hint',
                  onChange: (event: { target: { checked: boolean } }) => instance.edit(spec.key, event.target.checked),
                }),
                h('span', { style: styles.label }, spec.label)),
              h('p', { id: id + '-hint', style: styles.hint }, spec.hint))
          }
          if (spec.kind === 'enum') {
            return h('div', { key: spec.key, style: styles.field },
              h('label', { htmlFor: id, style: styles.label }, spec.label),
              h('select', {
                id, style: styles.select, value: String(value), disabled,
                'aria-describedby': id + '-hint',
                onChange: (event: { target: { value: string } }) => instance.edit(spec.key, event.target.value),
              }, (spec.choices ?? []).map(choice => h('option', { key: choice.value, value: choice.value }, choice.label))),
              h('p', { id: id + '-hint', style: styles.hint }, spec.hint))
          }
          return h('div', { key: spec.key, style: styles.field },
            h('label', { htmlFor: id, style: styles.label }, spec.label),
            h('input', {
              id, type: 'number', min: spec.min, max: spec.max, step: spec.step, inputMode: 'decimal',
              style: styles.number, value: String(value), disabled,
              'aria-describedby': id + '-hint',
              onChange: (event: { target: { value: string } }) => instance.edit(spec.key, event.target.value),
            }),
            h('p', { id: id + '-hint', style: styles.hint }, spec.hint))
        }
        return h('form', {
          style: styles.root,
          'aria-label': '会话铃声设置',
          'aria-busy': state.saving,
          onSubmit: (event: { preventDefault(): void }) => {
            event.preventDefault()
            void instance.save()
          },
        },
        !state.writable && h('p', { style: styles.hint, role: 'status' }, '当前连接或配置文档为只读。'),
        FIELDS.map(field),
        h('p', { style: styles.hint }, '保存即生效：浏览器半边直接读这份配置，改铃声、音量或时长会在下一声立刻生效。'),
        state.conflict && !state.error && h('p', { role: 'alert', style: styles.error }, '配置已更新；为避免覆盖他人的修改，请放弃草稿后重新编辑。'),
        state.error && h('p', { role: 'alert', style: styles.error }, state.error),
        h('div', { style: styles.actions },
          h('button', { type: 'submit', style: styles.button, disabled: disabled || !state.dirty || state.conflict }, state.saving ? '正在保存…' : '保存'),
          h('button', { type: 'button', style: styles.button, disabled: state.saving || !state.dirty, onClick: () => instance.discard() }, '放弃草稿'),
          h('button', { type: 'button', style: styles.button, disabled, onClick: () => instance.reset() }, '恢复默认（保存后生效）'),
          h('button', {
            type: 'button', style: styles.button, disabled: state.saving,
            onClick: () => {
              audio.unlock()
              void audio.play(String(state.values.soundDone ?? 'chime-soft'))
            },
          }, '试听完成音')))
      }

      function ConfigView(props: { view?: string; configForm: ConfigForm }): unknown {
        return props.view === 'summary' ? summary : h(EditorView, { configForm: props.configForm })
      }

      ctx.effect(() => ctx.configForms.whileServed?.([ROW_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: BUNDLE_ID + '#' + ROW_ID,
        inject: () => ({ configForm: form }),
      }, ConfigView))), 'dsh-session-chime: configuration page')
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
    exported.summary = summary
    exported.ROW_ID = ROW_ID
    exported.FIELDS = FIELDS.map(field => field.key)
    exported.SOUND_IDS = Object.keys(__CHIME_SOUNDS)
    return exported
  },
})
