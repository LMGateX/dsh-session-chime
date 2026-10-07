#!/usr/bin/env node
/**
 * Host-side end-to-end check for the row configuration form.
 *
 * The DSH Plugins page renders a row's configuration namespace only when the host
 * settings service can build a *volatile* form for it: `volatileForm(schema)`
 * returns undefined when no field carries `meta.volatile`, and `describe()` then
 * omits the row entirely — the page would show a card with no controls.
 *
 * This runs the real installed host class against this plugin: a real cordis
 * Context, the plugin mounted as a genuine fiber (so `runtime.Config` and the
 * volatile accessors are what a profile would hand over), and the installed
 * `@deepseek-ai/dsh-settings` `SettingsForms`, whose `describe()` is the source
 * the browser's `ctx.configForms.describe()` mirrors.
 *
 * Usage: node scripts/check-settings-form.mjs     (exit 0 = form namespace present)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(new URL(import.meta.url).pathname))
const EXPECTED_FIELDS = ['enabled', 'soundDone', 'soundBlocked', 'volume', 'durationMs', 'debounceMs', 'quietStyle', 'quietShortMs', 'dndStart', 'dndEnd', 'restMode', 'minRingMs', 'banner', 'bannerPlacement']
const EXPECTED_PLACEMENTS = ['bottom-center', 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'center', 'modal']
const EXPECTED_SOUNDS = ['chime-soft', 'bell-bright', 'marimba', 'alert-low', 'alert-sharp', 'blip']
const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

const anchor = dshInstallAnchor()
const require = createRequire(anchor)
const resolve = name => pathToFileURL(join(dirname(require.resolve(name + '/package.json')), 'lib', 'index.js')).href

const { Context } = await import(resolve('@deepseek-ai/cordis'))
const settingsModule = await import(resolve('@deepseek-ai/dsh-settings'))
const SettingsForms = settingsModule.default ?? settingsModule.SettingsForms
check(typeof SettingsForms === 'function', 'the installed dsh-settings exports no SettingsForms class')
if (typeof SettingsForms !== 'function') {
  console.error('FAILED: cannot reach the host settings service; this check cannot run')
  process.exit(1)
}

const plugin = await import(pathToFileURL(join(ROOT, 'src', 'index.ts')).href)
const home = mkdtempSync(join(tmpdir(), 'dsh-chime-form-'))

const ctx = new Context()
const provide = (name, value) => {
  ctx.provide(name)
  ctx.set(name, value)
}
provide('loader', { await: async () => {}, entries: () => [] })

let fiber
try {
  fiber = ctx.plugin(plugin.sessionChime, {})
  await fiber
} catch (error) {
  check(false, 'the plugin could not be mounted on a real cordis context: ' + String(error?.message ?? error))
}

if (fiber !== undefined) {
  check(fiber.state === 2, 'the plugin fiber is not started (state ' + String(fiber.state) + ')')
  check(fiber.runtime?.Config !== undefined, 'the mounted fiber publishes no runtime.Config')
  const entry = {
    options: { id: 'session-chime', config: {} },
    fiber,
    parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
  }
  provide('configEditor', {
    documentPath: join(home, 'cordis.patch.yml'),
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: {} }],
    edit: async (_entry, change) => { await change({ soundDone: 'marimba' }, {}, plugin.Config) },
  })
  provide('profileContext', { name: 'settings-check', home, dir: home, installAnchor: anchor })

  let forms
  try {
    await ctx.plugin(SettingsForms)
    forms = ctx.get('settings')
  } catch (error) {
    check(false, 'the host settings service could not be mounted: ' + String(error?.message ?? error))
  }

  if (forms !== undefined) {
    let described
    try {
      described = forms.describe()
    } catch (error) {
      check(false, 'settings.describe() threw: ' + String(error?.message ?? error))
    }
    const row = (described ?? []).find(item => item.ns === 'session-chime')
    check(row !== undefined, 'the host settings service describes no namespace for "session-chime": the Plugins page renders nothing')
    if (row !== undefined) {
      check(row.applies === 'live', 'the described namespace is not live-applied: ' + String(row.applies))
      const json = row.schema ?? {}
      const envelope = json.refs?.[String(json.uid)] ?? {}
      const dict = envelope.dict ?? {}
      const node = field => json.refs?.[dict[field]] ?? {}
      const fields = Object.keys(dict)
      check(JSON.stringify(fields) === JSON.stringify(EXPECTED_FIELDS), 'the described form fields are ' + JSON.stringify(fields))

      // Only volatile fields survive volatileForm, so a six-field projection proves
      // the predicate passed; volatility itself is read off the live schema.
      const live = fiber.runtime.Config.toJSON()
      const liveDict = live.refs[String(live.uid)].dict ?? {}
      const volatile = Object.fromEntries(Object.entries(liveDict).map(([field, id]) => [field, live.refs[id].meta?.volatile === true]))
      check(Object.values(volatile).every(Boolean), 'a live Config field is not volatile: ' + JSON.stringify(volatile))

      for (const field of ['soundDone', 'soundBlocked']) {
        const spec = node(field)
        check(spec.type === 'union', field + ' is not a union but ' + JSON.stringify(spec.type))
        const choices = (spec.list ?? []).map(id => json.refs[id]?.value)
        check(JSON.stringify(choices) === JSON.stringify(EXPECTED_SOUNDS), 'the described ' + field + ' choices are ' + JSON.stringify(choices))
      }
      check(node('soundDone').meta?.default === 'chime-soft', 'soundDone default is ' + JSON.stringify(node('soundDone').meta?.default))
      check(node('soundBlocked').meta?.default === 'alert-low', 'soundBlocked default is ' + JSON.stringify(node('soundBlocked').meta?.default))
      check(node('enabled').meta?.default === true, 'enabled default is ' + JSON.stringify(node('enabled').meta?.default))
      check(node('volume').meta?.default === 0.8, 'volume default is ' + JSON.stringify(node('volume').meta?.default))
      check(node('debounceMs').meta?.default === 1500, 'debounceMs default is ' + JSON.stringify(node('debounceMs').meta?.default))
      check(node('quietStyle').type === 'union', 'quietStyle is not a union but ' + JSON.stringify(node('quietStyle').type))
      check(JSON.stringify((node('quietStyle').list ?? []).map(id => json.refs[id]?.value)) === JSON.stringify(['short', 'silent']), 'quietStyle choices are wrong')
      check(node('quietStyle').meta?.default === 'short', 'quietStyle default is ' + JSON.stringify(node('quietStyle').meta?.default))
      check(node('quietShortMs').meta?.default === 600, 'quietShortMs default is ' + JSON.stringify(node('quietShortMs').meta?.default))
      check(node('dndStart').meta?.default === '', 'dndStart default is ' + JSON.stringify(node('dndStart').meta?.default))
      check(node('dndEnd').meta?.default === '', 'dndEnd default is ' + JSON.stringify(node('dndEnd').meta?.default))
      check(node('restMode').meta?.default === false, 'restMode default is ' + JSON.stringify(node('restMode').meta?.default))
      check(node('minRingMs').meta?.default === 3000, 'minRingMs default is ' + JSON.stringify(node('minRingMs').meta?.default))
      check(node('banner').meta?.default === true, 'banner default is ' + JSON.stringify(node('banner').meta?.default))
      check(node('bannerPlacement').type === 'union', 'bannerPlacement is not a union but ' + JSON.stringify(node('bannerPlacement').type))
      check(JSON.stringify((node('bannerPlacement').list ?? []).map(id => json.refs[id]?.value)) === JSON.stringify(EXPECTED_PLACEMENTS), 'bannerPlacement choices are wrong')
      check(node('bannerPlacement').meta?.default === 'bottom-center', 'bannerPlacement default is ' + JSON.stringify(node('bannerPlacement').meta?.default))
      console.log(JSON.stringify({
        ns: row.ns,
        applies: row.applies,
        liveVolatile: volatile,
        describedFields: fields,
        soundChoices: (node('soundDone').list ?? []).map(id => json.refs[id]?.value),
        quietChoices: (node('quietStyle').list ?? []).map(id => json.refs[id]?.value),
        placements: (node('bannerPlacement').list ?? []).map(id => json.refs[id]?.value),
        defaults: Object.fromEntries(EXPECTED_FIELDS.map(field => [field, node(field).meta?.default])),
      }, null, 2))
    }

    // The save path must accept the same fields: a non-volatile path throws
    // 'Config field "<path>" is not volatile' before any profile write.
    try {
      await forms.write('session-chime', draft => ({ ...draft, soundDone: 'marimba' }), undefined, [['soundDone']])
    } catch (error) {
      const message = String(error?.message ?? error)
      check(!/not volatile/i.test(message), 'the host refuses a live save for this row: ' + message)
    }
  }
}

rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('FAILED (' + failures.length + '): the host would not render this row on the Plugins page')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('OK: the host settings service describes a live "session-chime" namespace with all ' + EXPECTED_FIELDS.length + ' volatile fields,')
console.log('    both chime unions and the shipped defaults; a saved chime passes the volatility check on the write path.')

/** Resolve the dsh installation package.json behind the configured executable. */
function dshInstallAnchor() {
  const bin = process.env.DSH_BIN ?? 'dsh'
  const real = realpathSync(execFileSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).trim())
  for (let dir = dirname(real); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'package.json')
    if (!existsSync(candidate)) continue
    const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
    if (parsed.name === '@deepseek-ai/dsh') return candidate
  }
  throw new Error('cannot locate the dsh installation behind ' + bin)
}
