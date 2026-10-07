/**
 * Host-half schema tests: defaults, volatile accessors, and the rejections a bad
 * composition must hit at load.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, MAX_DURATION_MS, resolveRowConfig, soundIds, type SoundId } from '../src/config.ts';

test('defaults match the shipped chime set', () => {
  const resolved = resolveRowConfig();
  assert.deepEqual(resolved, {
    enabled: true,
    soundDone: 'chime-soft',
    soundBlocked: 'alert-low',
    volume: 0.8,
    durationMs: 0,
    debounceMs: 1500,
    quietStyle: 'short',
    quietShortMs: 600,
    dndStart: '',
    dndEnd: '',
    restMode: false,
    minRingMs: 3000,
    banner: true,
    bannerPlacement: 'bottom-center',
  });
});

test('volatile accessors are read, not the wrapper', () => {
  let soundDone: SoundId = 'blip';
  const resolved = resolveRowConfig({
    soundDone: { get: () => soundDone },
    enabled: { get: () => false },
    volume: { get: () => 0.25 },
  });
  assert.equal(resolved.soundDone, 'blip');
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.volume, 0.25);
  soundDone = 'marimba';
  assert.equal(resolveRowConfig({ soundDone: { get: () => soundDone } }).soundDone, 'marimba');
});

test('plain values are accepted unchanged', () => {
  assert.equal(resolveRowConfig({ soundBlocked: 'alert-sharp', durationMs: 4000, debounceMs: 0 }).durationMs, 4000);
  assert.equal(resolveRowConfig({ debounceMs: 0 }).debounceMs, 0);
});

test('unknown keys fail the composition', () => {
  assert.throws(() => resolveRowConfig({ nope: true } as never), /unknown configuration option "nope"/);
});

test('bad values name the offending field', () => {
  assert.throws(() => resolveRowConfig({ soundDone: 'bell' } as never), /soundDone must be one of/);
  assert.throws(() => resolveRowConfig({ enabled: 'yes' } as never), /enabled must be a boolean/);
  assert.throws(() => resolveRowConfig({ volume: 1.5 } as never), /volume must be a number between 0 and 1/);
  assert.throws(() => resolveRowConfig({ durationMs: -1 } as never), /durationMs must be a whole number of milliseconds between 0 and/);
  assert.throws(() => resolveRowConfig({ debounceMs: 1.5 } as never), /debounceMs must be a whole number of milliseconds between 0 and/);
  assert.throws(() => resolveRowConfig({ quietStyle: 'loud' } as never), /quietStyle must be one of short, silent/);
  assert.throws(() => resolveRowConfig({ dndStart: '25:00' } as never), /dndStart must be an empty string or a local HH:mm time/);
  assert.throws(() => resolveRowConfig({ dndEnd: '8:00' } as never), /dndEnd must be an empty string or a local HH:mm time/);
  assert.throws(() => resolveRowConfig({ restMode: 'yes' } as never), /restMode must be a boolean/);
  assert.throws(() => resolveRowConfig({ banner: 'yes' } as never), /banner must be a boolean/);
  assert.throws(() => resolveRowConfig({ minRingMs: -1 } as never), /minRingMs must be a whole number/);
  assert.throws(() => resolveRowConfig({ bannerPlacement: 'middle' } as never), /bannerPlacement must be one of bottom-center/);
});

test('every banner placement is accepted', () => {
  for (const placement of ['bottom-center', 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'modal'] as const) {
    assert.equal(resolveRowConfig({ bannerPlacement: placement }).bannerPlacement, placement);
  }
});

test('duration fields accept hours but refuse a typo-driven week', () => {
  assert.equal(resolveRowConfig({ durationMs: 60_000 }).durationMs, 60_000);
  assert.equal(resolveRowConfig({ durationMs: MAX_DURATION_MS }).durationMs, MAX_DURATION_MS);
  assert.equal(resolveRowConfig({ quietShortMs: 30_000 }).quietShortMs, 30_000);
  assert.throws(() => resolveRowConfig({ durationMs: MAX_DURATION_MS + 1 } as never), /durationMs must be a whole number of milliseconds between 0 and/);
  assert.throws(() => resolveRowConfig({ quietShortMs: MAX_DURATION_MS + 1 } as never), /quietShortMs must be a whole number/);
});

test('quiet-period style and clock values pass through', () => {
  const resolved = resolveRowConfig({ quietStyle: 'silent', dndStart: '22:00', dndEnd: '08:00', restMode: true, minRingMs: 5000, banner: false, bannerPlacement: 'modal' });
  assert.equal(resolved.quietStyle, 'silent');
  assert.equal(resolved.dndStart, '22:00');
  assert.equal(resolved.dndEnd, '08:00');
  assert.equal(resolved.restMode, true);
  assert.equal(resolved.minRingMs, 5000);
  assert.equal(resolved.banner, false);
  assert.equal(resolved.bannerPlacement, 'modal');
});

test('the schema is a Schemastery node and knows every chime', () => {
  // Schemastery nodes are callable constructors, not plain objects.
  assert.equal(typeof Config, 'function');
  const json = JSON.stringify((Config as unknown as { toJSON(): unknown }).toJSON());
  for (const id of soundIds) assert.ok(json.includes(id), `schema should mention ${id}`);
  assert.equal(soundIds.length, 6);
});
