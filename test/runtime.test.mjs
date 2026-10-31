import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup } from '../runtime.mjs'
import { enabledServers } from '../rules.mjs'

async function host(t) {
  const folder = await mkdtemp(join(tmpdir(), 'session-mcp-test-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const configurations = new Map([['alpha', { disabled: false }], ['beta', { disabled: false }]])
  const sessions = new Map(['one', 'two', 'child'].map((id) => [id, {
    id, location: { directory: '/fixture' }, permissions: [], ...(id === 'child' ? { parentID: 'one' } : {}),
  }]))
  const hooks = new Map()
  const tools = new Map()
  const storage = new Map()
  const histories = new Map()
  let transform
  const editor = { list: () => [...configurations], update: (name, change) => change(configurations.get(name)) }
  const ctx = {
    location: { directory: '/fixture' },
    storage: { get: async (key) => storage.get(key), set: async (key, value) => storage.set(key, value) },
    mcp: {
      transform: async (callback) => { transform = callback; callback(editor); return { dispose() {} } },
      reload: async () => transform(editor),
      list: async () => ({ data: [...configurations].map(([name, config]) => ({ name, status: { status: config.disabled ? 'disabled' : 'connected' } })) }),
    },
    agent: { reload: async () => {}, transform: async (callback) => { callback({ list: () => [], update() {} }); return { dispose() {} } } },
    session: {
      list: async () => ({ data: [...sessions.values()].map((s) => structuredClone(s)), cursor: {} }),
      context: async ({ sessionID }) => histories.get(sessionID) ?? [],
      get: async ({ sessionID }) => structuredClone(sessions.get(sessionID)),
      update: async ({ sessionID, ...change }) => Object.assign(sessions.get(sessionID), change),
      hook: async (name, callback) => { hooks.set(name, callback); return { dispose() {} } },
    },
    tool: { transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); return { dispose() {} } } },
    event: { subscribe: async function* ({ signal }) { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })) } },
  }
  const plugin = await setup(ctx, folder)
  t.after(() => plugin.cleanup())
  return { ...plugin, configurations, sessions, hooks, tools, ctx, folder, histories }
}

test('project-enabled servers are disabled until a session explicitly enables them', async (t) => {
  const h = await host(t)
  assert.ok([...h.configurations.values()].every((server) => server.disabled))
  await h.api.setEnabled('one', 'alpha', true)
  assert.equal(h.configurations.get('alpha').disabled, false)
  assert.equal(h.configurations.get('beta').disabled, true)
  assert.deepEqual(enabledServers(h.sessions.get('two').permissions, ['alpha', 'beta']), [])
})

test('last session disabling a server releases it, not the first', async (t) => {
  const h = await host(t)
  await h.api.setEnabled('one', 'alpha', true)
  await h.api.setEnabled('two', 'alpha', true)
  await h.api.setEnabled('one', 'alpha', false)
  assert.equal(h.configurations.get('alpha').disabled, false)
  await h.api.setEnabled('two', 'alpha', false)
  assert.equal(h.configurations.get('alpha').disabled, true)
})

test('parallel session toggles preserve both selections and reject cross-location requests', async (t) => {
  const h = await host(t)
  await Promise.all([h.api.setEnabled('one', 'alpha', true), h.api.setEnabled('one', 'beta', true)])
  assert.deepEqual(enabledServers(h.sessions.get('one').permissions, ['alpha', 'beta']), ['alpha', 'beta'])
  await assert.rejects(h.api.setEnabled('one', 'unknown', true), /Unknown MCP server/)
  h.sessions.get('two').location.directory = '/another'
  await assert.rejects(h.api.state('two'), /another location/)
})

test('subagents receive no MCP by default and only the selected parent MCP on first prompt', async (t) => {
  const h = await host(t)
  await h.hooks.get('prompt')({ sessionID: 'child' })
  assert.deepEqual(enabledServers(h.sessions.get('child').permissions, ['alpha', 'beta']), [])
  await h.api.setEnabled('one', 'alpha', true)
  const choose = (servers) => h.tools.get('mcp_subagents').execute({ servers }, { sessionID: 'one' })
  await assert.rejects(choose(['beta']), /Недоступны/)
  await choose(['alpha'])
  h.sessions.set('next-child', { id: 'next-child', parentID: 'one', location: { directory: '/fixture' }, permissions: [] })
  await h.hooks.get('prompt')({ sessionID: 'next-child' })
  assert.deepEqual(enabledServers(h.sessions.get('next-child').permissions, ['alpha', 'beta']), ['alpha'])
  // Выбор набора для следующих детей не меняет права уже запущенного ребёнка.
  await choose([])
  await h.hooks.get('prompt')({ sessionID: 'next-child' })
  assert.deepEqual(enabledServers(h.sessions.get('next-child').permissions, ['alpha', 'beta']), ['alpha'])
})

test('catalog growth denies new descendants despite an old session prefix allow', async (t) => {
  const h = await host(t)
  await h.api.setEnabled('one', 'alpha', true)
  h.configurations.set('alpha_child', { disabled: false })
  await h.ctx.mcp.reload()
  await h.api.state('one')
  const rules = h.sessions.get('one').permissions
  assert.equal(rules.findLast((r) => r.action === 'alpha_child_*').effect, 'deny')
})

test('resuming an initialized child after plugin reload does not grant the new parent selection', async (t) => {
  const h = await host(t)
  await h.api.setEnabled('one', 'alpha', true)
  await h.tools.get('mcp_subagents').execute({ servers: ['alpha'] }, { sessionID: 'one' })
  await h.hooks.get('prompt')({ sessionID: 'child' })
  await h.cleanup()
  const next = await setup(h.ctx, h.folder)
  t.after(() => next.cleanup())
  await next.api.setEnabled('one', 'beta', true)
  await h.tools.get('mcp_subagents').execute({ servers: ['beta'] }, { sessionID: 'one' })
  await h.hooks.get('prompt')({ sessionID: 'child' })
  assert.deepEqual(enabledServers(h.sessions.get('child').permissions, ['alpha', 'beta']), ['alpha'])
})

test('an existing pre-upgrade child keeps its choice on first prompt after upgrade', async (t) => {
  const h = await host(t)
  await h.api.setEnabled('one', 'beta', true)
  await h.api.setEnabled('child', 'alpha', true)
  h.histories.set('child', [{ type: 'user', id: 'already-admitted' }])
  await h.tools.get('mcp_subagents').execute({ servers: ['beta'] }, { sessionID: 'one' })
  await h.hooks.get('prompt')({ sessionID: 'child' })
  assert.deepEqual(enabledServers(h.sessions.get('child').permissions, ['alpha', 'beta']), ['alpha'])
})

test('catalog reconciliation recovers on the next request after a transient list error', async (t) => {
  const h = await host(t)
  await h.api.state('one')
  const list = h.ctx.session.list
  let failures = 2
  h.ctx.session.list = async (...args) => {
    if (failures-- > 0) throw new Error('temporary list failure')
    return list(...args)
  }
  h.configurations.set('new_server', { disabled: false })
  await h.ctx.mcp.reload()
  await assert.rejects(h.api.state('one'), /temporary list failure/)
  assert.ok((await h.api.state('one')).servers.some((server) => server.name === 'new_server'))
  assert.equal(h.configurations.get('new_server').disabled, true)
})

test('prompt normalization and user toggles use the same permission queue', async (t) => {
  const h = await host(t)
  await h.api.state('one')
  h.sessions.set('fresh', { id: 'fresh', location: { directory: '/fixture' }, permissions: [] })
  const get = h.ctx.session.get
  let release, entered
  const blocked = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  let first = true
  h.ctx.session.get = async (input) => {
    const snapshot = await get(input)
    if (input.sessionID === 'fresh' && first) { first = false; entered(); await blocked }
    return snapshot
  }
  const prompt = h.hooks.get('prompt')({ sessionID: 'fresh' })
  await started
  const toggle = h.api.setEnabled('fresh', 'alpha', true)
  release()
  await Promise.all([prompt, toggle])
  assert.deepEqual(enabledServers(h.sessions.get('fresh').permissions, ['alpha', 'beta']), ['alpha'])
})
