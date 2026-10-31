// Настоящий изолированный OpenCode, локальный MCP и локальный провайдер. Платных вызовов нет.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const mode = process.argv[2] ?? 'codemode'
assert.ok(['codemode', 'direct'].includes(mode), 'Expected codemode or direct')
const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'session-mcp-integration-'))
const directory = join(root, 'project')
const requests = []
const provider = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = JSON.parse(body)
  requests.push(input)
  const lastUser = input.messages.findLastIndex((message) => message.role === 'user')
  const lastTool = input.messages.findLastIndex((message) => message.role === 'tool')
  const firstStep = lastUser > lastTool && (input.tools ?? []).some((tool) => tool.function?.name === 'execute')
  const choose = firstStep && JSON.stringify(input.messages[lastUser]).includes('CHOOSE_ALPHA')
  const toolName = choose ? 'mcp_subagents' : 'execute'
  const searchQuery = JSON.stringify(input.messages[lastUser]).includes('CONSOLE') ? 'opencode_console' : 'alpha'
  const args = choose ? { servers: ['alpha'] } : { code: `return search({ query: ${JSON.stringify(searchQuery)}, limit: 100 })` }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta, finish_reason, usage) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }], ...(usage === undefined ? {} : { usage }) })
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
  const delta = firstStep ? { role: 'assistant', tool_calls: [{ index: 0, id: 'probe', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'OK' }
  res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`)
  res.end(`data: ${JSON.stringify(chunk({}, firstStep ? 'tool_calls' : 'stop', usage))}\n\ndata: [DONE]\n\n`)
})
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
await mkdir(join(root, 'config/opencode'), { recursive: true })
await mkdir(directory, { recursive: true })
const config = {
  model: 'fixture/fixture', update: 'disable', compaction: { auto: false },
  plugins: [resolve(import.meta.dirname, '..')],
  mcp: { servers: Object.fromEntries(['alpha', 'alpha_child', 'opencode_console'].map((name) => [name, { type: 'local', command: [process.execPath, resolve(import.meta.dirname, 'mcp-fixture.mjs')], codemode: mode === 'codemode', disabled: false }])) },
  providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-not-a-secret' }, models: { fixture: { limit: { context: 1_000_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } } } },
}
await writeFile(join(root, 'config/opencode/opencode.json'), JSON.stringify(config))
let log = ''
const server = spawn(process.env.OPENCODE_TEST_BIN ?? 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: directory, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state') }, stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (chunk) => { log += chunk })
server.stderr.on('data', (chunk) => { log += chunk })
async function api(path, body) {
  const password = log.match(/server password (\S+)/)?.[1]
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'content-type': 'application/json', ...(password === undefined ? {} : { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 500)}`)
  return text === '' ? undefined : JSON.parse(text)
}
async function until(read, accept) {
  for (let i = 0; i < 150; i++) { const value = await read(); if (accept(value)) return value; await delay(100) }
  throw new Error('Timed out waiting for fixture condition')
}
const query = `location.directory=${encodeURIComponent(directory)}`
const rpc = (method, input) => api(`/api/rpc/local-session-mcp.servers/${method}?${query}`, { input })
const create = async (parentID) => (await api('/api/session', { location: { directory }, ...(parentID === undefined ? {} : { parentID }) })).data.id
async function turn(sessionID, text) {
  const before = requests.length
  await api(`/api/session/${sessionID}/prompt`, { text })
  const messages = await until(async () => (await api(`/api/session/${sessionID}/context`)).data, (messages) => requests.length > before && messages.at(-1)?.type === 'idle')
  const lastUser = messages.findLastIndex((message) => message.type === 'user')
  const probe = messages.slice(lastUser + 1).flatMap((message) => message.type === 'assistant' ? message.content : []).find((part) => part.type === 'tool' && part.name === 'execute')
  if (text === 'CHOOSE_ALPHA') return []
  assert.equal(probe?.state.status, 'completed', JSON.stringify(probe?.state))
  const result = JSON.parse(probe.state.content.filter((part) => part.type === 'text').map((part) => part.text).join(''))
  if (mode === 'direct') return (requests.at(-1).tools ?? []).map((tool) => tool.function?.name)
    .filter((name) => ['alpha_echo', 'alpha_child_echo', 'opencode_console_echo'].includes(name))
    .map((name) => `tools.${name.slice(0, -'_echo'.length)}.echo`)
  // Поиск opencode_console также возвращает встроенные tools.opencode.* — это не MCP фикстуры.
  return result.items.map((item) => item.path).filter((path) => !path.startsWith('tools.opencode.'))
}
try {
  await until(async () => { try { return await api('/api/info') } catch { if (server.exitCode !== null) throw new Error('Fixture server exited'); return undefined } }, Boolean)
  const one = await create()
  const two = await create()
  assert.ok((await rpc('state', { sessionID: one })).output.servers.every((server) => server.status === 'disabled'))
  await rpc('set', { sessionID: one, server: 'alpha', enabled: true })
  await until(async () => (await rpc('state', { sessionID: one })).output, (state) => state.servers.find((s) => s.name === 'alpha')?.status === 'connected')
  assert.deepEqual(await turn(one, 'PARENT'), ['tools.alpha.echo'])
  assert.deepEqual(await turn(two, 'OTHER'), [])
  const childWithout = await create(one)
  assert.deepEqual(await turn(childWithout, 'CHILD_WITHOUT'), [])
  await turn(one, 'CHOOSE_ALPHA')
  const childWith = await create(one)
  assert.deepEqual(await turn(childWith, 'CHILD_WITH'), ['tools.alpha.echo'])
  await rpc('set', { sessionID: two, server: 'alpha_child', enabled: true })
  await until(async () => (await rpc('state', { sessionID: two })).output, (state) => state.servers.find((s) => s.name === 'alpha_child')?.status === 'connected')
  assert.deepEqual(await turn(one, 'PREFIX_ISOLATION'), ['tools.alpha.echo'])
  await rpc('set', { sessionID: one, server: 'alpha', enabled: false })
  assert.equal((await rpc('state', { sessionID: childWith })).output.servers.find((s) => s.name === 'alpha').status, 'connected')
  await rpc('set', { sessionID: childWith, server: 'alpha', enabled: false })
  await until(async () => (await rpc('state', { sessionID: one })).output, (state) => state.servers.find((s) => s.name === 'alpha')?.status === 'disabled')
  await rpc('set', { sessionID: one, server: 'opencode_console', enabled: true })
  await until(async () => (await rpc('state', { sessionID: one })).output, (state) => state.servers.find((s) => s.name === 'opencode_console')?.status === 'connected')
  assert.deepEqual(await turn(one, 'CONSOLE_ENABLED'), ['tools.opencode_console.echo'])
  assert.deepEqual(await turn(childWithout, 'CONSOLE_OTHER_SESSION'), [])
  await rpc('set', { sessionID: one, server: 'opencode_console', enabled: false })
  assert.deepEqual(await turn(one, 'CONSOLE_DISABLED'), [])
  console.log(`PASSED (${mode}): default-off, session isolation, child opt-in, prefix isolation, last-holder disconnect`)
} catch (error) {
  console.error('Fixture tool names:', requests.map((request) => (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name)))
  await writeFile(join(root, 'server.log'), log.replace(/server password \S+/g, 'server password [REDACTED]'), { mode: 0o600 })
  console.error(`Fixture logs: ${root}/server.log`)
  throw error
} finally {
  server.kill('SIGTERM')
  await new Promise((resolve) => provider.close(resolve))
}
