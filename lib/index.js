/**
 * dsh-session-gc — manual session history cleanup for dsh-tui.
 *
 * Registers `/delhistory`, which opens a full-screen picker over every stored
 * session directory. Pinned (starred) sessions are protected by default; the
 * pin set is read from disk independently of the listing so a filtering bug
 * cannot silently unprotect anything.
 *
 * Registration and opening must happen on the SAME activation. `scenes.open()`
 * refuses a scene owned by a different activation (`scenes.js`: "belongs to
 * another activation"), so both run inside one `ctx.inject` callback and both
 * use that callback's context. Splitting them — registering inside the inject
 * callback while opening from the outer context — registers the scene
 * successfully and then refuses to open it, which from the user's side looks
 * exactly like "the plugin did not load".
 */

import { createScene } from './scene.js'

const SCENE_ID = 'session-history-cleaner'

/**
 * Build the scene component.
 *
 * The host injects `React` and the `ui` kit into the component at render time
 * (see `TuiSceneProps`), so the component cannot be constructed before their
 * first render. This wrapper defers that construction to the first render and
 * memoizes it on the injected values — the plugin therefore never imports React
 * itself, which is what keeps it loadable in a composition that has no UI.
 */
function sceneComponent(props) {
  const { React, ui } = props
  const built = React.useMemo(() => createScene(React, ui), [React, ui])
  return React.createElement(built, props)
}

/**
 * Soft TUI integration.
 *
 * Everything runs inside one `ctx.inject(['commands', 'tuiScenes'], …)` so the
 * command, the scene, and the `open()` call share a single activation. A
 * composition without these services simply never runs the callback, which is
 * what keeps a Desktop or headless build inert rather than broken.
 */
export function installSessionGc(ctx) {
  ctx.inject(['commands', 'tuiScenes'], (tui) => {
    const commands = tui.get('commands', false)
    if (commands === undefined) return

    const scenes = tui.get('tuiScenes', false)
    const pluginHost = tui.get('tuiPluginHost', false)

    // 1. The scene, owned by THIS activation.
    tui.effect(() => {
      const dispose = registerOptional(tui, 'cleaner scene', () => {
        if (scenes === undefined) return undefined
        return scenes.register(
          { id: SCENE_ID, title: 'Session history', component: sceneComponent },
          tui,
        )
      })
      return () => dispose()
    }, 'dsh-session-gc: session history scene')

    // 2. The command, opening the scene through the SAME activation.
    tui.effect(() => {
      const definition = {
        name: 'delhistory',
        description: 'Browse and delete old conversations (pinned ones are protected)',
        recordInput: false,
        handler: async ({ rawInput }) => {
          const args = rawInput.trim().split(/\s+/u).filter(Boolean)
          if (args.length > 1) return { kind: 'error', text: 'Usage: /delhistory' }

          const live = tui.get('tuiScenes', false)
          if (live === undefined) {
            return { kind: 'error', text: 'The session cleaner screen is unavailable in this composition.' }
          }
          if (live.open(SCENE_ID) === true) return { kind: 'success' }
          return {
            kind: 'error',
            text: 'The session cleaner screen is unavailable. Restart dsh-TUI so the plugin can register it.',
          }
        },
      }

      const disposeCommand = registerCommand(tui, commands, pluginHost, definition)
      return () => disposeCommand()
    }, 'dsh-session-gc: /delhistory command')
  })
}

/** Register through the mediated surface, falling back only on admission skew. */
function registerCommand(ctx, commands, pluginHost, definition) {
  if (pluginHost === undefined) return commands.register(definition)
  try {
    return pluginHost.registerCommand(ctx, definition)
  } catch (error) {
    // Older dsh-TUI mounts the mediated service but does not admit third-party
    // activations yet. Keep the command usable there; every other mediated
    // failure stays fail-closed.
    if (!hasErrorCode(error, 'COMPONENT_NOT_ADMITTED')) throw error
    ctx.logger.debug(
      'dsh-session-gc: using the legacy command registry because Component admission is unavailable',
    )
    return commands.register(definition)
  }
}

function hasErrorCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function registerOptional(ctx, feature, register) {
  try {
    return register() ?? (() => {})
  } catch (error) {
    ctx.logger.warn(`dsh-session-gc: ${feature} is unavailable`, { error: String(error) })
    return () => {}
  }
}

export const name = 'dsh-session-gc'

export function apply(ctx) {
  installSessionGc(ctx)
}

export default apply
