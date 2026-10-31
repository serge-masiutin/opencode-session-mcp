import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultDenyRules, enabledServers, namespaceOf, toggled, validateServers, withEnabled } from '../rules.mjs'

// Копия сопоставления правил OpenCode 2.2.0 (`cj`/`e2`): последнее совпавшее правило, glob по * и ?.
function glob(value, pattern) {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${source}$`, 's').test(value)
}
function effect(action, resource, rules) {
  return rules.findLast((rule) => glob(action, rule.action) && glob(resource, rule.resource))?.effect ?? 'ask'
}

const servers = ['context7', 'playrix-slack', 'playrix-slack_readwrite', 'xforge.browser']
const agent = [{ action: '*', resource: '*', effect: 'allow' }, ...defaultDenyRules(servers)]

test('namespace normalizes like OpenCode', () => {
  assert.equal(namespaceOf('xforge.browser'), 'xforge_browser')
  assert.equal(namespaceOf('playrix-slack'), 'playrix-slack')
})

test('all MCP tools and resources are denied by default', () => {
  assert.equal(effect('context7_resolve-library-id', '*', agent), 'deny')
  assert.equal(effect('xforge_browser_browser_click', '*', agent), 'deny')
  assert.equal(effect('opencode_list_mcp_resources', 'context7', agent), 'deny')
  assert.equal(effect('opencode_read_mcp_resource', 'context7:doc://a', agent), 'deny')
  assert.equal(effect('shell', 'ls', agent), 'allow')
})

test('session allow overrides default deny only for enabled servers', () => {
  const session = withEnabled([], ['context7'], servers)
  const rules = [...agent, ...session]
  assert.equal(effect('context7_resolve-library-id', '*', rules), 'allow')
  assert.equal(effect('opencode_read_mcp_resource', 'context7:doc://a', rules), 'allow')
  assert.equal(effect('playrix-slack_post', '*', rules), 'deny')
  assert.deepEqual(enabledServers(session, servers), ['context7'])
})

test('enabling a server does not leak tools of a prefixed server', () => {
  const rules = [...agent, ...withEnabled([], ['playrix-slack'], servers)]
  assert.equal(effect('playrix-slack_post', '*', rules), 'allow')
  assert.equal(effect('playrix-slack_readwrite_post', '*', rules), 'deny')
})

test('unmanaged session rules are preserved; disabling adds explicit session denies', () => {
  const own = { action: 'edit', resource: '*', effect: 'deny' }
  const enabled = withEnabled([own], ['context7', 'playrix-slack'], servers)
  const disabled = withEnabled(enabled, [], servers)
  assert.deepEqual(disabled[0], own)
  assert.equal(effect('context7_query', '*', disabled), 'deny')
  assert.deepEqual(enabledServers(disabled, servers), [])
})

test('session denies override broad and exact pre-existing allows without changing non-MCP rules', () => {
  const rules = withEnabled([
    { action: '*', resource: '*', effect: 'allow' },
    { action: 'context7_query', resource: '*', effect: 'allow' },
  ], [], servers)
  assert.equal(effect('context7_query', '*', rules), 'deny')
  assert.equal(effect('opencode_read_mcp_resource', 'context7:doc', rules), 'deny')
  assert.equal(effect('shell', 'pwd', rules), 'allow')
})

test('three-level prefixes allow the selected leaf below an unselected parent', () => {
  const rules = withEnabled([], ['a', 'a_b_c'], ['a', 'a_b', 'a_b_c'])
  assert.equal(effect('a_query', '*', rules), 'allow')
  assert.equal(effect('a_b_query', '*', rules), 'deny')
  assert.equal(effect('a_b_c_query', '*', rules), 'allow')
})

test('colliding namespaces and permission wildcard names fail loudly', () => {
  assert.throws(() => validateServers(['a.b', 'a_b']), /collision/)
  assert.throws(() => validateServers(['a*']), /wildcards/)
  assert.throws(() => validateServers(['a', 'opencode']), /reserved/)
  assert.throws(() => validateServers(['opencode.read']), /reserved/)
})

test('toggling one server keeps the others and config order', () => {
  assert.deepEqual(toggled(['playrix-slack'], 'context7', true, servers), ['context7', 'playrix-slack'])
  assert.deepEqual(toggled(['context7', 'playrix-slack'], 'context7', false, servers), ['playrix-slack'])
  assert.deepEqual(toggled([], 'context7', false, servers), [])
})
