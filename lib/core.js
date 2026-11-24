/**
 * Session discovery and guarded deletion — the whole non-UI half of dsh-session-gc.
 *
 * Deliberately free of React, cordis, and any dsh-tui import: everything here
 * runs in plain Node so it can be unit-tested and reasoned about without a
 * running TUI. The scene component is a thin shell over these functions.
 *
 * Safety model (the reason this module exists at all):
 *
 *   - Pinned sessions are protected by a SEPARATE, independently-read pin set.
 *     The protection list is never derived from the delete list, so a parsing
 *     or filtering bug cannot widen it. (The incident that motivated this
 *     plugin was exactly that: a protection list that silently collapsed to
 *     empty.)
 *   - Every plan is computed and reported BEFORE anything is removed, and
 *     `executeDelete` refuses a plan whose pin snapshot no longer matches the
 *     pin file it was built from.
 *   - Deletion is per-session and reports each outcome; a failure mid-run does
 *     not silently skip the rest without saying so.
 *
 * Two invariants are load-bearing and easy to break, so they are stated here:
 *
 *   1. A pin is a PROTECTION KEY, not a path. Protection therefore uses a
 *      looser test (`isPinKey`) than directory work (`isSafeSessionId`). An id
 *      that cannot name a directory can still be a pin: it simply never matches
 *      a listed session. Dropping it instead would shrink the protection set
 *      silently — the exact bug class this plugin exists to prevent.
 *   2. "No value" and "the empty value" are different. `channel.sessionId` is
 *      `''` when the TUI has no attached session (it writes `sessionId: ""` to
 *      last-run.json). Treating `''` as an explicit live id disables detection
 *      and lets the live session be deleted.
 */

import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

/** A session id is usable as a directory name only when it is one plain segment. */
export function isSafeSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)
}

/**
 * A pin key is any non-empty string.
 *
 * Intentionally looser than `isSafeSessionId`: a pin only has to identify a
 * session, never to be joined onto a path.
 */
export function isPinKey(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Every sessions root this install may have written to, in probe order.
 *
 * Mirrors the TUI's own resolution (`DSH_TUI_SESSION_ROOT`, then
 * `$DSH_HOME/sessions`, then `~/.dsh-tui/sessions`) so this plugin lists the
 * same tree the picker lists. Roots that do not exist are dropped, and roots
 * that resolve to the same real directory are collapsed — otherwise one session
 * would be listed (and counted) twice.
 */
export function sessionsRoots(env = process.env) {
  const roots = []
  const override = env['DSH_TUI_SESSION_ROOT']
  if (override !== undefined && override.trim().length > 0) roots.push(override)
  const dshHome = env['DSH_HOME']
  roots.push(join(dshHome !== undefined && dshHome.trim().length > 0 ? dshHome : join(homedir(), '.dsh'), 'sessions'))
  roots.push(join(homedir(), '.dsh-tui', 'sessions'))

  const unique = []
  const seen = new Set()
  for (const root of new Set(roots)) {
    let real
    try {
      if (!statSync(root).isDirectory()) continue
      real = realpathSync(root)
    } catch {
      // A root that is absent or unreadable simply contributes nothing.
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    unique.push(root)
  }
  return unique
}

/** The prefs directory holding session-pins.json. */
export function prefsDir(env = process.env) {
  const home = env['DSH_TUI_HOME']
  return home !== undefined && home.trim().length > 0 ? home : join(homedir(), '.dsh-tui')
}

/**
 * Read the persisted pin set.
 *
 * Kept independent of the listing on purpose: if this file is unreadable,
 * malformed, or full of values that are not ids, the caller learns that (via
 * `error`) instead of receiving an empty set that would silently unprotect
 * everything.
 *
 * @returns {{ pins: Set<string>, file: string, error?: string }}
 */
export function readPins(env = process.env) {
  const file = join(prefsDir(env), 'session-pins.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // Absent is not the same as broken: a fresh install has no pins at all.
    const code = error && error.code
    if (code === 'ENOENT') return { pins: new Set(), file }
    return { pins: new Set(), file, error: `cannot read ${file}: ${String(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { pins: new Set(), file, error: `malformed ${file}: ${String(error)}` }
  }
  if (!Array.isArray(parsed)) {
    return { pins: new Set(), file, error: `${file} is not a JSON array of session ids` }
  }
  const pins = new Set()
  for (const value of parsed) {
    if (isPinKey(value)) pins.add(value)
  }
  // A non-empty array that yields no keys is corruption, not "no pins". Saying
  // so is the whole point: an empty set here would read as "nothing is pinned".
  if (pins.size === 0 && parsed.length > 0) {
    return {
      pins,
      file,
      error: `${file} contains no usable session ids (${parsed.length} unusable entries)`,
    }
  }
  return { pins, file }
}

/** Sum every regular file under a directory, and take the newest mtime. */
function measure(dir) {
  let bytes = 0
  let updatedAt = 0
  const seen = new Set()
  const walk = (current) => {
    let real
    try {
      real = realpathSync(current)
    } catch {
      return
    }
    // A symlinked cycle would otherwise recurse until the stack dies.
    if (seen.has(real)) return
    seen.add(real)
    let names
    try {
      names = readdirSync(current)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(current, name)
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) walk(full)
      else {
        bytes += stats.size
        if (stats.mtimeMs > updatedAt) updatedAt = stats.mtimeMs
      }
    }
  }
  walk(dir)
  if (updatedAt === 0) {
    try {
      updatedAt = statSync(dir).mtimeMs
    } catch {
      // An unreadable directory reports 0 rather than inventing a time.
    }
  }
  return { bytes, updatedAt }
}

/**
 * List every session directory under every root.
 *
 * The listing is a plain directory walk: no session log is parsed and no title
 * is derived, so this cannot fail on a corrupt log. Titles stay the UI's job —
 * this module reports structure and the pin fact, nothing interpretive.
 *
 * An id is reported once even when several roots contain it: a plan that named
 * the same id twice would produce a duplicated pin snapshot and trip the
 * pin-set guard forever.
 *
 * @returns {Array<{ id: string, dir: string, bytes: number, updatedAt: number, pinned: boolean }>}
 */
export function listSessions(pins, env = process.env) {
  const entries = []
  const seenIds = new Set()
  for (const root of sessionsRoots(env)) {
    let workspaces
    try {
      workspaces = readdirSync(root)
    } catch {
      continue
    }
    for (const workspace of workspaces) {
      const workspaceDir = join(root, workspace)
      let ids
      try {
        if (!statSync(workspaceDir).isDirectory()) continue
        ids = readdirSync(workspaceDir)
      } catch {
        continue
      }
      for (const id of ids) {
        if (!isSafeSessionId(id)) continue
        if (seenIds.has(id)) continue
        const dir = join(workspaceDir, id)
        try {
          if (!statSync(dir).isDirectory()) continue
        } catch {
          continue
        }
        seenIds.add(id)
        const { bytes, updatedAt } = measure(dir)
        entries.push({ id, dir, bytes, updatedAt, pinned: pins.has(id) })
      }
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  return entries
}

/**
 * Every session id this process may currently be attached to.
 *
 * Read from the same `last-run.json` / `session-mounts.json` the TUI writes, so
 * live sessions stay protected even when a caller forgets to pass one. Two
 * separate windows can each own a live session, so this returns a SET: the old
 * single-id form protected whichever happened to be found first and left every
 * other live session deletable.
 *
 * @returns {Set<string>} the live ids this install recorded (possibly empty).
 */
export function detectLiveIds(env = process.env) {
  const dir = prefsDir(env)
  const ids = new Set()

  let lastRun
  try {
    lastRun = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'))
  } catch {
    lastRun = undefined
  }
  if (lastRun !== null && typeof lastRun === 'object') {
    const id = lastRun['sessionId']
    // The TUI writes `sessionId: ""` when it has none. That is not an id.
    if (isSafeSessionId(id)) ids.add(id)
  }

  let mounts
  try {
    mounts = JSON.parse(readFileSync(join(dir, 'session-mounts.json'), 'utf8'))
  } catch {
    mounts = undefined
  }
  if (mounts !== null && typeof mounts === 'object' && Array.isArray(mounts['owners'])) {
    for (const owner of mounts['owners']) {
      if (owner === null || typeof owner !== 'object') continue
      const owned = owner['sessionIds']
      if (!Array.isArray(owned)) continue
      for (const id of owned) {
        if (isSafeSessionId(id)) ids.add(id)
      }
    }
  }
  return ids
}

/** The single live id this install recorded, when it recorded exactly one. */
export function detectLiveId(env = process.env) {
  for (const id of detectLiveIds(env)) return id
  return undefined
}

/**
 * The full protection set for live sessions.
 *
 * An explicit id can only ADD protection, never remove it — and an empty string
 * counts as "no argument", not as "the empty session id". `''` used to suppress
 * detection entirely, which put the live session in the removal list.
 */
function resolveLiveIds(options) {
  const ids = new Set()
  const explicit = options.liveId
  if (isSafeSessionId(explicit)) ids.add(explicit)
  for (const id of detectLiveIds(options.env ?? process.env)) ids.add(id)
  return ids
}

/**
 * Compute what a pass would keep and remove.
 *
 * `includePinned` is the only way a pinned session can enter `remove`, and it
 * is off by default. Live sessions are excluded unconditionally: deleting the
 * conversation you are typing into would take the transcript out from under the
 * running process.
 *
 * `options.pins` is the pin snapshot to guard against. It defaults to the pin
 * file itself — never to "the pins among the listed entries", because an orphan
 * pin (pinned id with no directory) is still protection and the delete guard
 * compares against the whole file.
 *
 * @returns {{ keep: Array, remove: Array, pins: string[], liveId: string|undefined, liveIds: string[], blockages: string[] }}
 */
export function planDeletion(entries, options = {}) {
  const includePinned = options.includePinned === true
  const env = options.env ?? process.env
  const liveIds = resolveLiveIds({ ...options, env })
  const pins = options.pins !== undefined ? new Set(options.pins) : readPins(env).pins

  const keep = []
  const remove = []
  const liveSeen = []

  for (const entry of entries) {
    // Re-derive the pin fact from the snapshot this plan will be guarded by, so
    // a stale listing cannot disagree with the plan about what is protected.
    const pinned = pins.has(entry.id)
    if (liveIds.has(entry.id)) {
      liveSeen.push(entry.id)
      keep.push(entry)
      continue
    }
    if (pinned && !includePinned) keep.push(entry)
    else remove.push(entry)
  }

  return {
    keep,
    remove,
    pins: [...pins].sort(),
    // Kept for callers that show one id; `liveIds` is the authoritative set.
    liveId: liveSeen[0],
    liveIds: [...liveIds].sort(),
    blockages: [],
  }
}

/** Containment must hold after resolving symlinks, not just lexically. */
function isContained(dir, roots) {
  let realDir
  try {
    realDir = realpathSync(dir)
  } catch {
    return false
  }
  return roots.some((root) => {
    try {
      return realDir.startsWith(realpathSync(root) + sep)
    } catch {
      return false
    }
  })
}

/**
 * Delete exactly the sessions a plan named, after re-checking every guard.
 *
 * The re-checks are the point. Between planning and executing the user may have
 * pinned something in another window; `executeDelete` therefore refuses to run
 * at all when the pin set changed, rather than trusting a stale plan. A caller
 * that wants to proceed must replan — which is what the UI does.
 *
 * @returns {Array<{ id: string, ok: boolean, error?: string }>} one per planned removal
 * @throws when a guard fails before any deletion happens.
 */
export function executeDelete(plan, options = {}) {
  const includePinned = options.includePinned === true
  const env = options.env ?? process.env
  const roots = options.roots ?? sessionsRoots(env)

  // Guard 1: the pin set must be exactly what the plan was built from.
  const current = readPins(env)
  if (current.error !== undefined) {
    throw new Error(`refusing to delete: ${current.error}`)
  }
  const nowPins = [...current.pins].sort()
  if (
    nowPins.length !== plan.pins.length ||
    nowPins.some((id, index) => id !== plan.pins[index])
  ) {
    throw new Error(
      `refusing to delete: the pin set changed since this plan was built ` +
        `(planned ${plan.pins.length} pins, now ${nowPins.length}). Rebuild the plan.`,
    )
  }

  // Guard 2: no pinned id may appear in remove without explicit permission.
  if (!includePinned) {
    const leaked = plan.remove.filter((entry) => current.pins.has(entry.id))
    if (leaked.length > 0) {
      throw new Error(
        `refusing to delete: ${leaked.length} pinned session(s) reached the removal list ` +
          `(${leaked.map((entry) => entry.id).join(', ')}). This is a bug; nothing was deleted.`,
      )
    }
  }

  // Guard 3: live sessions are never removable. Resolved the same way the plan
  // resolves them, so a caller that omitted the argument still gets the
  // defence; an explicit argument can only add protection, never remove it.
  const liveIds = resolveLiveIds({ liveId: options.liveId, env })
  const live = plan.remove.find((entry) => liveIds.has(entry.id))
  if (live !== undefined) {
    throw new Error(`refusing to delete: the live session ${live.id} is in the removal list`)
  }

  // Guard 4: every target must still resolve inside a known sessions root.
  for (const entry of plan.remove) {
    if (!isSafeSessionId(entry.id)) {
      throw new Error(`refusing to delete: unsafe session id "${entry.id}"`)
    }
    if (!isContained(entry.dir, roots)) {
      throw new Error(`refusing to delete: ${entry.dir} is not inside a sessions root`)
    }
  }

  const outcomes = []
  for (const entry of plan.remove) {
    try {
      rmSync(entry.dir, { recursive: true, force: true })
      outcomes.push({ id: entry.id, ok: true })
    } catch (error) {
      outcomes.push({ id: entry.id, ok: false, error: String(error) })
    }
  }
  return outcomes
}

/** Format a byte count for the list rows. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Format an epoch-ms timestamp as a short local date-time. */
export function formatTime(epochMs) {
  if (epochMs === 0) return 'unknown'
  const date = new Date(epochMs)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** The parent workspace directory of a session directory (for display). */
export function workspaceOf(dir) {
  return dirname(dir)
}
