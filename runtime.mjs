import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultDenyRules, enabledServers, toggled, validateServers, withEnabled } from './rules.mjs'

const LOG_DIR = join(homedir(), '.local/share/opencode/session-mcp')
const CONNECT_TIMEOUT_MS = 60_000
const POLL_MS = 250
const CATALOG_SETTLE_MS = 500

export class UnknownServerError extends Error {}
export class LocationMismatchError extends Error {}

/**
 * MCP по сессиям.
 * - Всем агентам добавляется запрет на инструменты и ресурсы каждого MCP-сервера.
 * - `setEnabled` пишет разрешения в permissions сессии и подключает сервер. Подключение общее для
 *   каталога (location), но другие сессии его не видят: каталог Code Mode и <mcp_instructions>
 *   фильтруются по правам сессии.
 * - После перезапуска OpenCode серверы, включённые в сессии, подключаются при следующем промпте.
 *
 * Возвращает API для RPC и cleanup.
 */
export async function setup(ctx, logDir = LOG_DIR) {
  const log = async (line) => {
    await mkdir(logDir, { recursive: true })
    await appendFile(join(logDir, 'plugin.log'), `${new Date().toISOString()} ${line}\n`)
  }
  const logError = (where, error) => log(`ERROR ${where}: ${error?.stack ?? error}`).catch(() => {})
  const registrations = []
  const listeners = new Set()
  const notify = (sessionID) => { for (const listener of listeners) listener(sessionID) }
  // Сервер → сессии, которым он нужен. Плагин держит сервер включённым, пока список не пуст.
  // После перезапуска список собирается заново при промптах сессий.
  const holders = new Map()
  const settledServers = new Set()
  // Изменения прав одной сессии идут по очереди: иначе два быстрых переключения теряют друг друга.
  const sessionQueues = new Map()
  let servers = []
  // Родительская сессия → MCP для её следующих сабагентов. Задаёт сам агент инструментом mcp_subagents.
  const subagentServers = new Map()
  let catalogReady = Promise.resolve()

  registrations.push(await ctx.mcp.transform((editor) => {
    const names = editor.list().map(([name]) => name).toSorted()
    validateServers(names)
    // Источник правды о подключении — сессии, а не конфиг: проектный opencode.json (и его копии в worktree)
    // иначе подключает серверы в каждом каталоге, и каждое подключение запрашивает список инструментов.
    for (const name of names) editor.update(name, (config) => { config.disabled = !holders.has(name) })
    if (names.join('\n') === servers.join('\n')) return
    servers = names
    // Ранее сохранённый a_* может открыть новый a_b. До разрешения нового подключения
    // обновляем правила уже существующих сессий, включая не открытые в этом окне.
    catalogReady = catalogReady.then(reconcileCatalog, reconcileCatalog)
    void catalogReady.catch((error) => logError('catalog.reconcile', error))
    // Набор серверов изменился: перестроить запреты агентов. Не ждём, transform синхронный.
    ctx.agent.reload().catch((error) => logError('agent.reload', error))
  }))

  registrations.push(await ctx.agent.transform((editor) => {
    const deny = defaultDenyRules(servers)
    for (const agent of editor.list()) editor.update(agent.id, (draft) => { draft.permissions.push(...deny) })
  }))

  async function statuses() {
    const result = await ctx.mcp.list({ location: ctx.location })
    return new Map(result.data.map((server) => [server.name, server]))
  }

  async function hold(sessionID, names) {
    const added = names.filter((name) => !holders.has(name))
    for (const name of names) holders.set(name, (holders.get(name) ?? new Set()).add(sessionID))
    if (added.length > 0) await ctx.mcp.reload()
  }

  /** Отпускает сервер; последний освободивший выключает его в каталоге, и процесс сервера завершается. */
  async function release(sessionID, name) {
    const sessions = holders.get(name)
    if (sessions === undefined || !sessions.delete(sessionID) || sessions.size > 0) return
    holders.delete(name)
    settledServers.delete(name)
    await ctx.mcp.reload()
    await log(`released=${name}`)
  }

  /** Включает серверы в каталоге и ждёт окончания подключения. */
  async function connect(sessionID, names) {
    await hold(sessionID, names)
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    for (;;) {
      const current = await statuses()
      const pending = names.filter((name) => ['pending', 'disabled'].includes(current.get(name)?.status.status))
      if (pending.length === 0 || Date.now() > deadline) {
        const connected = names.filter((name) => current.get(name)?.status.status === 'connected')
        if (connected.some((name) => !settledServers.has(name))) {
          // Connected опережает обновление каталога инструментов OpenCode. Это касается
          // и подключения через GUI до промпта, не только восстановления в самом prompt hook.
          await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))
          for (const name of connected) settledServers.add(name)
        }
        return
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  async function sessionInLocation(sessionID) {
    const session = await ctx.session.get({ sessionID })
    if (session.location.directory !== ctx.location.directory) throw new LocationMismatchError('Session belongs to another location.')
    return session
  }

  function describe(enabled, current) {
    return servers.map((name) => {
      const server = current.get(name)
      // Сервер из конфигурации ещё не попал в список статусов: подключение не начиналось.
      const status = server?.status ?? { status: 'pending' }
      return {
        name,
        title: server?.title ?? null,
        integrationID: server?.integrationID ?? null,
        enabled: enabled.includes(name),
        status: status.status,
        error: status.status === 'failed' || status.status === 'needs_auth' ? status.error : null,
      }
    })
  }

  async function state(sessionID) {
    await readyCatalog()
    const session = await sessionInLocation(sessionID)
    return { servers: describe(enabledServers(session.permissions ?? [], servers), await statuses()) }
  }

  async function applyEnabled(sessionID, server, enabled) {
    if (!servers.includes(server)) throw new UnknownServerError(`Unknown MCP server: ${server}`)
    const session = await sessionInLocation(sessionID)
    const permissions = session.permissions ?? []
    const after = toggled(enabledServers(permissions, servers), server, enabled, servers)
    await ctx.session.update({ sessionID, permissions: withEnabled(permissions, after, servers) })
    await log(`session=${sessionID} enabled=${after.join(',') || '-'}`).catch((error) => logError('set.log', error))
    // Подключение идёт в фоне: статус придёт событием mcp.status.changed.
    if (enabled) await hold(sessionID, [server])
    else await release(sessionID, server)
    notify(sessionID)
    return { servers: describe(after, await statuses()) }
  }

  async function setEnabled(sessionID, server, enabled) {
    await readyCatalog()
    return serializeSession(sessionID, () => applyEnabled(sessionID, server, enabled))
  }

  function serializeSession(sessionID, action) {
    const previous = sessionQueues.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    sessionQueues.set(sessionID, next)
    void next.finally(() => { if (sessionQueues.get(sessionID) === next) sessionQueues.delete(sessionID) }).catch(() => {})
    return next
  }

  async function normalizeSession(sessionID, skipMoved = false) {
    const session = await ctx.session.get({ sessionID })
    if (session.location.directory !== ctx.location.directory) {
      if (skipMoved) return undefined
      throw new LocationMismatchError('Session belongs to another location.')
    }
    const permissions = withEnabled(session.permissions ?? [], enabledServers(session.permissions ?? [], servers), servers)
    if (JSON.stringify(permissions) !== JSON.stringify(session.permissions ?? [])) {
      await ctx.session.update({ sessionID, permissions })
    }
    return { ...session, permissions }
  }

  async function reconcileCatalog() {
    let cursor
    do {
      const page = await ctx.session.list({ directory: ctx.location.directory, ...(cursor === undefined ? {} : { cursor }) })
      for (const session of page.data) {
        if (session.location.directory !== ctx.location.directory || (session.permissions ?? []).length === 0) continue
        await serializeSession(session.id, () => normalizeSession(session.id, true))
      }
      cursor = page.cursor.next ?? undefined
    } while (cursor !== undefined)
  }

  /** Одна наблюдаемая повторная сверка на новый запрос, не бесконечный фоновый retry. */
  async function readyCatalog() {
    const attempt = catalogReady
    try {
      await attempt
    } catch (error) {
      if (catalogReady === attempt) {
        await logError('catalog.retry', error)
        catalogReady = attempt.then(reconcileCatalog, reconcileCatalog)
      }
      await catalogReady
    }
  }

  const events = new AbortController()
  void (async () => {
    for await (const event of ctx.event.subscribe({ types: ['mcp.status.changed'], signal: events.signal })) {
      if (event.type === 'mcp.status.changed') { settledServers.clear(); notify(null) }
    }
  })().catch((error) => { if (!events.signal.aborted) void logError('event.subscribe', error) })

  registrations.push(await ctx.tool.transform((editor) => {
    editor.add({
      name: 'mcp_subagents',
      options: { codemode: false },
      description: 'Выбрать MCP-серверы для сабагентов, которых ты запустишь после этого вызова. По умолчанию сабагент не видит ни одного MCP. '
        + 'Передавай только серверы, которые нужны его задаче; доступны только серверы, включённые в твоей сессии. '
        + 'Набор действует для всех следующих сабагентов этой сессии, пока ты не вызовешь инструмент снова; servers: [] — без MCP. '
        + 'Сабагентам с разными наборами задай набор и запусти их по очереди, а не одним параллельным батчем.',
      input: {
        type: 'object',
        properties: { servers: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } },
        required: ['servers'],
        additionalProperties: false,
      },
      execute: async ({ servers: requested }, context) => {
        const session = await sessionInLocation(context.sessionID)
        const available = enabledServers(session.permissions ?? [], servers)
        const unavailable = requested.filter((name) => !available.includes(name))
        if (unavailable.length > 0) {
          throw new Error(`Недоступны в этой сессии: ${unavailable.join(', ')}. Доступны: ${available.join(', ') || 'нет'}. `
            + 'Включить MCP может только пользователь в окне /mcp-session.')
        }
        subagentServers.set(context.sessionID, servers.filter((name) => requested.includes(name)))
        return { content: requested.length > 0 ? `Следующие сабагенты получат MCP: ${requested.join(', ')}.` : 'Следующие сабагенты будут без MCP.' }
      },
    })
  }))

  /** Первый промпт сабагента: выдать набор MCP, выбранный родителем. Возвращает права сессии. */
  async function grantSubagent(session) {
    if (session.parentID === undefined || session.parentID === null) return session.permissions ?? []
    const key = `child-initialized/${session.id}`
    if (await ctx.storage.get(key) === true) return session.permissions ?? []
    // Для детей, начатых до установки/обновления плагина, не переопределяем прежний выбор.
    if ((await ctx.session.context({ sessionID: session.id })).some((message) => message.type === 'user')) {
      await ctx.storage.set(key, true)
      return session.permissions ?? []
    }
    const parent = await ctx.session.get({ sessionID: session.parentID })
    const available = enabledServers(parent.permissions ?? [], servers)
    const granted = (subagentServers.get(session.parentID) ?? []).filter((name) => available.includes(name))
    const permissions = withEnabled(session.permissions ?? [], granted, servers)
    await ctx.session.update({ sessionID: session.id, permissions })
    await ctx.storage.set(key, true)
    await log(`subagent=${session.id} parent=${session.parentID} enabled=${granted.join(',')}`)
    return permissions
  }

  // Права сессии переживают перезапуск, а подключение — нет. Восстанавливаем его до ответа модели.
  registrations.push(await ctx.session.hook('prompt', async (event) => {
    try {
      await readyCatalog()
      const enabled = await serializeSession(event.sessionID, async () => {
        const session = await normalizeSession(event.sessionID)
        return enabledServers(await grantSubagent(session), servers)
      })
      const missing = enabled.filter((name) => !holders.has(name))
      if (enabled.length > 0) await connect(event.sessionID, enabled)
      if (missing.length > 0) {
        await log(`session=${event.sessionID} reconnected=${missing.join(',')}`)
      }
    } catch (error) {
      await logError(`prompt session=${event.sessionID}`, error)
      throw error
    }
  }))

  return {
    api: {
      state,
      setEnabled,
      onChange(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    log: logError,
    async cleanup() {
      events.abort()
      listeners.clear()
      for (const registration of [...registrations].reverse()) await registration.dispose()
    },
  }
}
