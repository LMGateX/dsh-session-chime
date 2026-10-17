#!/usr/bin/env node
/**
 * Manual micro-benchmark for the browser half's event-driven paths.
 *
 * It loads the served bundle exactly the way the shell does and drives the
 * exported watcher with a synthetic mixed catalog: three quarters top-level
 * sessions, one quarter subagent rows, and one in four top-level rows carrying a
 * three-entry `subagentCatalog` projection. It measures two things:
 *
 *   1. one catalog pass (`update`), which runs for every notification;
 *   2. one settle check right after a catalog swap, which is when the lazy
 *      child index is built. The 100-settle row shows several checks sharing
 *      one index because the catalog snapshot did not change between them.
 *
 * This is not part of `npm run check`: timings are machine-dependent, and the
 * point is only to keep the order of magnitude honest. Run `npm run build`
 * first; then `node scripts/bench-watcher.mjs`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8')

let entry
Reflect.set(globalThis, 'window', {
  __ModuleLoader__: {
    load(registration) {
      entry = registration
    },
  },
  addEventListener() {},
  removeEventListener() {},
})
vm.runInThisContext(source)
const react = {
  createElement: () => ({}),
  useState: initial => [initial(), () => {}],
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, read) => read(),
}
const client = entry.factory(name => {
  if (name === 'react') return react
  throw new Error('unexpected require: ' + name)
})

/**
 * Mixed synthetic catalog: top-level rows, subagent rows, and child projections.
 * `runningTop` seeds the first N top-level rows as running so a later swap to
 * idle schedules N settle checks.
 */
function catalog(n, live, runningTop = 1) {
  const ids = []
  const byId = {}
  const children = Math.floor(n / 4)
  const top = n - children
  for (let i = 0; i < top; i++) {
    const id = i === 0 ? 's' : 's' + i
    ids.push(id)
    const catalogIds = i % 4 === 0
      ? Array.from({ length: 3 }, (_, k) => 'c' + ((i * 3 + k) % children))
      : undefined
    byId[id] = {
      id,
      displayTitle: 'session ' + i,
      running: live && i < runningTop,
      ...(catalogIds === undefined ? {} : { projectionValues: { subagentCatalog: catalogIds.map(cid => ({ id: cid, createdAt: 0 })) } }),
    }
  }
  for (let i = 0; i < children; i++) {
    const id = 'c' + i
    ids.push(id)
    byId[id] = {
      id,
      displayTitle: 'child ' + i,
      running: live && i === 0,
      parentId: 's',
      origin: 'subagent',
      projectionValues: { subagentCatalog: [] },
    }
  }
  return { ids, byId }
}

/** Deterministic timer list, so the settle check runs synchronously. */
function clock() {
  let now = 1_000_000
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimer(callback, ms) {
      seq += 1
      timers.set(seq, { at: now + ms, callback })
      return seq
    },
    clearTimer(handle) {
      timers.delete(handle)
    },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
  }
}

function watcherFor(timer) {
  return client.createWatcher({
    now: timer.now,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    readSettings: () => ({ enabled: true, debounceMs: 1500 }),
    ring: () => {},
  })
}

const percentile = (samples, p) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length * p)]

/** One catalog pass: the per-notification cost. */
function passP50(n) {
  const watcher = watcherFor(clock())
  const snapshot = catalog(n, false)
  watcher.update(snapshot)
  for (let i = 0; i < 10; i++) watcher.update(snapshot)
  const samples = []
  for (let i = 0; i < 150; i++) {
    // A fresh snapshot object per pass, like the catalog notifier's rebuild.
    const next = { ids: snapshot.ids, byId: snapshot.byId }
    const start = performance.now()
    watcher.update(next)
    samples.push(performance.now() - start)
  }
  return percentile(samples, 0.5)
}

/** One settle check after a catalog swap: builds the child index once. */
function checkP50(n, settles) {
  const samples = []
  for (let run = 0; run < (settles === 1 ? 100 : 30); run++) {
    const timer = clock()
    const watcher = watcherFor(timer)
    const busy = catalog(n, true, settles)
    watcher.update(busy)
    const idle = catalog(n, false, settles)
    watcher.update(idle)
    const start = performance.now()
    timer.advance(1500)
    samples.push(performance.now() - start)
  }
  return percentile(samples, 0.5)
}

const rows = (n) => String(n).padStart(5)
console.log('rows   pass p50   1-settle check   100-settle total')
for (const n of [500, 1000, 2000]) {
  const total = checkP50(n, 100)
  console.log(
    rows(n),
    (passP50(n).toFixed(3) + ' ms').padStart(10),
    (checkP50(n, 1).toFixed(3) + ' ms').padStart(14),
    (total.toFixed(3) + ' ms').padStart(16),
  )
}
