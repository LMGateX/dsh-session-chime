#!/usr/bin/env node
/**
 * Freshness gate for the served browser bundle.
 *
 * client/client.js is a build artifact (scripts/build-client.mjs concatenates the
 * compiled body with the generated sound table). Every other check inspects that
 * artifact, so a stale file silently validates old code — which is how 0.5.0
 * shipped a bundle built before its own UI rework. This gate fails whenever an
 * input is newer than the artifact.
 *
 * Usage: node scripts/check-fresh.mjs
 */
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const artifact = join(ROOT, 'client', 'client.js');
const inputs = [
  join(ROOT, 'client', 'main.ts'),
  join(ROOT, 'client', 'public.ts'),
  join(ROOT, 'client', 'sounds.generated.js'),
  join(ROOT, 'scripts', 'build-client.mjs'),
];

const built = statSync(artifact).mtimeMs;
const stale = inputs.filter(input => statSync(input).mtimeMs > built);
if (stale.length > 0) {
  console.error('FAILED: client/client.js is older than ' + stale.map(path => path.slice(ROOT.length + 1)).join(', '));
  console.error('        run "npm run build" — checks and npm pack would otherwise validate a stale bundle.');
  process.exit(1);
}
console.log('OK: client/client.js is newer than every input (' + Math.round((Date.now() - built) / 1000) + 's old)');
