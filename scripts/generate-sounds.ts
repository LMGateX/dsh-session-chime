/**
 * Regenerates the shipped chime set from its upstream CC0 source.
 *
 * Source: Kenney "Interface Sounds" (CC0 1.0), mirrored at
 * https://github.com/Calinou/kenney-interface-sounds and pinned to one commit so a
 * rebuild downloads byte-identical input. The script downloads each source WAV,
 * downmixes to mono, resamples to 22050 Hz, trims silence, fades the edges and
 * normalizes — then writes `assets/sounds/<id>.wav` (committed) plus the
 * generated `client/sounds.generated.js` data module the browser half embeds.
 *
 * Run: node scripts/generate-sounds.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = '4596a49eaf5a533948d49a47467f606bcdea70ff';
const BASE = `https://raw.githubusercontent.com/Calinou/kenney-interface-sounds/${COMMIT}/addons/kenney_interface_sounds/`;
const TARGET_RATE = 22050;
const PEAK = 0.89;
/** Below this the sample counts as silence for trimming (-44 dBFS). */
const SILENCE = 0.006;

interface Source {
  /** Shipped preset id (also the settings value). */
  id: string;
  /** Upstream file name without extension. */
  file: string;
  /** What the settings page calls it. */
  label: string;
}

/** The shipped set, ordered the way the settings page lists it. */
const SOURCES: readonly Source[] = [
  { id: 'chime-soft', file: 'confirmation_002', label: '柔和双音' },
  { id: 'bell-bright', file: 'confirmation_001', label: '清脆铃' },
  { id: 'marimba', file: 'confirmation_004', label: '木琴上行' },
  { id: 'alert-low', file: 'error_005', label: '低沉警示' },
  { id: 'alert-sharp', file: 'error_007', label: '短促警示' },
  { id: 'blip', file: 'bong_001', label: '轻点' },
];

interface DecodedWav {
  channels: readonly Float32Array[];
  sampleRate: number;
}

/** Parse one RIFF/WAVE PCM file into per-channel float samples in [-1, 1]. */
function readWav(buf: Buffer): DecodedWav {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let format: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, pos + 8 + size);
    if (id === 'fmt ') {
      format = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    pos += 8 + size + (size % 2);
  }
  if (format === undefined || data === undefined) throw new Error('missing fmt/data chunk');
  if (format.format !== 1 || format.bits !== 16) throw new Error(`unsupported PCM format ${format.format}/${format.bits}`);
  const frames = Math.floor(data.length / (format.channels * 2));
  const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      const offset = (frame * format.channels + channel) * 2;
      channels[channel]![frame] = data.readInt16LE(offset) / 32768;
    }
  }
  return { channels, sampleRate: format.sampleRate };
}

/** Average every channel into one mono track. */
function toMono(decoded: DecodedWav): Float32Array {
  const frames = decoded.channels[0]!.length;
  if (decoded.channels.length === 1) return decoded.channels[0]!;
  const mono = new Float32Array(frames);
  for (const channel of decoded.channels) {
    for (let i = 0; i < frames; i += 1) mono[i] += channel[i]! / decoded.channels.length;
  }
  return mono;
}

/** Linear-interpolation resample; chimes carry no content near the old Nyquist. */
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const length = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Float32Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i += 1) {
    const position = i * step;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[Math.min(index, input.length - 1)]!;
    const b = input[Math.min(index + 1, input.length - 1)]!;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

/** Drop silent head/tail, keeping a short pad so the attack is never clipped. */
function trim(input: Float32Array, rate: number): Float32Array {
  const pad = Math.round(rate * 0.02);
  let start = 0;
  let end = input.length - 1;
  while (start < input.length && Math.abs(input[start]!) <= SILENCE) start += 1;
  while (end > start && Math.abs(input[end]!) <= SILENCE) end -= 1;
  const from = Math.max(0, start - pad);
  const to = Math.min(input.length, end + 1 + pad);
  return input.slice(from, to);
}

/** Click-free edges: 4 ms in, 12 ms out. */
function fade(input: Float32Array, rate: number): Float32Array {
  const output = Float32Array.from(input);
  const fadeIn = Math.min(output.length, Math.round(rate * 0.004));
  const fadeOut = Math.min(output.length - fadeIn, Math.round(rate * 0.012));
  for (let i = 0; i < fadeIn; i += 1) output[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut; i += 1) {
    output[output.length - 1 - i] *= i / fadeOut;
  }
  return output;
}

/** Scale to the target peak; a silent clip is returned untouched. */
function normalize(input: Float32Array): Float32Array {
  let peak = 0;
  for (const sample of input) peak = Math.max(peak, Math.abs(sample));
  if (peak === 0) return input;
  const gain = PEAK / peak;
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) output[i] = input[i]! * gain;
  return output;
}

/** Encode one mono float track as a 16-bit PCM RIFF/WAVE file. */
function encodeWav(samples: Float32Array, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.length * 2, 40);
  const body = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    body.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return Buffer.concat([header, body]);
}

/** Download one upstream WAV. */
async function download(name: string): Promise<Buffer> {
  const response = await fetch(BASE + name + '.wav');
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const outDir = join(ROOT, 'assets', 'sounds');
mkdirSync(outDir, { recursive: true });

const shipped: { id: string; label: string; durationMs: number; data: string }[] = [];
for (const source of SOURCES) {
  const raw = await download(source.file);
  const decoded = readWav(raw);
  const mono = toMono(decoded);
  const resampled = resample(mono, decoded.sampleRate, TARGET_RATE);
  const trimmed = trim(resampled, TARGET_RATE);
  const faded = fade(trimmed, TARGET_RATE);
  const samples = normalize(faded);
  const wav = encodeWav(samples, TARGET_RATE);
  writeFileSync(join(outDir, source.id + '.wav'), wav);
  const durationMs = Math.round((samples.length / TARGET_RATE) * 1000);
  shipped.push({ id: source.id, label: source.label, durationMs, data: 'data:audio/wav;base64,' + wav.toString('base64') });
  console.log(`${source.id.padEnd(12)} ${source.file.padEnd(18)} ${String(durationMs).padStart(4)} ms  ${String(wav.length).padStart(6)} B  -> ${Math.round(wav.length / 1024 * 4 / 3)} KB base64`);
}

const total = shipped.reduce((sum, entry) => sum + entry.data.length, 0);
console.log(`total embedded base64: ${Math.round(total / 1024)} KB`);

const module =
  '// Generated by scripts/generate-sounds.ts — do not edit by hand.\n' +
  '// Source: Kenney "Interface Sounds" (CC0 1.0), commit ' + COMMIT + '.\n' +
  'const __CHIME_SOUNDS = ' +
  JSON.stringify(Object.fromEntries(shipped.map(({ id, label, durationMs, data }) => [id, { label, durationMs, data }])), null, 0) +
  ';\n';
writeFileSync(join(ROOT, 'client', 'sounds.generated.js'), module);

writeFileSync(
  join(outDir, 'LICENSE.txt'),
  [
    'Interface Sounds (1.0)',
    'Created/distributed by Kenney (www.kenney.nl)',
    'License: Creative Commons Zero, CC0 (http://creativecommons.org/publicdomain/zero/1.0/)',
    '',
    'These files are downmixed to mono, resampled to 22050 Hz, trimmed, faded and',
    'normalized by scripts/generate-sounds.ts. The upstream set is mirrored at',
    'https://github.com/Calinou/kenney-interface-sounds (commit ' + COMMIT + ').',
    '',
  ].join('\n'),
);
console.log('wrote assets/sounds/*.wav and client/sounds.generated.js');
