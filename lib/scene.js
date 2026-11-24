/**
 * The full-screen session cleaner scene.
 *
 * A thin shell: every decision about WHAT is safe to delete lives in core.js.
 * This file only renders the list the core produced and forwards key presses
 * back into it, so a UI bug can never widen the delete set — the guards run
 * again inside `executeDelete` regardless of what the user selected here.
 *
 * Keys:
 *   ↑/↓  move          Space  mark/unmark        a  mark all deletable
 *   p    include pinned (asks for confirmation)   r  rescan
 *   d    delete marked (asks for confirmation)    Esc/q  leave
 */

import { readPins, listSessions, planDeletion, executeDelete, formatBytes, formatTime } from './core.js'
/** How many rows fit, leaving room for the header, footer and confirm line. */
function listHeight(rows) {
  return Math.max(3, rows - 9)
}

export function createScene(React, ui) {
  const { Box, Text, useInput, useTerminalSize } = ui

  return function SessionGcScene(props) {
    const { close, channel } = props
    // useTerminalSize returns an OBJECT ({ columns, rows }), not a tuple.
    const terminal = useTerminalSize()
    const columns = terminal.columns
    const rows = terminal.rows
    // Guard the object shape so a future change fails loudly here instead of
    // rendering a zero-height list.
    if (typeof columns !== 'number' || typeof rows !== 'number') {
      throw new Error('dsh-session-gc: useTerminalSize() did not return { columns, rows }')
    }

    const [entries, setEntries] = React.useState([])
    const [cursor, setCursor] = React.useState(0)
    const [marked, setMarked] = React.useState(() => new Set())
    const [includePinned, setIncludePinned] = React.useState(false)
    const [pending, setPending] = React.useState(undefined) // 'delete' | 'unpin' | 'includePinned'
    const [notice, setNotice] = React.useState(undefined)
    const [loading, setLoading] = React.useState(true)
    // The pin snapshot the current list was built from. Held in state so the
    // plan and the delete run against the SAME set the rows were rendered from.
    const [pins, setPins] = React.useState(() => new Set())

    // `channel.sessionId` is `''` when the TUI has no attached session. Passing
    // that through as "the live id" used to suppress auto-detection and put the
    // real live session in the removal list, so an empty string means "none".
    const explicitLiveId =
      channel !== undefined &&
      channel !== null &&
      typeof channel.sessionId === 'string' &&
      channel.sessionId.length > 0
        ? channel.sessionId
        : undefined

    const rescan = React.useCallback(() => {
      const read = readPins()
      if (read.error !== undefined) {
        setNotice({ tone: 'error', text: read.error })
        // A pin set we cannot read is a pin set we cannot honour: show nothing
        // rather than an unprotected-looking list.
        setPins(new Set())
        setEntries([])
        setLoading(false)
        return
      }
      setPins(read.pins)
      const found = listSessions(read.pins)
      setEntries(found)
      setMarked(new Set())
      setCursor((current) => Math.min(current, Math.max(0, found.length - 1)))
      setLoading(false)
    }, [])

    // Scan on mount. Kept in an effect so a rescan is the same code path.
    React.useEffect(() => {
      rescan()
    }, [rescan])

    const plan = React.useMemo(
      () => planDeletion(entries, { includePinned, liveId: explicitLiveId, pins }),
      [entries, includePinned, explicitLiveId, pins],
    )

    /** Marked rows that the current plan would actually remove. */
    const deletable = React.useMemo(
      () => plan.remove.filter((entry) => marked.has(entry.id)),
      [plan, marked],
    )

    const height = listHeight(rows)
    const top = Math.max(0, Math.min(cursor - Math.floor(height / 2), Math.max(0, entries.length - height)))
    const visible = entries.slice(top, top + height)

    const runDelete = React.useCallback(() => {
      if (deletable.length === 0) return
      // Rebuild the plan with ONLY the marked rows, so the guards in
      // executeDelete see exactly what the user confirmed.
      const markedPlan = {
        ...plan,
        remove: deletable,
        keep: entries.filter((entry) => !deletable.some((target) => target.id === entry.id)),
      }
      try {
        const outcomes = executeDelete(markedPlan, { includePinned, liveId: explicitLiveId })
        const okCount = outcomes.filter((outcome) => outcome.ok).length
        const failures = outcomes.filter((outcome) => !outcome.ok)
        if (failures.length === 0) {
          setNotice({ tone: 'success', text: `deleted ${okCount} session(s)` })
        } else {
          setNotice({
            tone: 'error',
            text: `deleted ${okCount}, ${failures.length} failed: ${failures[0].error ?? 'unknown'}`,
          })
        }
        rescan()
      } catch (error) {
        setNotice({ tone: 'error', text: String(error && error.message ? error.message : error) })
      } finally {
        setPending(undefined)
      }
    }, [deletable, entries, plan, includePinned, explicitLiveId, rescan])

    useInput((input, key) => {
      // A pending confirmation owns the keyboard: nothing else may act until
      // it is answered, so an accidental keypress cannot become a deletion.
      if (pending !== undefined) {
        if (pending === 'delete') {
          if (input === 'y' || input === 'Y') runDelete()
          else if (input === 'n' || input === 'N' || key.escape) setPending(undefined)
          return
        }
        if (pending === 'includePinned') {
          if (input === 'y' || input === 'Y') {
            setIncludePinned(true)
            setMarked(new Set())
            setNotice({ tone: 'error', text: 'pinned sessions are now deletable — press p again to re-protect' })
          }
          if (input === 'y' || input === 'Y' || input === 'n' || input === 'N' || key.escape) setPending(undefined)
          return
        }
        if (pending === 'unpin') {
          if (input === 'y' || input === 'Y') {
            setIncludePinned(false)
            setMarked(new Set())
            setNotice({ tone: 'success', text: 'pinned sessions protected again' })
          }
          if (input === 'y' || input === 'Y' || input === 'n' || input === 'N' || key.escape) setPending(undefined)
          return
        }
        return
      }

      if (key.escape || input === 'q') {
        close()
        return
      }
      if (key.upArrow) {
        setCursor((current) => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setCursor((current) => Math.min(entries.length - 1, current + 1))
        return
      }
      if (input === ' ') {
        const entry = entries[cursor]
        if (entry === undefined) return
        if (plan.liveIds.includes(entry.id)) {
          setNotice({ tone: 'error', text: 'the live session cannot be deleted' })
          return
        }
        setMarked((current) => {
          const next = new Set(current)
          if (next.has(entry.id)) next.delete(entry.id)
          else {
            if (entry.pinned && !includePinned) {
              setNotice({ tone: 'error', text: 'this session is pinned — press p first' })
              return current
            }
            next.add(entry.id)
          }
          return next
        })
        return
      }
      if (input === 'a') {
        // Mark every row the current plan would remove.
        setMarked(new Set(plan.remove.map((entry) => entry.id)))
        return
      }
      if (input === 'p') {
        setPending(includePinned ? 'unpin' : 'includePinned')
        return
      }
      if (input === 'r') {
        rescan()
        return
      }
      if (input === 'd') {
        if (deletable.length === 0) {
          setNotice({ tone: 'error', text: 'nothing marked — press Space on a row, or a to mark all' })
          return
        }
        setPending('delete')
        return
      }
    })

    const pinnedCount = entries.filter((entry) => entry.pinned).length
    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)

    const confirmLine = (() => {
      if (pending === 'delete') {
        const bytes = deletable.reduce((sum, entry) => sum + entry.bytes, 0)
        return `Delete ${deletable.length} session(s), ${formatBytes(bytes)}? This cannot be undone.  y / n`
      }
      if (pending === 'includePinned') return 'Unprotect pinned sessions? They become deletable.  y / n'
      if (pending === 'unpin') return 'Re-protect pinned sessions?  y / n'
      return undefined
    })()

    return React.createElement(
      Box,
      { flexDirection: 'column', width: columns, height: rows, paddingX: 1 },

      // Header
      React.createElement(
        Text,
        { color: 'primary', bold: true },
        `Session history  ·  ${entries.length} session(s), ${formatBytes(totalBytes)}  ·  ${pinnedCount} pinned`,
      ),
      React.createElement(
        Text,
        { dimColor: true },
        includePinned ? 'PINNED SESSIONS ARE DELETABLE (p to re-protect)' : 'pinned sessions are protected',
      ),

      // List
      React.createElement(
        Box,
        { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
        loading
          ? React.createElement(Text, { dimColor: true }, 'scanning…')
          : entries.length === 0
            ? React.createElement(Text, { dimColor: true }, 'no sessions found')
            : visible.map((entry, index) => {
                const absolute = top + index
                const isCursor = absolute === cursor
                const isMarked = marked.has(entry.id)
                const isLive = plan.liveIds.includes(entry.id)
                const mark = isMarked ? '[x]' : '[ ]'
                const star = entry.pinned ? '★' : ' '
                const live = isLive ? ' ←live' : ''
                const label = `${mark} ${star} ${entry.id.slice(0, 8)}  ${formatTime(entry.updatedAt)}  ${formatBytes(entry.bytes).padStart(8)}${live}`
                return React.createElement(
                  Text,
                  {
                    key: entry.id,
                    color: isCursor ? 'primary' : isLive ? 'subtle' : undefined,
                    inverse: isCursor,
                  },
                  label,
                )
              }),
      ),

      // Confirm / notice
      confirmLine !== undefined
        ? React.createElement(Text, { color: 'error', bold: true }, ` ${confirmLine}`)
        : React.createElement(Box, { height: 1 }),
      notice !== undefined
        ? React.createElement(Text, { color: notice.tone === 'error' ? 'error' : 'success' }, ` ${notice.text}`)
        : React.createElement(Box, { height: 1 }),

      // Footer
      React.createElement(
        Text,
        { dimColor: true },
        ` ↑↓ move  Space mark  a all  d delete  p pinned  r rescan  Esc close   ·  marked ${marked.size}, will delete ${deletable.length}`,
      ),
    )
  }
}

export default createScene
