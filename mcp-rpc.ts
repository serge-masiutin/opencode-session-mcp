import type { Plugin } from '@opencode/plugin'
import { LocationMismatchError, UnknownServerError } from './runtime.mjs'
import { SessionMcp } from './rpc'
import type { SessionMcpState } from './rpc'

type Context = Parameters<NonNullable<Parameters<typeof Plugin.define>[0]['setup']>>[0]
type ErrorCode = keyof typeof SessionMcp.methods.set.errors
type CallContext = { error: (type: ErrorCode, message: string, data: object) => unknown }

export interface SessionMcpApi {
  state(sessionID: string): Promise<SessionMcpState>
  setEnabled(sessionID: string, server: string, enabled: boolean): Promise<SessionMcpState>
  onChange(listener: (sessionID: string | null) => void): () => void
}

export async function registerSessionMcp(ctx: Context, api: SessionMcpApi, logError: (where: string, error: unknown) => Promise<void>) {
  async function invoke(method: string, sessionID: string, context: CallContext, action: () => Promise<SessionMcpState>) {
    try {
      return await action()
    } catch (error) {
      if (error instanceof UnknownServerError) return context.error('unknown_server', error.message, {})
      if (error instanceof LocationMismatchError) return context.error('unavailable', 'Session location changed. Reopen the dialog in that session.', {})
      await logError(`rpc.${method} session=${sessionID}`, error)
      return context.error('unavailable', method === 'set'
        ? 'Could not update session MCP servers. Some changes may have been applied. Refresh the state and try again.'
        : 'Could not load session MCP servers. Try again.', {})
    }
  }

  const registration = await ctx.rpc.register(SessionMcp, {
    state: (input, context) => invoke('state', input.sessionID, context, () => api.state(input.sessionID)),
    set: (input, context) => invoke('set', input.sessionID, context,
      () => api.setEnabled(input.sessionID, input.server, input.enabled)),
  })
  const unsubscribe = api.onChange((sessionID) => {
    void registration.events.emit('updated', { sessionID }).catch((error: unknown) => logError('rpc.notify', error))
  })
  return { dispose: async () => { unsubscribe(); await registration.dispose() } }
}
