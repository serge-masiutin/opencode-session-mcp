import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false, server: { middlewareMode: true }, appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
})
const { createSessionStates, failureMessage, sameTarget, targetOf } = await vite.ssrLoadModule('/gui/state.ts')
const { registerSessionMcp } = await vite.ssrLoadModule('/mcp-rpc.ts')
after(() => vite.close())

function deferred() {
  let resolve, reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

const state = (enabled) => ({ servers: [{ name: 'server', title: null, integrationID: null, enabled, status: 'connected', error: null }] })
const target = (client, key = 'session') => targetOf({ key, id: 'ses_a', location: { directory: '/project' }, pending: false, server: { client } })
const rpcClient = (rpc) => ({ rpc: () => rpc })

test('target follows a replaced client and detects the replacement for subscriptions', async () => {
  const calls = []
  const client = (name) => ({
    rpc: () => ({
      state: async () => { calls.push(`${name}:state`); return state(true) },
      events: { on: () => { calls.push(`${name}:watch`); return () => {} } },
    }),
    mcp: { connect: async () => { calls.push(`${name}:connect`) } },
    integration: {
      get: async () => { calls.push(`${name}:get`); return { data: { methods: [{ type: 'oauth', id: 'oauth' }] } } },
      oauth: { connect: async () => { calls.push(`${name}:oauth`); return { data: { url: 'https://example.com' } } } },
    },
  })
  let active = client('old')
  const server = { get client() { return active } }
  const session = { key: 'session', id: 'ses_a', location: { directory: '/project' }, pending: false, server }
  const old = targetOf(session)
  const states = createSessionStates()
  states.watch(old, () => {}, new AbortController().signal)
  active = client('new')
  const next = targetOf(session)
  assert.equal(sameTarget(old, next), false)
  assert.equal(sameTarget(next, targetOf(session)), true)
  states.watch(next, () => {}, new AbortController().signal)
  await states.refresh(old)
  await states.connect(old, 'server')
  assert.equal(await states.signInUrl(old, { name: 'server', integrationID: 'integration' }), 'https://example.com')
  assert.deepEqual(calls, ['old:watch', 'new:watch', 'new:state', 'new:connect', 'new:get', 'new:oauth'])
})

test('newer reads and mutations prevent stale replies, independently per session', async () => {
  const reads = []
  const writes = []
  const client = rpcClient({
    state: () => { const pending = deferred(); reads.push(pending); return pending.promise },
    set: () => { const pending = deferred(); writes.push(pending); return pending.promise },
  })
  const first = target(client)
  const other = target(client, 'other')
  const states = createSessionStates()
  const oldRead = states.refresh(first)
  const otherRead = states.refresh(other)
  const newerRead = states.refresh(first)
  reads[2].resolve(state(true))
  await newerRead
  reads[0].resolve(state(false))
  reads[1].resolve(state(false))
  await Promise.all([oldRead, otherRead])
  assert.equal(states.get(first.key).servers[0].enabled, true)
  assert.equal(states.get(other.key).servers[0].enabled, false)

  const beforeSet = states.refresh(first)
  const olderSet = states.set(first, 'a', true)
  const duringSet = states.refresh(first)
  const newerSet = states.set(first, 'b', false)
  writes[1].resolve(state(false))
  await newerSet
  writes[0].resolve(state(true))
  reads[3].resolve(state(true))
  reads[4].resolve(state(true))
  await Promise.all([olderSet, beforeSet, duringSet])
  assert.equal(states.get(first.key).servers[0].enabled, false)
})

test('a read started during a mutation cannot overwrite its result', async () => {
  const read = deferred()
  const write = deferred()
  const states = createSessionStates()
  const session = target(rpcClient({ state: () => read.promise, set: () => write.promise }))
  const change = states.set(session, 'server', true)
  const refresh = states.refresh(session)
  write.resolve(state(true))
  await change
  read.resolve(state(false))
  await refresh
  assert.equal(states.get(session.key).servers[0].enabled, true)
})

test('a response from a previous location cannot overwrite a moved session or invalidate its new read', async () => {
  const oldWrite = deferred()
  const newRead = deferred()
  const states = createSessionStates()
  const before = target(rpcClient({ set: () => oldWrite.promise }))
  const after = { ...target(rpcClient({ state: () => newRead.promise })), location: { directory: '/moved' } }
  const change = states.set(before, 'server', true)
  const refresh = states.refresh(after)
  oldWrite.resolve(state(true))
  await change
  newRead.resolve(state(false))
  await refresh
  assert.equal(states.get(after.key).servers[0].enabled, false)
})

test('failure from a previous location does not start a recovery read in the old location', async () => {
  const oldWrite = deferred()
  const failure = new Error('old location failed')
  let oldReads = 0
  const states = createSessionStates()
  const before = target(rpcClient({ set: () => oldWrite.promise, state: async () => { oldReads++; return state(true) } }))
  const after = { ...target(rpcClient({ state: async () => state(false) })), location: { directory: '/moved' } }
  const change = states.set(before, 'server', true)
  await states.refresh(after)
  oldWrite.reject(failure)
  await assert.rejects(change, (error) => error === failure)
  assert.equal(oldReads, 0)
  assert.equal(states.get(after.key).servers[0].enabled, false)
})

test('aborted reads do not update state even if the transport resolves', async () => {
  const read = deferred()
  const states = createSessionStates()
  const session = target(rpcClient({ state: () => read.promise }))
  const controller = new AbortController()
  const refresh = states.refresh(session, controller.signal)
  controller.abort()
  read.resolve(state(true))
  await refresh
  assert.equal(states.get(session.key), undefined)
})

test('failed set refreshes partially applied state and still reports the original error', async () => {
  const failure = new Error('write failed')
  const states = createSessionStates()
  const session = target(rpcClient({ set: async () => { throw failure }, state: async () => state(true) }))
  await assert.rejects(states.set(session, 'server', true), (error) => error === failure)
  assert.equal(states.get(session.key).servers[0].enabled, true)
})

test('failed recovery retains and reports both errors', async () => {
  const write = new Error('write failed')
  const read = new Error('read failed')
  const states = createSessionStates()
  const session = target(rpcClient({ set: async () => { throw write }, state: async () => { throw read } }))
  await assert.rejects(states.set(session, 'server', true), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [write, read])
    assert.match(failureMessage(error), /write failed.*read failed/)
    return true
  })
})

test('a recovery read cannot overwrite a newer mutation', async () => {
  const recovery = deferred()
  const failure = new Error('partially applied')
  let writes = 0
  const states = createSessionStates()
  const session = target(rpcClient({
    set: async () => { if (++writes === 1) throw failure; return state(false) },
    state: () => recovery.promise,
  }))
  const failed = states.set(session, 'server', true)
  await Promise.resolve()
  await states.set(session, 'server', false)
  recovery.resolve(state(true))
  await assert.rejects(failed, (error) => error === failure)
  assert.equal(states.get(session.key).servers[0].enabled, false)
})

test('RPC reports possible partial application instead of claiming no changes', async () => {
  let handlers
  const ctx = { rpc: { register: async (_contract, value) => {
    handlers = value
    return { events: { emit: async () => {} }, dispose: async () => {} }
  } } }
  const api = {
    state: async () => { throw new Error('unavailable') },
    setEnabled: async () => { throw new Error('partial write') },
    onChange: () => () => {},
  }
  const registration = await registerSessionMcp(ctx, api, async () => {})
  const context = { error: (type, message) => ({ type, message }) }
  const result = await handlers.set({ sessionID: 'ses_a', server: 'server', enabled: true }, context)
  assert.equal(result.type, 'unavailable')
  assert.match(result.message, /Some changes may have been applied/)
  assert.doesNotMatch(result.message, /Nothing was changed/)
  const read = await handlers.state({ sessionID: 'ses_a' }, context)
  assert.match(read.message, /Could not load/)
  await registration.dispose()
})
