/**
 * Build a disposable fake session store for manual UI testing.
 *
 * Writes ONLY under a temp directory and prints the environment variables that
 * point at it. Nothing here touches the real session store: every path is
 * derived from a fresh mkdtemp, and the script refuses to run if the resolved
 * fixture path is not inside the system temp directory.
 *
 * Usage:
 *   node test/fixtures/make-fixtures.mjs          # create and print env
 *   node test/fixtures/make-fixtures.mjs --clean  # remove a previous fixture
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const POINTER = join(tmpdir(), 'session-gc-fixture-path.txt')

/** Refuse to write anywhere that is not under the system temp directory. */
function assertInTemp(path) {
  const real = resolve(path)
  const realTemp = resolve(tmpdir())
  if (!real.startsWith(realTemp)) {
    throw new Error(`refusing to write outside the temp directory: ${real}`)
  }
}

/** A plausible session log: enough bytes to make sizes interesting. */
function fakeLog(bytes) {
  const lines = []
  let used = 0
  let seq = 0
  while (used < bytes) {
    const line = JSON.stringify({
      seq: seq++,
      type: 'assistant/message',
      text: 'lorem ipsum dolor sit amet '.repeat(4),
    })
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

/** One session directory. */
function writeSession(workspaceDir, { id, bytes, minutesAgo }) {
  const dir = join(workspaceDir, id)
  mkdirSync(dir, { recursive: true })
  const log = fakeLog(bytes)
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, log)
  // Age the mtime so the list ordering is visible and stable.
  const when = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(file, when, when)
  return dir
}

const clean = process.argv.includes('--clean')

if (clean) {
  if (!existsSync(POINTER)) {
    console.log('no fixture recorded — nothing to clean')
    process.exit(0)
  }
  const recorded = readFileSync(POINTER, 'utf8').trim()
  assertInTemp(recorded)
  rmSync(recorded, { recursive: true, force: true })
  rmSync(POINTER, { force: true })
  console.log(`removed fixture: ${recorded}`)
  process.exit(0)
}

const base = mkdtempSync(join(tmpdir(), 'session-gc-fixture-'))
assertInTemp(base)

const dshHome = join(base, 'dsh')
const prefs = join(base, 'prefs')
const workspaceA = join(dshHome, 'sessions', '--C-Users-demo--')
const workspaceB = join(dshHome, 'sessions', '--D-projects-demo--')
mkdirSync(workspaceA, { recursive: true })
mkdirSync(workspaceB, { recursive: true })
mkdirSync(prefs, { recursive: true })

/**
 * A deliberate spread: a few pinned, a few plain, one very old, one tiny, and
 * one that must be recognised as the live session.
 */
const LIVE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const sessions = [
  { id: LIVE_ID, bytes: 4000, minutesAgo: 0 },
  { id: 'b1b1b1b1-1111-4111-8111-000000000002', bytes: 180_000, minutesAgo: 30 },
  { id: 'c2c2c2c2-2222-4222-8222-000000000003', bytes: 640_000, minutesAgo: 120 },
  { id: 'd3d3d3d3-3333-4333-8333-000000000004', bytes: 60_000, minutesAgo: 60 * 26 },
  { id: 'e4e4e4e4-4444-4444-8444-000000000005', bytes: 1_500_000, minutesAgo: 60 * 24 * 9 },
  { id: 'f5f5f5f5-5555-4555-8555-000000000006', bytes: 900, minutesAgo: 5 },
  { id: 'a6a6a6a6-6666-4666-8666-000000000007', bytes: 420_000, minutesAgo: 60 * 24 * 40 },
  { id: 'b7b7b7b7-7777-4777-8777-000000000008', bytes: 250_000, minutesAgo: 60 * 24 * 3 },
]

for (const session of sessions) {
  writeSession(workspaceA, session)
}

// A second workspace, so the "several roots" case is visible too.
writeSession(workspaceB, { id: 'c8c8c8c8-8888-4888-8888-000000000009', bytes: 75_000, minutesAgo: 200 })
writeSession(workspaceB, { id: 'd9d9d9d9-9999-4999-8999-00000000000a', bytes: 31_000, minutesAgo: 60 * 24 * 15 })

/** Pinned: two of the eight in workspace A, none in workspace B. */
const pins = [
  'c2c2c2c2-2222-4222-8222-000000000003',
  'e4e4e4e4-4444-4444-8444-000000000005',
]
writeFileSync(join(prefs, 'session-pins.json'), JSON.stringify(pins, null, 2))

/** Mark the live session the way the TUI does. */
writeFileSync(join(prefs, 'last-run.json'), JSON.stringify({ backendId: 'dsh', sessionId: LIVE_ID }))
writeFileSync(
  join(prefs, 'session-mounts.json'),
  JSON.stringify({ version: 1, owners: [{ pid: process.pid, startedAt: Date.now(), sessionIds: [LIVE_ID] }] }),
)

writeFileSync(POINTER, base)

console.log(`
Fake session store created.

  fixture root : ${base}
  sessions     : ${sessions.length + 2}  (2 pinned, 1 live)
  pinned       : ${pins.length}

To drive the real plugin against it, set these for the dsh-tui process:

  $env:DSH_HOME='${dshHome}'
  $env:DSH_TUI_HOME='${prefs}'

Or run the read-only report against it right now:

  $env:DSH_HOME='${dshHome}'; $env:DSH_TUI_HOME='${prefs}'; node test/inspect-real.mjs

Clean up when done:

  node test/fixtures/make-fixtures.mjs --clean
`)
