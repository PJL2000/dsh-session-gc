/**
 * Read-only inspection of the REAL session store.
 *
 * Prints what the cleaner would show and what it would protect, without
 * deleting anything. Used to verify against live data before the plugin is
 * trusted with a delete key.
 *
 * Run with: node test/inspect-real.mjs
 */

import { formatBytes, formatTime, listSessions, planDeletion, readPins, sessionsRoots } from '../lib/core.js'

const { pins, error } = readPins()

console.log('\nsessions roots')
for (const root of sessionsRoots()) console.log(`  ${root}`)

if (error !== undefined) {
  console.log(`\nPIN FILE ERROR: ${error}`)
  console.log('The cleaner would refuse to list, because a pin set it cannot read cannot protect anything.')
  process.exit(2)
}

console.log(`\npins (${pins.size})`)
for (const id of [...pins].sort()) console.log(`  ${id}`)

const entries = listSessions(pins)
const plan = planDeletion(entries)

console.log(`\nsessions on disk: ${entries.length}`)
console.log(`  would KEEP   : ${plan.keep.length}`)
console.log(`  would DELETE : ${plan.remove.length} (${formatBytes(plan.remove.reduce((sum, entry) => sum + entry.bytes, 0))})`)

if (entries.length > 0) {
  console.log('\nall sessions (newest first)')
  for (const entry of entries) {
    const flag = entry.pinned ? '★' : ' '
    const action = plan.remove.some((target) => target.id === entry.id) ? 'DELETE' : 'keep  '
    console.log(
      `  ${flag} ${action}  ${formatTime(entry.updatedAt)}  ${formatBytes(entry.bytes).padStart(8)}  ${entry.id}`,
    )
  }
}

const orphanPins = [...pins].filter((id) => !entries.some((entry) => entry.id === id))
if (orphanPins.length > 0) {
  console.log(`\norphan pins (${orphanPins.length}) — pinned but no session directory exists`)
  for (const id of orphanPins.sort()) console.log(`  ${id}`)
}

console.log('')
