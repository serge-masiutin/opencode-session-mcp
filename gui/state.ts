import { createStore, reconcile } from 'solid-js/store'
import type { MountedSession } from '@opencode/plugin/gui'
import { SessionMcp } from '../rpc'
import type { SessionMcpState, SessionServer } from '../rpc'

/** Сессия, к которой обращается RPC: ключ включает location, потому что сервер плагина свой у каждого каталога. */
export interface Target {
  key: string
  id: string
  location: NonNullable<MountedSession['location']>
  server: MountedSession['server']
  /** Снимок только для обнаружения замены клиента и пересоздания подписки. */
  subscriptionClient: MountedSession['server']['client']
}

export function targetOf(session: MountedSession | undefined): Target | undefined {
  const location = session?.location
  if (session === undefined || location === undefined || session.pending) return undefined
  return { key: session.key, id: session.id, location, server: session.server, subscriptionClient: session.server.client }
}

export const sameTarget = (a: Target, b: Target) => a.key === b.key && a.location.directory === b.location.directory
  && a.subscriptionClient === b.subscriptionClient

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Последнее известное состояние MCP по сессиям, общее для диалога и плашки над полем ввода. */
export function createSessionStates() {
  const [states, setStates] = createStore<Record<string, SessionMcpState>>({})
  const generations = new Map<string, { directory: string; read: number; mutation: number }>()
  const generation = (target: Target) => {
    let current = generations.get(target.key)
    if (current === undefined || current.directory !== target.location.directory) {
      current = { directory: target.location.directory, read: 0, mutation: 0 }
      generations.set(target.key, current)
    }
    return current
  }
  const rpc = (target: Target) => target.server.client.rpc(SessionMcp)
  // Ответ проверяется сервером по output-схеме RPC; JSON Schema в SDK имеет TS-тип unknown.
  const store = (target: Target, result: unknown) => setStates(target.key, reconcile(result as SessionMcpState, { key: 'name' }))
  async function refresh(target: Target, signal?: AbortSignal) {
    const current = generation(target)
    const read = ++current.read
    const mutation = current.mutation
    const result = await rpc(target).state({ sessionID: target.id }, { location: target.location, signal })
    if (!signal?.aborted && generations.get(target.key) === current && read === current.read && mutation === current.mutation) store(target, result)
  }

  return {
    get: (key: string): SessionMcpState | undefined => states[key],
    refresh,
    async set(target: Target, server: string, enabled: boolean) {
      const current = generation(target)
      const mutation = ++current.mutation
      ++current.read
      try {
        const result = await rpc(target).set({ sessionID: target.id, server, enabled }, { location: target.location })
        if (generations.get(target.key) === current && mutation === current.mutation) {
          ++current.read
          store(target, result)
        }
      } catch (error) {
        if (generations.get(target.key) !== current) throw error
        try {
          await refresh(target)
        } catch (refreshError) {
          throw new AggregateError([error, refreshError], `${failureMessage(error)} Refresh failed: ${failureMessage(refreshError)}`)
        }
        throw error
      }
    },
    /** Подключает сервер в каталоге сессии: повтор после ошибки или после выключения во встроенном /mcp. */
    async connect(target: Target, server: string) {
      await target.server.client.mcp.connect({ server, location: target.location })
    },
    /** Начинает OAuth-вход и возвращает адрес страницы входа. Как встроенный диалог MCP. */
    async signInUrl(target: Target, server: SessionServer): Promise<string> {
      if (server.integrationID === null) throw new Error(`${server.name}: sign-in is not available for this server.`)
      const integration = await target.server.client.integration.get({ integrationID: server.integrationID, location: target.location })
      const method = integration.data?.methods.find((item) => item.type === 'oauth' && !item.form?.length)
      if (method === undefined || method.type !== 'oauth') throw new Error(`${server.name}: sign-in needs a form. Use the built-in /mcp dialog.`)
      const attempt = await target.server.client.integration.oauth.connect({
        integrationID: server.integrationID, methodID: method.id, location: target.location,
      })
      return attempt.data.url
    },
    /** Подписка на изменения этой сессии и статусов подключения в её каталоге. */
    watch(target: Target, onChange: () => void, signal: AbortSignal) {
      return rpc(target).events.on('updated', (event) => {
        const changed = event.data as { sessionID: string | null }
        if (event.location.directory !== target.location.directory) return
        if (changed.sessionID === null || changed.sessionID === target.id) onChange()
      }, { signal })
    },
  }
}

export type SessionStates = ReturnType<typeof createSessionStates>
