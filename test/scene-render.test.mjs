/**
 * Scene rendering test — drives the real component with a miniature renderer.
 *
 * No TUI process is involved. The stand-in implements enough of React to be
 * honest about the component's behaviour: state setters actually update state,
 * memoized hooks actually memoize, effects actually run, and the tree
 * re-renders until it settles. A no-op `useEffect` would have left every scene
 * stuck on "scanning…" and proved nothing.
 *
 * Run with: node test/scene-render.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createScene } from '../lib/scene.js'

const STAR = '\u2605' // the pinned-row marker

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

/**
 * A miniature renderer: real state, memoized hooks, real effects.
 *
 * Deliberately not a general React implementation — it supports exactly the
 * hooks the scene uses and models their memoization honestly. That matters: a
 * `useCallback` returning a fresh function every pass would make the scene's
 * `useEffect(…, [rescan])` re-fire forever, which would be a defect in the
 * stand-in rather than in the component.
 */
function createMiniRenderer() {
  const slots = []
  let hookIndex = 0
  let dirty = false
  let pendingEffects = []
  const cleanups = []

  const depsEqual = (a, b) => {
    if (a === undefined || b === undefined) return false
    if (a.length !== b.length) return false
    return a.every((value, index) => Object.is(value, b[index]))
  }

  const memoHook = (index, compute, deps) => {
    const slot = slots[index]
    if (slot !== undefined && depsEqual(slot.deps, deps)) return slot.value
    const value = compute()
    slots[index] = { value, deps }
    return value
  }

  const React = {
    useState(initial) {
      const index = hookIndex++
      if (slots[index] === undefined) {
        slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const setter = next => {
        const value = typeof next === 'function' ? next(slots[index].value) : next
        if (!Object.is(value, slots[index].value)) {
          slots[index].value = value
          dirty = true
        }
      }
      return [slots[index].value, setter]
    },
    useMemo: (fn, deps) => memoHook(hookIndex++, fn, deps),
    useCallback: (fn, deps) => memoHook(hookIndex++, () => fn, deps),
    useEffect: (fn, deps) => {
      const index = hookIndex++
      const slot = slots[index]
      if (slot !== undefined && depsEqual(slot.deps, deps)) return
      slots[index] = { deps }
      pendingEffects.push(fn)
    },
    createElement: (type, props, ...children) => ({
      type,
      props: { ...props, children: children.length === 0 ? undefined : children },
    }),
  }

  /**
   * Render until no setter fires during a pass, running queued effects after
   * each pass. Bounded so a component that loops forever fails the test rather
   * than hanging the suite.
   */
  const render = (Component, props) => {
    let element
    for (let pass = 0; pass < 12; pass += 1) {
      hookIndex = 0
      dirty = false
      pendingEffects = []
      element = Component(props)

      const effects = pendingEffects
      pendingEffects = []
      for (const effect of effects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }

      if (!dirty) return element
    }
    throw new Error('component did not settle within 12 render passes')
  }

  return { React, render, dispose: () => cleanups.forEach(fn => fn()) }
}

/** Collect every rendered Text node's string content, depth-first. */
function textsOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) {
    const children = node.props.children
    if (typeof children === 'string') out.push(children)
    else textsOf(children, out)
  }
  return out
}

/** Build a fake DSH home with sessions and pins. */
function fixture({ pins = [], sessions = [], liveId, rawPins } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'scene-gc-'))
  const dshHome = join(base, 'dsh')
  const workspace = join(dshHome, 'sessions', '--test--')
  mkdirSync(workspace, { recursive: true })
  for (const session of sessions) {
    const dir = join(workspace, session.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(session.bytes ?? 100))
  }
  const prefs = join(base, 'prefs')
  mkdirSync(prefs, { recursive: true })
  writeFileSync(join(prefs, 'session-pins.json'), rawPins ?? JSON.stringify(pins))
  if (liveId !== undefined) {
    writeFileSync(join(prefs, 'last-run.json'), JSON.stringify({ sessionId: liveId }))
  }
  return {
    env: { DSH_HOME: dshHome, DSH_TUI_HOME: prefs },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

/** Point process.env at the fixture for the duration of one test. */
function applyEnv(env) {
  const saved = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  return () => {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/** A scene harness: one mini-renderer, a capturable useInput, one component. */
function harness(size = { columns: 100, rows: 40 }) {
  const mini = createMiniRenderer()
  const captured = { handler: undefined }
  const ui = {
    Box: 'Box',
    Text: 'Text',
    useTerminalSize: () => size,
    useInput: handler => {
      captured.handler = handler
    },
  }
  const Component = createScene(mini.React, ui)
  return {
    captured,
    render: props => mini.render(Component, props),
    press: (input, key = {}) => captured.handler(input, key),
  }
}

console.log('\nterminal size handling')
test('reads columns/rows from the object shape', () => {
  const fx = fixture({ sessions: [{ id: 'aaa' }] })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    const texts = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.match(texts, /1 session/, 'the header must report the session count')
  } finally {
    restore()
    fx.cleanup()
  }
})

test('throws a clear error when the size shape is wrong', () => {
  const fx = fixture({ sessions: [{ id: 'aaa' }] })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness([100, 40]) // the historical array mistake
    assert.throws(
      () => scene.render({ close: () => {}, channel: {} }),
      /did not return \{ columns, rows \}/,
    )
  } finally {
    restore()
    fx.cleanup()
  }
})

console.log('\nrendering')
test('an empty store renders the empty state, not "scanning"', () => {
  const fx = fixture({ sessions: [] })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    const texts = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.match(texts, /no sessions found/)
    assert.doesNotMatch(texts, /scanning/)
  } finally {
    restore()
    fx.cleanup()
  }
})

test('scanned sessions appear as rows', () => {
  const fx = fixture({ sessions: [{ id: 'aaaa1111' }, { id: 'bbbb2222' }] })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    const texts = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.match(texts, /aaaa1111/)
    assert.match(texts, /bbbb2222/)
    assert.match(texts, /2 session/)
  } finally {
    restore()
    fx.cleanup()
  }
})

test('pinned rows show a star and the live row is labelled', () => {
  const fx = fixture({
    pins: ['pinned-one'],
    sessions: [{ id: 'pinned-one' }, { id: 'live-one' }],
    liveId: 'live-one',
  })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    const texts = textsOf(scene.render({ close: () => {}, channel: { sessionId: 'live-one' } })).join('\n')
    assert.ok(texts.includes(STAR), 'a pinned row must show the star')
    assert.match(texts, /live/, 'the live row must be labelled')
    assert.match(texts, /pinned sessions are protected/)
    assert.match(texts, /1 pinned/)
  } finally {
    restore()
    fx.cleanup()
  }
})

test('a pin file it cannot read is reported and lists nothing', () => {
  const fx = fixture({ sessions: [{ id: 'aaa' }], rawPins: 'not json' })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    const texts = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.match(texts, /malformed/)
    assert.doesNotMatch(texts, /aaa/)
  } finally {
    restore()
    fx.cleanup()
  }
})

console.log('\nselection and confirmation')
test('Space marks a deletable row and the footer counts it', () => {
  const fx = fixture({ sessions: [{ id: 'aaaa1111' }, { id: 'bbbb2222' }] })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    scene.render({ close: () => {}, channel: {} })
    scene.press(' ')
    const texts = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.match(texts, /marked 1/, `expected a marked row, got: ${texts}`)
  } finally {
    restore()
    fx.cleanup()
  }
})

test('Space on the live row is refused', () => {
  const fx = fixture({ pins: [], sessions: [{ id: 'live-one' }], liveId: 'live-one' })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    scene.render({ close: () => {}, channel: { sessionId: 'live-one' } })
    scene.press(' ')
    const texts = textsOf(scene.render({ close: () => {}, channel: { sessionId: 'live-one' } })).join('\n')
    assert.match(texts, /will delete 0/, 'the live row must never become deletable')
  } finally {
    restore()
    fx.cleanup()
  }
})

test('Space on a pinned row is refused unless pinned mode is on', () => {
  const fx = fixture({ pins: ['pinned-one'], sessions: [{ id: 'pinned-one' }] })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    scene.render({ close: () => {}, channel: {} })
    scene.press(' ')
    const texts = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.match(texts, /pinned/, 'the refusal must be explained')
    assert.doesNotMatch(texts, /marked 1/)
  } finally {
    restore()
    fx.cleanup()
  }
})

test('d with nothing marked is refused and says so', () => {
  const fx = fixture({ sessions: [{ id: 'aaa' }] })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    scene.render({ close: () => {}, channel: {} })
    scene.press('d')
    const texts = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.match(texts, /nothing marked/)
  } finally {
    restore()
    fx.cleanup()
  }
})

test('a delete confirmation owns the keyboard', () => {
  const fx = fixture({ sessions: [{ id: 'aaaa1111' }] })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    scene.render({ close: () => {}, channel: {} })
    scene.press(' ')
    scene.render({ close: () => {}, channel: {} })
    scene.press('d')
    const pendingText = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.match(pendingText, /cannot be undone/)
    // Anything but y/n is ignored while the confirmation is pending.
    scene.press(' ')
    const after = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.match(after, /cannot be undone/, 'the confirmation must survive an unrelated keypress')
  } finally {
    restore()
    fx.cleanup()
  }
})

test('answering n cancels the pending delete', () => {
  const fx = fixture({ sessions: [{ id: 'aaaa1111' }] })
  const restore = applyEnv(fx.env)
  try {
    const scene = harness()
    scene.render({ close: () => {}, channel: {} })
    scene.press(' ')
    scene.render({ close: () => {}, channel: {} })
    scene.press('d')
    scene.render({ close: () => {}, channel: {} })
    scene.press('n')
    const texts = textsOf(scene.render({ close: () => {}, channel: {} })).join('\n')
    assert.doesNotMatch(texts, /cannot be undone/)
    assert.match(texts, /aaaa1111/, 'cancelling must leave the session listed')
  } finally {
    restore()
    fx.cleanup()
  }
})

test('q closes the scene', () => {
  const fx = fixture({ sessions: [] })
  const restore = applyEnv(fx.env)
  try {
    let closed = false
    const scene = harness()
    scene.render({ close: () => { closed = true }, channel: {} })
    scene.press('q')
    assert.equal(closed, true)
  } finally {
    restore()
    fx.cleanup()
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
