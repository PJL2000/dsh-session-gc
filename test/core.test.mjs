/**
 * Standalone check for lib/core.js — no TUI, no cordis, plain Node.
 *
 * Run with: node test/core.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  executeDelete,
  isSafeSessionId,
  listSessions,
  planDeletion,
  readPins,
  sessionsRoots,
} from '../lib/core.js'

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

/** Build a fake DSH home with sessions and a pin file. */
function fixture({ pins = [], sessions = [] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'session-gc-'))
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
  if (pins !== null) {
    writeFileSync(join(prefs, 'session-pins.json'), JSON.stringify(pins))
  }

  return {
    base,
    env: { DSH_HOME: dshHome, DSH_TUI_HOME: prefs },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

console.log('\nsession id safety')
test('accepts a uuid', () => {
  assert.equal(isSafeSessionId('0f1e2d3c-4b5a-4968-8776-655443322110'), true)
})
test('accepts session- prefixed ids', () => {
  assert.equal(isSafeSessionId('session-9b871529-d272-47d2'), true)
})
test('rejects traversal', () => {
  assert.equal(isSafeSessionId('../etc'), false)
  assert.equal(isSafeSessionId('a/b'), false)
  assert.equal(isSafeSessionId('a\\b'), false)
})
test('rejects dotted and empty names', () => {
  assert.equal(isSafeSessionId('..'), false)
  assert.equal(isSafeSessionId('.hidden'), false)
  assert.equal(isSafeSessionId(''), false)
})

console.log('\npin reading')
test('absent pin file means no pins, not an error', () => {
  const fx = fixture({ pins: null })
  const { pins, error } = readPins(fx.env)
  assert.equal(pins.size, 0)
  assert.equal(error, undefined)
  fx.cleanup()
})
test('malformed pin file reports an error instead of an empty set', () => {
  const fx = fixture()
  writeFileSync(join(fx.base, 'prefs', 'session-pins.json'), '{not json')
  const { pins, error } = readPins(fx.env)
  assert.equal(pins.size, 0)
  assert.match(error, /malformed/)
  fx.cleanup()
})
test('non-array pin file reports an error', () => {
  const fx = fixture()
  writeFileSync(join(fx.base, 'prefs', 'session-pins.json'), '{"a":1}')
  const { error } = readPins(fx.env)
  assert.match(error, /not a JSON array/)
  fx.cleanup()
})
test('ids that cannot name a directory survive as pin keys but never match', () => {
  // A pin only has to identify a session, never to be joined onto a path, so a
  // value like `../bad` is retained rather than silently dropped — dropping pin
  // entries is how a protection set collapses without anyone noticing.
  const fx = fixture({ pins: ['good-id', '../bad', 'also-good'] })
  const { pins, error } = readPins(fx.env)
  assert.equal(error, undefined)
  assert.deepEqual([...pins].sort(), ['../bad', 'also-good', 'good-id'])

  // It still never matches a listed session: the listing only accepts safe ids.
  const entries = listSessions(pins, fx.env)
  assert.equal(entries.some((entry) => entry.id === '../bad'), false)
  fx.cleanup()
})

console.log('\nlisting and planning')
test('lists every session directory with sizes and pin flags', () => {
  const fx = fixture({
    pins: ['aaa'],
    sessions: [{ id: 'aaa', bytes: 200 }, { id: 'bbb', bytes: 300 }],
  })
  const pins = readPins(fx.env).pins
  const entries = listSessions(pins, fx.env)
  assert.equal(entries.length, 2)
  const aaa = entries.find((entry) => entry.id === 'aaa')
  const bbb = entries.find((entry) => entry.id === 'bbb')
  assert.equal(aaa.pinned, true)
  assert.equal(bbb.pinned, false)
  assert.equal(aaa.bytes, 200)
  assert.equal(bbb.bytes, 300)
  fx.cleanup()
})

test('pinned sessions are kept by default', () => {
  const fx = fixture({
    pins: ['aaa'],
    sessions: [{ id: 'aaa' }, { id: 'bbb' }, { id: 'ccc' }],
  })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env })
  assert.deepEqual(plan.keep.map((entry) => entry.id), ['aaa'])
  assert.deepEqual(plan.remove.map((entry) => entry.id).sort(), ['bbb', 'ccc'])
  fx.cleanup()
})

test('includePinned moves pinned sessions into remove', () => {
  const fx = fixture({ pins: ['aaa'], sessions: [{ id: 'aaa' }, { id: 'bbb' }] })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env, includePinned: true })
  assert.equal(plan.remove.length, 2)
  fx.cleanup()
})

test('the live session is never removable', () => {
  const fx = fixture({ sessions: [{ id: 'live' }, { id: 'other' }] })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env, liveId: 'live', includePinned: true })
  assert.deepEqual(plan.remove.map((entry) => entry.id), ['other'])
  fx.cleanup()
})

console.log('\ndeletion guards')
test('deletes only the planned sessions', () => {
  const fx = fixture({
    pins: ['aaa'],
    sessions: [{ id: 'aaa' }, { id: 'bbb' }, { id: 'ccc' }],
  })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env })
  const outcomes = executeDelete(plan, { env: fx.env })
  assert.equal(outcomes.length, 2)
  assert.ok(outcomes.every((outcome) => outcome.ok))

  const remaining = listSessions(readPins(fx.env).pins, fx.env)
  assert.deepEqual(remaining.map((entry) => entry.id), ['aaa'])
  fx.cleanup()
})

test('refuses when the pin set changed after planning', () => {
  const fx = fixture({ pins: [], sessions: [{ id: 'aaa' }, { id: 'bbb' }] })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries)

  // Someone pins aaa in another window between plan and execute.
  writeFileSync(join(fx.base, 'prefs', 'session-pins.json'), JSON.stringify(['aaa']))

  assert.throws(() => executeDelete(plan, { env: fx.env }), /pin set changed/)
  const remaining = listSessions(readPins(fx.env).pins, fx.env)
  assert.equal(remaining.length, 2, 'nothing may be deleted when a guard trips')
  fx.cleanup()
})

test('refuses when a pinned session leaked into the removal list', () => {
  const fx = fixture({ pins: ['aaa'], sessions: [{ id: 'aaa' }, { id: 'bbb' }] })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env, includePinned: true })

  // Simulate the historical bug: a plan claiming no opt-in while listing a pin.
  assert.throws(() => executeDelete(plan, { env: fx.env }), /pinned session/)
  const remaining = listSessions(readPins(fx.env).pins, fx.env)
  assert.equal(remaining.length, 2)
  fx.cleanup()
})

test('refuses when the live session is in the removal list', () => {
  const fx = fixture({ sessions: [{ id: 'live' }, { id: 'other' }] })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env })
  assert.throws(
    () => executeDelete(plan, { env: fx.env, liveId: 'live' }),
    /live session/,
  )
  assert.equal(listSessions(readPins(fx.env).pins, fx.env).length, 2)
  fx.cleanup()
})

test('refuses a target outside every sessions root', () => {
  const fx = fixture({ sessions: [{ id: 'aaa' }] })
  const outside = join(fx.base, 'elsewhere')
  mkdirSync(outside, { recursive: true })

  const plan = {
    keep: [],
    remove: [{ id: 'aaa', dir: outside, bytes: 0, updatedAt: 0, pinned: false }],
    pins: [],
    liveId: undefined,
    blockages: [],
  }
  assert.throws(() => executeDelete(plan, { env: fx.env }), /not inside a sessions root/)
  fx.cleanup()
})

test('a malformed pin file blocks deletion outright', () => {
  const fx = fixture({ sessions: [{ id: 'aaa' }] })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries)
  writeFileSync(join(fx.base, 'prefs', 'session-pins.json'), 'broken')
  assert.throws(() => executeDelete(plan, { env: fx.env }), /refusing to delete/)
  fx.cleanup()
})

console.log('\nlive-session detection (default-safe)')
test('detects the live id from last-run.json when not passed explicitly', () => {
  const fx = fixture({ sessions: [{ id: 'live-one' }, { id: 'other' }] })
  writeFileSync(
    join(fx.base, 'prefs', 'last-run.json'),
    JSON.stringify({ backendId: 'dsh', sessionId: 'live-one' }),
  )
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  // No liveId argument at all — the detection must still protect it.
  const plan = planDeletion(entries, { env: fx.env })
  assert.equal(plan.liveId, 'live-one')
  assert.deepEqual(plan.keep.map((entry) => entry.id), ['live-one'])
  assert.deepEqual(plan.remove.map((entry) => entry.id), ['other'])
  fx.cleanup()
})

test('detects the live id from session-mounts.json', () => {
  const fx = fixture({ sessions: [{ id: 'mounted' }, { id: 'other' }] })
  writeFileSync(
    join(fx.base, 'prefs', 'session-mounts.json'),
    JSON.stringify({ version: 1, owners: [{ pid: 1, sessionIds: ['mounted'] }] }),
  )
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env })
  assert.equal(plan.liveId, 'mounted')
  assert.deepEqual(plan.remove.map((entry) => entry.id), ['other'])
  fx.cleanup()
})

test('executeDelete refuses the live session even when the caller forgot liveId', () => {
  const fx = fixture({ sessions: [{ id: 'live-one' }, { id: 'other' }] })
  writeFileSync(
    join(fx.base, 'prefs', 'last-run.json'),
    JSON.stringify({ sessionId: 'live-one' }),
  )
  // Build a plan that wrongly targets the live session (as the bug did).
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const badPlan = {
    keep: [],
    remove: entries,
    pins: [],
    liveId: undefined,
    blockages: [],
  }
  assert.throws(() => executeDelete(badPlan, { env: fx.env }), /live session/)
  assert.equal(listSessions(readPins(fx.env).pins, fx.env).length, 2, 'nothing may be deleted')
  fx.cleanup()
})

test('an explicit liveId can only add protection', () => {
  const fx = fixture({ sessions: [{ id: 'a' }, { id: 'b' }] })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env, liveId: 'a', includePinned: true })
  assert.deepEqual(plan.keep.map((entry) => entry.id), ['a'])
  assert.deepEqual(plan.remove.map((entry) => entry.id), ['b'])
  fx.cleanup()
})

console.log('\nroot resolution')
test('DSH_HOME sessions root is found', () => {
  const fx = fixture({ sessions: [{ id: 'aaa' }] })
  const roots = sessionsRoots(fx.env)
  assert.equal(roots.length, 1)
  assert.match(roots[0], /sessions$/)
  fx.cleanup()
})
test('a missing root contributes nothing', () => {
  const fx = fixture()
  rmSync(join(fx.base, 'dsh', 'sessions'), { recursive: true, force: true })
  assert.deepEqual(sessionsRoots(fx.env), [])
  fx.cleanup()
})

console.log('\nregressions: the five ways this plugin could still eat history')

test('an ORPHAN pin (pinned id with no directory) does not block every delete', () => {
  // planDeletion used to derive its pin snapshot from the listed entries, so a
  // pin whose session was already gone vanished from `plan.pins`. Guard 1 then
  // compared "0 pins" against the 8 in the file and refused every deletion.
  const fx = fixture({ pins: ['ghost', 'aaa'], sessions: [{ id: 'aaa' }, { id: 'bbb' }] })
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env })
  assert.deepEqual(plan.pins, ['aaa', 'ghost'], 'the orphan pin stays in the snapshot')
  assert.deepEqual(plan.remove.map((entry) => entry.id), ['bbb'])
  const outcomes = executeDelete(plan, { env: fx.env })
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1)
  fx.cleanup()
})

test('an EMPTY liveId does not suppress live-session detection', () => {
  // channel.sessionId is '' when no session is attached. Passing that through
  // as an explicit id disabled detection and deleted the live session.
  const fx = fixture({ sessions: [{ id: 'live' }, { id: 'other' }] })
  writeFileSync(join(fx.base, 'prefs', 'last-run.json'), JSON.stringify({ sessionId: 'live' }))
  const entries = listSessions(readPins(fx.env).pins, fx.env)

  const plan = planDeletion(entries, { env: fx.env, liveId: '' })
  assert.deepEqual(plan.liveIds, ['live'])
  assert.deepEqual(plan.remove.map((entry) => entry.id), ['other'])

  // And a hand-built plan that targets the live session must still be refused
  // even though the caller passed the empty string.
  const badPlan = { keep: [], remove: entries, pins: [], liveId: '', blockages: [] }
  assert.throws(
    () => executeDelete(badPlan, { env: fx.env, liveId: '' }),
    /live session/,
    'an empty liveId must not license deleting the live session',
  )
  assert.equal(listSessions(readPins(fx.env).pins, fx.env).length, 2)
  fx.cleanup()
})

test('EVERY live session is protected, not just the first one found', () => {
  // Two TUI windows each own a live session. detectLiveId returned one of them,
  // leaving the other in the removal list.
  const fx = fixture({ sessions: [{ id: 'winA' }, { id: 'winB' }, { id: 'plain' }] })
  writeFileSync(join(fx.base, 'prefs', 'last-run.json'), JSON.stringify({ sessionId: '' }))
  writeFileSync(
    join(fx.base, 'prefs', 'session-mounts.json'),
    JSON.stringify({
      version: 1,
      owners: [
        { pid: 1, startedAt: 1, sessionIds: ['winA'] },
        { pid: 2, startedAt: 2, sessionIds: ['winB'] },
      ],
    }),
  )
  const entries = listSessions(readPins(fx.env).pins, fx.env)
  const plan = planDeletion(entries, { env: fx.env })
  assert.deepEqual(plan.keep.map((entry) => entry.id).sort(), ['winA', 'winB'])
  assert.deepEqual(plan.remove.map((entry) => entry.id), ['plain'])
  fx.cleanup()
})

test('a pin file full of unusable values is an ERROR, not "nothing pinned"', () => {
  const fx = fixture()
  writeFileSync(join(fx.base, 'prefs', 'session-pins.json'), JSON.stringify([{ id: 'a' }, 42]))
  const { pins, error } = readPins(fx.env)
  assert.equal(pins.size, 0)
  assert.match(error, /no usable session ids/)
  fx.cleanup()
})

test('the same session under two roots is listed and counted once', () => {
  const fx = fixture({ pins: ['shared'], sessions: [{ id: 'shared' }, { id: 'plain' }] })
  const alt = join(fx.base, 'alt')
  mkdirSync(join(alt, '--test--', 'shared'), { recursive: true })
  mkdirSync(join(alt, '--test--', 'plain'), { recursive: true })
  const env = { ...fx.env, DSH_TUI_SESSION_ROOT: alt }

  const entries = listSessions(readPins(env).pins, env)
  assert.deepEqual(entries.map((entry) => entry.id).sort(), ['plain', 'shared'])

  // A duplicated pin snapshot is what tripped Guard 1 forever.
  const plan = planDeletion(entries, { env })
  assert.deepEqual(plan.pins, ['shared'])
  assert.deepEqual(plan.remove.map((entry) => entry.id), ['plain'])
  fx.cleanup()
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
