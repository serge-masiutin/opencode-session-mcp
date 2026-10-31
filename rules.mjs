// Правила прав доступа, которыми плагин делает MCP видимыми только в выбранных сессиях.
// OpenCode применяет последнее совпавшее правило (findLast), а права сессии идут после прав агента.
// Поэтому запрет по умолчанию добавляется агентам, а разрешение для сессии — в её permissions.

const LIST_RESOURCES = 'opencode_list_mcp_resources'
const READ_RESOURCE = 'opencode_read_mcp_resource'

/** Пространство имён MCP-инструментов, как его строит OpenCode (`Zd` в 2.2.0). */
export function namespaceOf(server) {
  return server.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Права OpenCode не различают серверы с одинаковым нормализованным именем. */
export function validateServers(servers) {
  const namespaces = new Map()
  for (const server of servers) {
    if (/[*?]/.test(server)) throw new Error(`MCP server name contains permission wildcards: ${server}`)
    const namespace = namespaceOf(server)
    if (namespace === 'opencode' || namespace.startsWith('opencode_')) throw new Error(`MCP namespace is reserved for OpenCode tools: ${server}`)
    if (namespaces.has(namespace)) throw new Error(`MCP namespace collision: ${namespaces.get(namespace)} and ${server}`)
    namespaces.set(namespace, server)
  }
}

function serverRules(server, effect) {
  return [
    { action: `${namespaceOf(server)}_*`, resource: '*', effect },
    { action: LIST_RESOURCES, resource: server, effect },
    { action: READ_RESOURCE, resource: `${server}:*`, effect },
  ]
}

/** Запрет всех MCP по умолчанию: инструменты, каталог Code Mode и <mcp_instructions> скрыты. */
export function defaultDenyRules(servers) {
  return servers.flatMap((server) => serverRules(server, 'deny'))
}

/**
 * Каждый сервер получает явное правило в сессии, перекрывающее старые широкие allow.
 * Более специфичные префиксы идут последними: a_b не должен перекрывать выбранный a_b_c.
 */
export function sessionRules(enabled, servers) {
  validateServers(servers)
  return servers.toSorted((a, b) => namespaceOf(a).length - namespaceOf(b).length || a.localeCompare(b))
    .flatMap((server) => serverRules(server, enabled.includes(server) ? 'allow' : 'deny'))
}

/** Правило, которым управляет плагин: остальные правила сессии сохраняются как есть. */
export function isManagedRule(rule, servers) {
  if (rule.action === LIST_RESOURCES) return servers.includes(rule.resource)
  if (rule.action === READ_RESOURCE) return servers.some((server) => rule.resource === `${server}:*`)
  return rule.resource === '*' && servers.some((server) => rule.action === `${namespaceOf(server)}_*`)
}

/** Серверы, включённые в сессии. Источник правды — права сессии, отдельного состояния нет. */
export function enabledServers(permissions, servers) {
  return servers.filter((server) => permissions.findLast((rule) =>
    rule.resource === '*' && rule.action === `${namespaceOf(server)}_*`)?.effect === 'allow')
}

export function withEnabled(permissions, enabled, servers) {
  return [...permissions.filter((rule) => !isManagedRule(rule, servers)), ...sessionRules(enabled, servers)]
}

/** Набор включённых серверов после переключения одного из них; порядок — как в конфигурации. */
export function toggled(enabled, server, on, servers) {
  return servers.filter((name) => name === server ? on : enabled.includes(name))
}
