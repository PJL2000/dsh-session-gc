/**
 * End-to-end guard drill against a disposable fixture.
 *
 * Creates its own throwaway store per case, so it never touches the real one.
 * Each case attacks one guard the way a bug (or a careless caller) would, and
 * asserts that nothing was deleted.
 *
 * Run with: node test/guard-drill.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { executeDelete, listSessions, planDeletion, readPins } from '../lib/core.js'

let passed = 0
let failed = 0

function check(name, fn) {
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

function fixture({ pins = [], sessions = [], liveId } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'drill-'))
  assert.ok(resolve(base).startsWith(resolve(tmpdir())), 'fixture must live in temp')
  const dshHome = join(base, 'dsh')
  const workspace = join(dshHome, 'sessions', '--drill--')
  mkdirSync(workspace, { recursive: true })
  for (const session of sessions) {
    const dir = join(workspace, session.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x'.repeat(session.bytes ?? 64))
  }
  const prefs = join(base, 'prefs')
  mkdirSync(prefs, { recursive: true })
  writeFileSync(join(prefs, 'session-pins.json'), JSON.stringify(pins))
  if (liveId !== undefined) {
    writeFileSync(join(prefs, 'last-run.json'), JSON.stringify({ sessionId: liveId }))
  }
  return {
    base,
    env: { DSH_HOME: dshHome, DSH_TUI_HOME: prefs, DSH_TUI_SESSION_ROOT: '' },
    workspace,
    count: () => readdirSync(workspace).length,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

console.log('\ndrill: the four guards, attacked on purpose')

check('normal pass deletes only the unpinned', () => {
  const fx = fixture({
    pins: ['pin1'],
    sessions: [{ id: 'pin1' }, { id: 'plain1' }, { id: 'plain2' }],
  })
  try {
    const entries = listSessions(readPins(fx.env).pins, fx.env)
    const plan = planDeletion(entries, { env: fx.env })
    const outcomes = executeDelete(plan, { env: fx.env })
    assert.equal(outcomes.filter(o => o.ok).length, 2)
    assert.equal(fx.count(), 1, 'only the pinned session may remain')
  } finally {
    fx.cleanup()
  }
})

check('ATTACK: forget liveId -> live session still protected', () => {
  const fx = fixture({
    sessions: [{ id: 'live1' }, { id: 'plain1' }],
    liveId: 'live1',
  })
  try {
    const entries = listSessions(readPins(fx.env).pins, fx.env)
    // The caller omits liveId entirely — the old failure mode.
    const plan = planDeletion(entries, { env: fx.env })
    assert.equal(plan.liveId, 'live1', 'detection must fill the gap')
    executeDelete(plan, { env: fx.env })
    assert.equal(fx.count(), 1, 'the live session must survive')
  } finally {
    fx.cleanup()
  }
})

check('ATTACK: hand-build a plan that targets the live session', () => {
  const fx = fixture({ sessions: [{ id: 'live1' }, { id: 'plain1' }], liveId: 'live1' })
  try {
    const entries = listSessions(readPins(fx.env).pins, fx.env)
    const evilPlan = { keep: [], remove: entries, pins: [], liveId: undefined, blockages: [] }
    assert.throws(() => executeDelete(evilPlan, { env: fx.env }), /live session/)
    assert.equal(fx.count(), 2, 'nothing may be deleted')
  } finally {
    fx.cleanup()
  }
})

check('ATTACK: hand-build a plan that targets a pinned session', () => {
  const fx = fixture({ pins: ['pin1'], sessions: [{ id: 'pin1' }, { id: 'plain1' }] })
  try {
    const entries = listSessions(readPins(fx.env).pins, fx.env)
    const evilPlan = {
      keep: [],
      remove: entries.filter(e => e.id === 'pin1'),
      pins: ['pin1'],
      liveId: undefined,
      blockages: [],
    }
    assert.throws(() => executeDelete(evilPlan, { env: fx.env }), /pinned session/)
    assert.equal(fx.count(), 2)
  } finally {
    fx.cleanup()
  }
})

check('ATTACK: pin something in another window between plan and delete', () => {
  const fx = fixture({ sessions: [{ id: 'plain1' }, { id: 'plain2' }] })
  try {
    const entries = listSessions(readPins(fx.env).pins, fx.env)
    const plan = planDeletion(entries, { env: fx.env })
    // Another window pins plain1 now.
    writeFileSync(join(fx.env.DSH_TUI_HOME, 'session-pins.json'), JSON.stringify(['plain1']))
    assert.throws(() => executeDelete(plan, { env: fx.env }), /pin set changed/)
    assert.equal(fx.count(), 2, 'a stale plan must delete nothing')
  } finally {
    fx.cleanup()
  }
})

check('ATTACK: corrupt the pin file right before deleting', () => {
  const fx = fixture({ pins: ['pin1'], sessions: [{ id: 'pin1' }, { id: 'plain1' }] })
  try {
    const entries = listSessions(readPins(fx.env).pins, fx.env)
    const plan = planDeletion(entries, { env: fx.env })
    writeFileSync(join(fx.env.DSH_TUI_HOME, 'session-pins.json'), '{oops')
    assert.throws(() => executeDelete(plan, { env: fx.env }), /refusing to delete/)
    assert.equal(fx.count(), 2)
  } finally {
    fx.cleanup()
  }
})

check('ATTACK: point a target outside the sessions root', () => {
  const fx = fixture({ sessions: [{ id: 'plain1' }] })
  try {
    const outsideDir = join(fx.base, 'not-a-session')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'precious.txt'), 'do not delete me')

    const evilPlan = {
      keep: [],
      remove: [{ id: 'plain1', dir: outsideDir, bytes: 1, updatedAt: 1, pinned: false }],
      pins: [],
      liveId: undefined,
      blockages: [],
    }
    assert.throws(() => executeDelete(evilPlan, { env: fx.env }), /not inside a sessions root/)
    assert.equal(readdirSync(outsideDir).length, 1, 'the outside file must survive')
  } finally {
    fx.cleanup()
  }
})

check('ATTACK: an unsafe session id', () => {
  const fx = fixture({ sessions: [{ id: 'plain1' }] })
  try {
    const evilPlan = {
      keep: [],
      remove: [{ id: '..', dir: join(fx.workspace, '..'), bytes: 1, updatedAt: 1, pinned: false }],
      pins: [],
      liveId: undefined,
      blockages: [],
    }
    assert.throws(() => executeDelete(evilPlan, { env: fx.env }), /unsafe session id|not inside/)
    assert.equal(fx.count(), 1)
  } finally {
    fx.cleanup()
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
