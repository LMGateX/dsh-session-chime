/**
 * Host-half schema tests: defaults, volatile accessors, and the rejections a bad
 * composition must hit at load.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, resolveRowConfig, soundIds, type SoundId } from '../src/config.ts';

test('defaults match the shipped chime set', () => {
  const resolved = resolveRowConfig();
  assert.deepEqual(resolved, {
    enabled: true,
    soundDone: 'chime-soft',
    soundBlocked: 'alert-low',
    volume: 0.8,
    durationMs: 0,
    debounceMs: 1500,
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
  assert.throws(() => resolveRowConfig({ durationMs: -1 } as never), /durationMs must be a non-negative whole number/);
  assert.throws(() => resolveRowConfig({ debounceMs: 1.5 } as never), /debounceMs must be a non-negative whole number/);
});

test('the schema is a Schemastery node and knows every chime', () => {
  // Schemastery nodes are callable constructors, not plain objects.
  assert.equal(typeof Config, 'function');
  const json = JSON.stringify((Config as unknown as { toJSON(): unknown }).toJSON());
  for (const id of soundIds) assert.ok(json.includes(id), `schema should mention ${id}`);
  assert.equal(soundIds.length, 6);
});
