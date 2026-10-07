/**
 * Browser-half tests. They load the built bundle the way the web shell does — as a
 * classic script — and drive the exported helpers under a fake clock and a fake
 * settings form.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import type { ConfigForm, ConfigFormSnapshot, PathOperation, SessionListSnapshot } from '../client/public.js';

type Reason = 'done' | 'blocked';

interface ClientApi {
  inject: unknown;
  apply(ctx: unknown): void;
  isSettled(input: { running: boolean; liveJobs: number; liveChildren: number; goalPhase: string | null }): boolean;
  createWatcher(deps: Record<string, unknown>): { update(sessions: SessionListSnapshot, jobs: { rows: Record<string, readonly { status: string; owner?: string }[]> } | undefined): void };
  createEditor(form: ConfigForm): {
    getSnapshot(): { status: string; writable: boolean; values: Record<string, string | boolean>; dirty: boolean; saving: boolean; error: string; conflict: boolean };
    subscribe(fn: () => void): () => void;
    start(): () => void;
    edit(field: string, value: string | boolean): void;
    discard(): void;
    reset(): void;
    save(): Promise<boolean>;
  };
  settingsOf(value: unknown): Record<string, unknown>;
  parseDuration(text: string): { value?: number; error?: string };
  parseVolume(text: string): { value?: number; error?: string };
  parseClock(text: unknown): number | null;
  inQuietHours(now: Date, start: string, end: string): boolean;
  effectiveWindowMs(settings: Record<string, unknown>, clipMs: number, now: Date): number;
  checkTime(text: string): string | undefined;
  shouldStopOnGesture(startedAt: number | undefined, now: number, minRingMs: number): boolean;
  gestureStopsRing(placement: string, bannerShown: boolean, startedAt: number | undefined, now: number, minRingMs: number): boolean;
  PLACEMENTS: string[];
  ROW_ID: string;
  FIELDS: string[];
  SOUND_IDS: string[];
}

/** Load the served bundle exactly the way the shell does. */
function loadClient(): ClientApi {
  const source = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8');
  const registry: { entry?: { id: string; factory(require: (name: string) => unknown): ClientApi } } = {};
  Reflect.set(globalThis, 'window', {
    __ModuleLoader__: { load(entry: { id: string; factory(require: (name: string) => unknown): unknown }) { registry.entry = entry as never } },
    addEventListener() {},
    removeEventListener() {},
  });
  vm.runInThisContext(source);
  assert.ok(registry.entry, 'the bundle registered a factory');
  // The factory materializes eagerly and needs the platform React runtime; the
  // exported helpers under test never render, so a shape-correct stub is enough.
  const reactStub = {
    createElement: () => ({}),
    useState: (init: () => unknown) => [init(), () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  };
  return registry.entry.factory(name => {
    if (name === 'react') return reactStub;
    throw new Error('unexpected require: ' + name);
  });
}

const client = loadClient();

/** Deterministic clock: the watcher never touches the real one. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number) {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer(handle: unknown) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

/** Build a session catalog snapshot from a compact description. */
function sessionsOf(rows: Record<string, { running?: boolean; parentId?: string; origin?: string; phase?: string | null; title?: string }>): SessionListSnapshot {
  const ids = Object.keys(rows);
  const byId: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    const row = rows[id]!;
    byId[id] = {
      id,
      displayTitle: row.title ?? 'session ' + id,
      running: row.running === true,
      ...(row.parentId === undefined ? {} : { parentId: row.parentId }),
      ...(row.origin === undefined ? {} : { origin: row.origin }),
      ...(row.phase === undefined ? {} : { projectionValues: { goal: row.phase === null ? null : { goal: { phase: row.phase } } } }),
    };
  }
  return { ids, byId } as SessionListSnapshot;
}

interface Harness {
  clock: ReturnType<typeof fakeClock>;
  rings: Reason[];
  ringed: { reason: Reason; id: string; title: string }[];
  watched: string[];
  released: string[];
  update(sessions: SessionListSnapshot, jobs?: { rows: Record<string, readonly { status: string; owner?: string }[]> }): void;
  setDebounce(ms: number): void;
}

function harness(): Harness {
  const clock = fakeClock();
  const rings: Reason[] = [];
  const ringed: { reason: Reason; id: string; title: string }[] = [];
  const watched: string[] = [];
  const released: string[] = [];
  let debounceMs = 1500;
  const watcher = client.createWatcher({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    readSettings: () => ({ enabled: true, debounceMs }),
    ring: (reason: Reason, session: { id: string; title: string }) => {
      rings.push(reason);
      ringed.push({ reason, id: session.id, title: session.title });
    },
    watch: (id: string) => watched.push(id),
    unwatch: (id: string) => released.push(id),
  });
  return {
    clock, rings, ringed, watched, released,
    update: (sessions, jobs) => watcher.update(sessions, jobs),
    setDebounce: (ms: number) => {
      debounceMs = ms;
    },
  };
}

test('isSettled needs complete quiescence', () => {
  assert.equal(client.isSettled({ running: false, liveJobs: 0, liveChildren: 0, goalPhase: null }), true);
  assert.equal(client.isSettled({ running: true, liveJobs: 0, liveChildren: 0, goalPhase: null }), false);
  assert.equal(client.isSettled({ running: false, liveJobs: 1, liveChildren: 0, goalPhase: null }), false);
  assert.equal(client.isSettled({ running: false, liveJobs: 0, liveChildren: 1, goalPhase: null }), false);
  assert.equal(client.isSettled({ running: false, liveJobs: 0, liveChildren: 0, goalPhase: 'active' }), false);
  assert.equal(client.isSettled({ running: false, liveJobs: 0, liveChildren: 0, goalPhase: 'blocked' }), true);
  assert.equal(client.isSettled({ running: false, liveJobs: 0, liveChildren: 0, goalPhase: 'complete' }), true);
});

test('an already idle session does not ring on load', () => {
  const h = harness();
  h.update(sessionsOf({ a: { running: false } }));
  h.clock.advance(10000);
  assert.deepEqual(h.rings, []);
});

test('a busy session that stops rings once after the quiet period', () => {
  const h = harness();
  h.update(sessionsOf({ a: { running: true, title: '修复登录' } }));
  assert.deepEqual(h.watched, ['a']);
  h.update(sessionsOf({ a: { running: false, title: '修复登录' } }));
  assert.equal(h.clock.pending(), 1);
  h.clock.advance(1500);
  assert.deepEqual(h.rings, ['done']);
  // The banner needs to name the session, so the ring carries its label.
  assert.deepEqual(h.ringed, [{ reason: 'done', id: 'a', title: '修复登录' }]);
  h.update(sessionsOf({ a: { running: false } }));
  h.clock.advance(10000);
  assert.deepEqual(h.rings, ['done']);
});

test('waiting on a live job stays silent until the job settles', () => {
  const h = harness();
  h.update(sessionsOf({ a: { running: true } }));
  h.update(sessionsOf({ a: { running: false } }), { rows: { a: [{ status: 'running', owner: 'a' }] } });
  h.clock.advance(5000);
  assert.deepEqual(h.rings, []);
  h.update(sessionsOf({ a: { running: false } }), { rows: { a: [{ status: 'completed', owner: 'a' }] } });
  h.clock.advance(1500);
  assert.deepEqual(h.rings, ['done']);
});

test('an unowned job never counts as this session\'s work', () => {
  const h = harness();
  h.update(sessionsOf({ a: { running: true } }));
  h.update(sessionsOf({ a: { running: false } }), { rows: { a: [{ status: 'running' }] } });
  h.clock.advance(1500);
  assert.deepEqual(h.rings, ['done']);
});

test('a working subagent holds the chime', () => {
  const h = harness();
  h.update(sessionsOf({ a: { running: true }, child: { running: true, parentId: 'a', origin: 'subagent' } }));
  h.update(sessionsOf({ a: { running: false }, child: { running: true, parentId: 'a', origin: 'subagent' } }));
  h.clock.advance(5000);
  assert.deepEqual(h.rings, []);
  h.update(sessionsOf({ a: { running: false }, child: { running: false, parentId: 'a', origin: 'subagent' } }));
  h.clock.advance(1500);
  assert.deepEqual(h.rings, ['done']);
});

test('subagent sessions never ring on their own', () => {
  const h = harness();
  h.update(sessionsOf({ child: { running: true, parentId: 'a', origin: 'subagent' } }));
  h.update(sessionsOf({ child: { running: false, parentId: 'a', origin: 'subagent' } }));
  h.clock.advance(10000);
  assert.deepEqual(h.rings, []);
});

test('an active goal holds the chime and a blocked goal rings at once', () => {
  const h = harness();
  h.update(sessionsOf({ a: { running: true, phase: 'active' } }));
  h.update(sessionsOf({ a: { running: false, phase: 'active' } }));
  h.clock.advance(5000);
  assert.deepEqual(h.rings, []);
  h.update(sessionsOf({ a: { running: false, phase: 'blocked' } }));
  assert.deepEqual(h.rings, ['blocked']);
});

test('a second quiet stretch rings again after a new turn', () => {
  const h = harness();
  h.update(sessionsOf({ a: { running: true } }));
  h.update(sessionsOf({ a: { running: false } }));
  h.clock.advance(1500);
  h.update(sessionsOf({ a: { running: true } }));
  h.update(sessionsOf({ a: { running: false } }));
  h.clock.advance(1500);
  assert.deepEqual(h.rings, ['done', 'done']);
});

test('a session that leaves the catalog releases its roster watch', () => {
  const h = harness();
  h.update(sessionsOf({ a: { running: true } }));
  h.update(sessionsOf({}));
  assert.deepEqual(h.released, ['a']);
});

/** Minimal settings-form stub matching the public service contract. */
function formOf(value: unknown, revision = 7): { form: ConfigForm; operations: PathOperation[][]; snapshot: ConfigFormSnapshot } {
  const operations: PathOperation[][] = [];
  const snapshot = { status: 'ready', writable: true, revision, value };
  const form: ConfigForm = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    async mutate(ops) {
      operations.push([...ops]);
      return true;
    },
  };
  return { form, operations, snapshot };
}

test('the editor seeds, stages, and saves one fenced mutation', async () => {
  const { form, operations } = formOf({ enabled: true, soundDone: 'chime-soft' });
  const editor = client.createEditor(form);
  editor.start();
  assert.equal(editor.getSnapshot().values.soundDone, 'chime-soft');
  editor.edit('soundDone', 'marimba');
  editor.edit('durationMs', '3000');
  editor.edit('dndStart', '22:00');
  editor.edit('restMode', true);
  assert.equal(editor.getSnapshot().dirty, true);
  assert.equal(await editor.save(), true);
  assert.deepEqual(operations, [[
    { op: 'set', path: ['soundDone'], value: 'marimba' },
    { op: 'set', path: ['durationMs'], value: 3000 },
    { op: 'set', path: ['dndStart'], value: '22:00' },
    { op: 'set', path: ['restMode'], value: true },
  ]]);
});

test('the editor refuses invalid numbers and keeps the draft', async () => {
  const { form, operations } = formOf({});
  const editor = client.createEditor(form);
  editor.start();
  editor.edit('volume', '3');
  assert.equal(await editor.save(), false);
  assert.equal(operations.length, 0);
  assert.match(editor.getSnapshot().error, /音量/);
});

test('reset submits unsets for every field', async () => {
  const { form, operations } = formOf({ enabled: true });
  const editor = client.createEditor(form);
  editor.start();
  editor.reset();
  await editor.save();
  assert.deepEqual(operations[0]?.map(op => op.op), new Array(client.FIELDS.length).fill('unset'));
});

test('settingsOf falls back to the shipped defaults on junk', () => {
  assert.deepEqual(client.settingsOf({}), client.settingsOf(null));
  assert.equal(client.settingsOf({ soundDone: 'nope' }).soundDone, 'chime-soft');
  assert.equal(client.settingsOf({ volume: 9 }).volume, 1);
  assert.equal(client.settingsOf({ debounceMs: -1 }).debounceMs, 1500);
  assert.equal(client.settingsOf({ quietStyle: 'shout' }).quietStyle, 'short');
  assert.equal(client.settingsOf({ dndStart: '25:00' }).dndStart, '');
  assert.equal(client.settingsOf({ restMode: 'yes' }).restMode, false);
  assert.equal(client.settingsOf({ minRingMs: -1 }).minRingMs, 3000);
  assert.equal(client.settingsOf({ banner: 'yes' }).banner, true);
  assert.equal(client.settingsOf({ bannerPlacement: 'middle' }).bannerPlacement, 'bottom-center');
  assert.equal(client.settingsOf({ bannerPlacement: 'modal' }).bannerPlacement, 'modal');
});

test('parseClock reads a 24-hour local time', () => {
  assert.equal(client.parseClock('00:00'), 0);
  assert.equal(client.parseClock('22:30'), 22 * 60 + 30);
  assert.equal(client.parseClock(' 08:00 '), 480);
  assert.equal(client.parseClock('24:00'), null);
  assert.equal(client.parseClock('8:00'), null);
  assert.equal(client.parseClock(''), null);
  assert.equal(client.parseClock(undefined), null);
});

test('the do-not-disturb window handles same-day and cross-midnight spans', () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 0, 1, hours, minutes, 0);
  // 13:00–14:00, same day.
  assert.equal(client.inQuietHours(at(12, 59), '13:00', '14:00'), false);
  assert.equal(client.inQuietHours(at(13, 0), '13:00', '14:00'), true);
  assert.equal(client.inQuietHours(at(13, 59), '13:00', '14:00'), true);
  assert.equal(client.inQuietHours(at(14, 0), '13:00', '14:00'), false);
  // 22:00–08:00 crosses midnight.
  assert.equal(client.inQuietHours(at(23), '22:00', '08:00'), true);
  assert.equal(client.inQuietHours(at(3), '22:00', '08:00'), true);
  assert.equal(client.inQuietHours(at(12), '22:00', '08:00'), false);
  // Empty or zero-length windows are off.
  assert.equal(client.inQuietHours(at(23), '', '08:00'), false);
  assert.equal(client.inQuietHours(at(23), '22:00', ''), false);
  assert.equal(client.inQuietHours(at(23), '22:00', '22:00'), false);
});

test('effectiveWindowMs applies the master switch and the quiet rules', () => {
  const at = (hours: number) => new Date(2026, 0, 1, hours, 0, 0);
  const base = {
    enabled: true, soundDone: 'chime-soft', soundBlocked: 'alert-low', volume: 0.8,
    durationMs: 0, debounceMs: 1500, quietStyle: 'short', quietShortMs: 400,
    dndStart: '', dndEnd: '', restMode: false,
  };
  // 0 duration = one full play-through.
  assert.equal(client.effectiveWindowMs(base, 500, at(12)), 500);
  assert.equal(client.effectiveWindowMs({ ...base, durationMs: 60_000 }, 500, at(12)), 60_000);
  // Master switch off wins over everything.
  assert.equal(client.effectiveWindowMs({ ...base, enabled: false }, 500, at(12)), 0);
  // Rest mode shortens to quietShortMs, silence drops the chime entirely.
  assert.equal(client.effectiveWindowMs({ ...base, restMode: true }, 500, at(12)), 400);
  assert.equal(client.effectiveWindowMs({ ...base, restMode: true, quietStyle: 'silent' }, 500, at(12)), 0);
  // A short quiet window never stretches a longer request.
  assert.equal(client.effectiveWindowMs({ ...base, restMode: true, durationMs: 60_000 }, 500, at(12)), 400);
  assert.equal(client.effectiveWindowMs({ ...base, restMode: true, durationMs: 200 }, 500, at(12)), 200);
  // The do-not-disturb window behaves exactly like rest mode while it is active.
  const dnd = { ...base, dndStart: '22:00', dndEnd: '08:00' };
  assert.equal(client.effectiveWindowMs(dnd, 500, at(23)), 400);
  assert.equal(client.effectiveWindowMs(dnd, 500, at(12)), 500);
});

test('shortest-ring guard: activity cannot cut a ring too early', () => {
  assert.equal(client.shouldStopOnGesture(undefined, 10_000, 3000), false);
  assert.equal(client.shouldStopOnGesture(1000, 2500, 3000), false);
  assert.equal(client.shouldStopOnGesture(1000, 4000, 3000), true);
  // A zero minimum lets the very next gesture stop it.
  assert.equal(client.shouldStopOnGesture(1000, 1000, 0), true);
});

test('the masked modal ignores activity; every other placement honours the guard', () => {
  // Modal: never stopped by a gesture, however long the ring has been going.
  assert.equal(client.gestureStopsRing('modal', true, 1000, 99_999, 3000), false);
  // Without the banner there is no modal to acknowledge, so the guard decides.
  assert.equal(client.gestureStopsRing('modal', false, 1000, 5000, 3000), true);
  // Corner and centre placements behave like the plain guard.
  for (const placement of ['bottom-center', 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center']) {
    assert.equal(client.gestureStopsRing(placement, true, 1000, 2000, 3000), false, placement);
    assert.equal(client.gestureStopsRing(placement, true, 1000, 5000, 3000), true, placement);
  }
  assert.deepEqual(client.PLACEMENTS, ['bottom-center', 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'modal']);
});

test('the time field accepts an empty string or HH:mm only', () => {
  assert.equal(client.checkTime(''), undefined);
  assert.equal(client.checkTime('07:05'), undefined);
  assert.match(String(client.checkTime('7:05')), /HH:mm/);
  assert.match(String(client.checkTime('25:00')), /HH:mm/);
});

test('parse helpers reject junk', () => {
  assert.deepEqual(client.parseDuration('1500'), { value: 1500 });
  assert.ok(client.parseDuration('1.5').error);
  assert.deepEqual(client.parseVolume('0.35'), { value: 0.35 });
  assert.ok(client.parseVolume('2').error);
});

test('the bundle declares its row and the shipped chime set', () => {
  assert.equal(client.ROW_ID, 'session-chime');
  assert.deepEqual(client.SOUND_IDS, ['chime-soft', 'bell-bright', 'marimba', 'alert-low', 'alert-sharp', 'blip']);
  assert.deepEqual(client.FIELDS, [
    'enabled', 'soundDone', 'soundBlocked', 'volume', 'durationMs', 'debounceMs',
    'quietStyle', 'quietShortMs', 'dndStart', 'dndEnd', 'restMode', 'minRingMs', 'banner', 'bannerPlacement',
  ]);
});
