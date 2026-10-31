import { Rpc } from '@opencode/plugin/rpc'

export type ServerStatus = 'connected' | 'pending' | 'disabled' | 'failed' | 'needs_auth'
export interface SessionServer {
  name: string
  title: string | null
  /** OAuth-интеграция удалённого сервера: через неё проходит вход. */
  integrationID: string | null
  enabled: boolean
  status: ServerStatus
  error: string | null
}
export interface SessionMcpState {
  servers: SessionServer[]
}

// JSON Schema в SDK 2.2.0 удаляет лишние поля вместо отказа. Standard Schema держит строгую границу.
function strictInput<T>(fields: Record<keyof T, (value: unknown) => boolean>) {
  return {
    '~standard': {
      version: 1 as const, vendor: 'session-mcp',
      types: undefined as { input: T; output: T } | undefined,
      validate(value: unknown) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected an object.' }] }
        const record = value as Record<string, unknown>
        const unexpected = Object.keys(record).find((key) => !Object.hasOwn(fields, key))
        if (unexpected !== undefined) return { issues: [{ message: 'Unknown field.', path: [unexpected] }] }
        for (const key of Object.keys(fields) as (keyof T & string)[]) {
          if (!Object.hasOwn(record, key) || !fields[key](record[key])) return { issues: [{ message: 'Invalid or missing field.', path: [key] }] }
        }
        return { value: value as T }
      },
    },
  }
}

const isSessionID = (value: unknown) => typeof value === 'string' && value.length <= 256 && /^ses_[a-zA-Z0-9]+$/.test(value)
const isServerName = (value: unknown) => typeof value === 'string' && value.length >= 1 && value.length <= 256

const nullableText = { type: ['string', 'null'] } as const
const state = {
  type: 'object',
  properties: {
    servers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, title: nullableText, integrationID: nullableText, enabled: { type: 'boolean' },
          status: { type: 'string', enum: ['connected', 'pending', 'disabled', 'failed', 'needs_auth'] },
          error: nullableText,
        },
        required: ['name', 'title', 'integrationID', 'enabled', 'status', 'error'], additionalProperties: false,
      },
    },
  },
  required: ['servers'], additionalProperties: false,
} as const
const errors = {
  unknown_server: { type: 'object', additionalProperties: false },
  unavailable: { type: 'object', additionalProperties: false },
} as const

/** MCP-серверы, видимые конкретной сессии. Источник правды — права сессии на сервере OpenCode. */
export const SessionMcp = Rpc.define({
  id: 'local-session-mcp.servers',
  methods: {
    state: {
      input: strictInput<{ sessionID: string }>({ sessionID: isSessionID }),
      output: state, errors,
    },
    set: {
      input: strictInput<{ sessionID: string; server: string; enabled: boolean }>({
        sessionID: isSessionID, server: isServerName, enabled: (value) => typeof value === 'boolean',
      }),
      output: state, errors,
    },
  },
  events: {
    // sessionID: null — изменился статус подключения сервера, это касается всех сессий каталога.
    updated: { schema: { type: 'object', properties: { sessionID: { type: ['string', 'null'] } }, required: ['sessionID'], additionalProperties: false } },
  },
})
