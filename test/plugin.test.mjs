/**
 * Smoke test for the plugin entry.
 *
 * Runs without a TUI: a fake cordis context stands in for the host.
 *
 * The fake models the ONE detail that produced the real failure. In dsh-tui,
 * `tuiScenes.register()` and `tuiScenes.open()` both resolve their caller from
 * `this.ctx` — a caller-bound Cordis proxy, *not* the optional `identity`
 * argument (that argument only labels the effect ledger). A scene therefore
 * remembers the activation that registered it, and `open()` refuses a scene
 * owned by a different activation (scenes.js: "belongs to another activation").
 *
 * So a service handle must be bound to the context it was obtained from, and
 * the same handle must be used for both calls.
 *
 * Run with: node test/plugin.test.mjs
 */

import assert from 'node:assert/strict'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

/**
 * A cordis-context stand-in with caller-bound service handles.
 *
 * `ctx.get(name)` returns a handle whose methods act AS THAT ctx, exactly like
 * the real caller-bound proxy. Registering through one handle and opening
 * through another therefore fails the way the real host fails.
 */
function fakeContext({ withCommands = true, withScenes = true, withPluginHost = true } = {}) {
  const registered = []
  const scenes = new Map() // id -> { descriptor, owner }
  const warnings = []
  const effects = []
  let activationSeq = 0

  const services = {}

  /** The scene store, shared by every caller-bound handle. */
  const sceneStore = {
    register(descriptor, ownerActivation) {
      const id = descriptor.id.trim().toLowerCase()
      if (scenes.has(id)) throw new Error(`TUI scene "${id}" is already registered`)
      scenes.set(id, { descriptor, owner: ownerActivation })
      return () => scenes.delete(id)
    },
    open(id, ownerActivation) {
      const entry = scenes.get(id.trim().toLowerCase())
      if (entry === undefined) {
        warnings.push(`no TUI scene registered as "${id}"`)
        return false
      }
      if (ownerActivation !== undefined && entry.owner !== ownerActivation) {
        warnings.push(`scene "${id}" belongs to another activation`)
        return false
      }
      return true
    },
  }

  if (withCommands) {
    services.commands = {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    }
  }

  if (withScenes) {
    // Caller-bound behaviour lives in the handles `get('tuiScenes')` returns.
    services.tuiScenes = {}
  }

  if (withPluginHost) {
    services.tuiPluginHost = {
      registerCommand(_ctx, definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    }
  }

  /** Build a context carrying a given activation token. */
  const makeCtx = activation => {
    const ctx = {
      activation,
      get(name, _required) {
        const service = services[name]
        if (service === undefined) return undefined
        if (name !== 'tuiScenes') return service
        // Caller-bound proxy: every method acts as THIS activation.
        return {
          register: (descriptor, _identity) => sceneStore.register(descriptor, activation),
          open: id => sceneStore.open(id, activation),
        }
      },
      effect(fn, _label) {
        const dispose = fn()
        effects.push(dispose)
        return typeof dispose === 'function' ? dispose : () => {}
      },
      inject(names, fn) {
        activationSeq += 1
        // A child activation, as cordis provides.
        const child = makeCtx(activationSeq)
        if (names.every(name => services[name] !== undefined)) fn(child)
        return () => {}
      },
      logger: {
        debug() {},
        info() {},
        warn(message) {
          warnings.push(message)
        },
      },
    }
    return ctx
  }

  return { ctx: makeCtx(0), registered, scenes, warnings, effects }
}

console.log('\nmodule shape')
const plugin = await import('../lib/index.js')
await test('declares the plugin name', () => {
  assert.equal(plugin.name, 'dsh-session-gc')
})
await test('exports apply', () => {
  assert.equal(typeof plugin.apply, 'function')
})

console.log('\nregistration')
await test('registers /delhistory', () => {
  const host = fakeContext()
  plugin.apply(host.ctx)
  const command = host.registered.find(definition => definition.name === 'delhistory')
  assert.ok(command, 'command must be registered')
  assert.equal(typeof command.handler, 'function')
  assert.match(command.description, /pinned/i)
})
await test('registers the cleaner scene', () => {
  const host = fakeContext()
  plugin.apply(host.ctx)
  assert.equal(host.scenes.size, 1)
  const entry = host.scenes.get('session-history-cleaner')
  assert.ok(entry, 'the scene must be registered')
  assert.equal(typeof entry.descriptor.component, 'function')
})
await test('stays inert with no command registry', () => {
  const host = fakeContext({ withCommands: false })
  plugin.apply(host.ctx)
  assert.equal(host.registered.length, 0)
  assert.equal(host.scenes.size, 0)
})
await test('survives a missing plugin host', () => {
  const host = fakeContext({ withPluginHost: false })
  plugin.apply(host.ctx)
  assert.equal(host.registered.length, 1)
  assert.equal(host.scenes.size, 1)
})

console.log('\nactivation binding (the real bug)')
await test('opens the scene without crossing activations', async () => {
  const host = fakeContext()
  plugin.apply(host.ctx)
  const command = host.registered.find(definition => definition.name === 'delhistory')
  const result = await command.handler({ rawInput: '' })
  assert.deepEqual(host.warnings, [], 'opening must not cross activations')
  assert.equal(result.kind, 'success', `expected success, got: ${JSON.stringify(result)}`)
})
await test('reports an error rather than lying when the scene is missing', async () => {
  const host = fakeContext()
  plugin.apply(host.ctx)
  // Simulate the scene having been dropped (e.g. unloaded).
  host.scenes.clear()
  const command = host.registered.find(definition => definition.name === 'delhistory')
  const result = await command.handler({ rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unavailable/)
})
await test('rejects extra arguments', async () => {
  const host = fakeContext()
  plugin.apply(host.ctx)
  const command = host.registered.find(definition => definition.name === 'delhistory')
  const result = await command.handler({ rawInput: ' a b' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Usage/)
})
await test('no command when the scene seam is absent', () => {
  const host = fakeContext({ withScenes: false })
  plugin.apply(host.ctx)
  assert.equal(host.registered.length, 0)
})

console.log('\nscene component')
await test('builds a component from injected React and ui', () => {
  const host = fakeContext()
  plugin.apply(host.ctx)
  const entry = host.scenes.get('session-history-cleaner')

  const React = {
    useMemo: fn => fn(),
    createElement: (type, props) => ({ type, props }),
  }
  const element = entry.descriptor.component({
    React,
    ui: {},
    close: () => {},
    channel: {},
  })
  assert.ok(element, 'the wrapper must produce an element')
  assert.equal(typeof element.type, 'function')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
