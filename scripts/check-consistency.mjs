#!/usr/bin/env node
/**
 * Cross-checks the four places the shipped chime set is written down:
 * the generated sound table, the host schema, the public client types, and the
 * committed WAV assets. A drift between them is a defect, not a warning.
 *
 * Usage: node scripts/check-consistency.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const generated = readFileSync(join(ROOT, 'client', 'sounds.generated.js'), 'utf8');
const table = JSON.parse(generated.slice(generated.indexOf('{'), generated.lastIndexOf('}') + 1));
const generatedIds = Object.keys(table);

const config = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8');
const schemaMatch = config.match(/export const soundIds = \[([^\]]*)\]/);
check(schemaMatch !== null, 'src/config.ts no longer declares soundIds');
const schemaIds = schemaMatch === null ? [] : [...schemaMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]);

const publicTs = readFileSync(join(ROOT, 'client', 'public.ts'), 'utf8');
const publicMatch = publicTs.match(/export const SOUND_IDS: readonly string\[\] = \[([^\]]*)\]/);
check(publicMatch !== null, 'client/public.ts no longer declares SOUND_IDS');
const publicIds = publicMatch === null ? [] : [...publicMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]);

const assets = readdirSync(join(ROOT, 'assets', 'sounds'))
  .filter(name => name.endsWith('.wav'))
  .map(name => name.slice(0, -4))
  .sort();

check(generatedIds.length > 0, 'the generated sound table is empty');
check(JSON.stringify(schemaIds) === JSON.stringify(generatedIds), `schema ids ${JSON.stringify(schemaIds)} != generated ${JSON.stringify(generatedIds)}`);
check(JSON.stringify(publicIds) === JSON.stringify(generatedIds), `public ids ${JSON.stringify(publicIds)} != generated ${JSON.stringify(generatedIds)}`);
check(JSON.stringify(assets) === JSON.stringify([...generatedIds].sort()), `asset files ${JSON.stringify(assets)} != generated ${JSON.stringify(generatedIds)}`);
for (const [id, spec] of Object.entries(table)) {
  check(typeof spec.label === 'string' && spec.label.length > 0, `${id} has no label`);
  check(spec.data.startsWith('data:audio/wav;base64,'), `${id} is not an embedded WAV`);
  check(spec.durationMs > 0 && spec.durationMs < 5000, `${id} duration ${spec.durationMs} ms is out of range`);
}

if (failures.length > 0) {
  console.error('FAILED (' + failures.length + ')');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log(`OK: ${generatedIds.length} chimes agree across the generated table, the host schema, the public types and assets/sounds (total ${Math.round(generated.length / 1024)} KB)`);
