# dsh-session-gc

Manual session history cleanup for dsh-tui. Browse every stored conversation,
mark what you want gone, delete it — **pinned (starred) sessions are protected
by default**.

```
/delhistory
```

## Why this exists

`/resume` can show you sessions, and the non-DSH backends have `Ctrl+D` delete,
but a DSH session has no delete path in the picker at all: the key handler is
gated behind `!dshBackend`, so pressing it under DSH does nothing. This plugin
fills that gap without patching the TUI's build output (which `/update` would
overwrite).

It also exists because of a class of failure worth designing against: a bulk
delete that took out an entire history, starred sessions included, because the
protection list silently collapsed to empty through a scripting mistake. Every
design choice here is aimed at making that class of mistake impossible rather
than merely unlikely.

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move the cursor |
| `Space` | Mark / unmark the row under the cursor |
| `a` | Mark every row the current plan would remove |
| `d` | Delete marked rows (asks `y` / `n`) |
| `p` | Toggle pinned protection (asks `y` / `n`) |
| `r` | Rescan |
| `Esc` / `q` | Leave the scene |

## What protects you

1. **Pinned sessions are kept unless you explicitly unprotect them.** `p`
   asks for confirmation before pinned rows become selectable at all, and the
   footer says so while it is on.
2. **Live sessions can never be deleted.** They are excluded from the plan and
   refused again at execution. The ids are resolved from `channel.sessionId`,
   and — if a caller forgets to pass one — detected from the TUI's own
   `last-run.json` / `session-mounts.json`, so the guard does not depend on
   someone remembering an argument. Two TUI windows means two live ids, and
   all of them are protected. An empty `channel.sessionId` (which the TUI
   really does write as `""` when nothing is attached) means "none", not "the
   empty session".
3. **A pin file that cannot be read protects nothing safely, so it protects
   everything.** A malformed or unreadable `session-pins.json` shows an error
   and lists nothing, instead of presenting an unprotected-looking list. The
   same applies to a well-formed file whose entries are all unusable: zero
   usable pins is corruption, not an empty pin set.
4. **Every plan is recomputed against the live pin set before deleting.** The
   plan carries the pin snapshot it was built from — including pins whose
   session directory is already gone, because an orphan pin is still
   protection. If the pin set changed since the plan was built (another window
   pinned something), the delete refuses and asks for a rebuild.
5. **Containment is re-verified per target.** A directory that does not resolve
   inside a known sessions root is refused after symlink resolution.
6. **Deletion is per-session and reported.** A mid-run failure is listed, not
   swallowed.

## Tests

Plain Node, no test framework:

```sh
node test/core.test.mjs         # discovery, planning, all deletion guards
node test/guard-drill.mjs       # attacks each guard against a throwaway store
node test/plugin.test.mjs       # entry shape, registration, command behaviour
node test/scene-render.test.mjs # the picker, driven by a miniature renderer
node test/inspect-real.mjs      # read-only report against the real store
```

`inspect-real.mjs` deletes nothing. Run it first when verifying against live
data: it prints every session, what would be kept, what would be deleted, and
any orphan pins (pinned ids whose directories no longer exist).

`test/fixtures/make-fixtures.mjs` builds a disposable fake session store in the
system temp directory and prints the `DSH_HOME` / `DSH_TUI_HOME` values that
point at it, so you can drive the real picker without risking real history.

## Install

```sh
dsh plugin --profile <profile> add <path-or-package>
```

The package declares `dsh.bundle.patch`, so the install appends it to the
profile's `dsh.profile.bundles` and `cordis.patch.yml` mounts it. Restart
dsh-TUI afterwards — the command is registered at boot.

## Safety model

The plugin deletes directories under your sessions root, so it is built as if
every other safeguard will eventually be wrong:

- A pin is a **protection key**, not a path. Values that could never name a
  directory are still retained as pins rather than dropped, because dropping a
  pin entry shrinks the protection set without anyone noticing.
- `planDeletion` never derives the pin snapshot from the rows it listed. An
  orphan pin (pinned id, directory already gone) therefore still blocks the
  guard from misreading the file as "nothing was pinned".
- An empty `channel.sessionId` is treated as **absent**, because the TUI really
  does write `""` when no session is attached. Treating it as an explicit id
  would disable live-session detection.
- Deletion is refused when the pin file changed since the plan was built, when
  any pinned id reached the removal list, when any live id reached the removal
  list, or when a target resolves outside a known sessions root.

## Layout

| File | Role |
| --- | --- |
| `lib/core.js` | Discovery, pin reading, planning, guarded deletion. No React, no cordis — unit-testable in plain Node. |
| `lib/scene.js` | The full-screen picker. Renders what `core.js` produced and forwards keys back into it. |
| `lib/index.js` | Plugin entry: registers `/delhistory` and the scene. Stays inert when the TUI seams are absent. |

## License

MIT — see [LICENSE](LICENSE).
