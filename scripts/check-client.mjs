#!/usr/bin/env node
/**
 * Shape check for the served browser bundle: it must stay a classic script, register
 * exactly one factory under the package name, require nothing but the platform React,
 * and export the surface the settings page and the tests drive.
 *
 * Usage: node scripts/check-client.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8');
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// A classic script: no ESM syntax may survive into the served bundle.
check(!/^\s*(import|export)\s/m.test(source), 'the bundle contains ESM syntax and cannot be served as a classic script');
check(source.startsWith('"use strict";'), 'the bundle does not start with the banner');
check(source.trimEnd().endsWith('})();'), 'the bundle is not wrapped in a single IIFE');

const requested = [];
const registry = {};
Reflect.set(globalThis, 'window', {
  __ModuleLoader__: { load(entry) { registry.entry = entry; } },
  addEventListener() {},
  removeEventListener() {},
});
vm.runInThisContext(source);
check(registry.entry?.id === 'dsh-session-chime', 'the factory registered under ' + String(registry.entry?.id));
const reactStub = {
  createElement: () => ({}),
  useState: init => [init(), () => {}],
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, read) => read(),
};
const api = registry.entry.factory(name => {
  requested.push(name);
  if (name === 'react') return reactStub;
  throw new Error('unexpected require: ' + name);
});

check(JSON.stringify(requested.filter(name => name !== 'react')) === '[]', 'the bundle requires ' + JSON.stringify(requested));
check(api.ROW_ID === 'session-chime', 'ROW_ID is ' + String(api.ROW_ID));
check(api.inject?.required?.includes('sessions') && api.inject?.required?.includes('configForms'), 'the bundle does not require the session catalog and settings form services');
check(api.inject?.optional?.includes('jobs'), 'the job roster service is not optional');
check(api.SOUND_IDS.length === 6, 'expected 6 shipped chimes, found ' + api.SOUND_IDS.length);
check(typeof api.isSettled === 'function' && typeof api.createWatcher === 'function' && typeof api.createEditor === 'function', 'the bundle stops exporting its testable helpers');
check(typeof api.inQuietHours === 'function' && typeof api.effectiveWindowMs === 'function', 'the bundle stops exporting its quiet-period helpers');
check(api.FIELDS.length === 14, 'expected 14 editable fields, found ' + api.FIELDS.length);
check(typeof api.shouldStopOnGesture === 'function' && typeof api.gestureStopsRing === 'function', 'the bundle stops exporting its stop guards');
check(api.PLACEMENTS?.length === 7, 'expected 7 banner placements, found ' + api.PLACEMENTS?.length);
check(typeof api.apply === 'function', 'the bundle exports no apply()');
check(/\(function \(\) \{/.test(source), 'the IIFE form changed');
try {
  assert.equal(api.isSettled({ running: false, liveJobs: 0, liveChildren: 0, goalPhase: null }), true);
} catch (error) {
  check(false, 'isSettled is not callable: ' + String(error?.message ?? error));
}

if (failures.length > 0) {
  console.error('FAILED (' + failures.length + ')');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log(`OK: client.js is one classic-script IIFE (${Math.round(source.length / 1024)} KB), registers dsh-session-chime, requires only react, and exports the checked surface`);
