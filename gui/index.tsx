import { createEffect, onCleanup } from 'solid-js'
import { Command, ComposerPill, Plugin, Style, createKeyed } from '@opencode/plugin/gui'
import type { ComposerPillTone, ComposerPillView } from '@opencode/plugin/gui'
import { SessionMcpDialog, presence } from './dialog'
import type { Tone } from './dialog'
import { createSessionStates, failureMessage, sameTarget, targetOf } from './state'
import type { Target } from './state'
import { i18n } from './i18n'
import type { SessionServer } from '../rpc'
import css from './dialog.css?inline'

const pillTone = (tone: Tone): ComposerPillTone | undefined => tone === 'muted' ? undefined : tone

export default Plugin.define({
  i18n,
  setup(ctx) {
    const states = createSessionStates()
    ctx.add(Style, css)

    // Состояние текущей сессии держим свежим: оно нужно плашке над полем ввода.
    createKeyed(() => targetOf(ctx.sessions.current()), (target) => {
      const lifetime = new AbortController()
      onCleanup(() => lifetime.abort())
      const refresh = () => void states.refresh(target, lifetime.signal).catch(() => {
        // Плашка необязательна: без состояния она просто не показывается, а диалог покажет ошибку сам.
      })
      refresh()
      onCleanup(states.watch(target, refresh, lifetime.signal))
      // Сервер включён в сессии, но выключен в каталоге (например, во встроенном /mcp): подключаем снова.
      // Один запрос на сервер, пока статус не сменится.
      const healing = new Set<string>()
      createEffect(() => {
        for (const server of states.get(target.key)?.servers ?? []) {
          if (!server.enabled || server.status !== 'disabled') { healing.delete(server.name); continue }
          if (healing.has(server.name)) continue
          healing.add(server.name)
          states.connect(target, server.name).catch((cause: unknown) => ctx.toast.show({
            variant: 'error', title: ctx.t('retry.failed', { name: server.name }), description: failureMessage(cause),
          }))
        }
      })
    }, { equals: sameTarget })

    const open = (target: Target) => ctx.dialogs.open((dialog) =>
      <SessionMcpDialog ctx={ctx} target={target} states={states} />)
    const act = (target: Target, server: SessionServer, action: 'signIn' | 'retry') => void (action === 'retry'
      ? states.connect(target, server.name)
      : states.signInUrl(target, server).then((url) => ctx.system.openExternal(url))
    ).catch((cause: unknown) => ctx.toast.show({
      variant: 'error', title: ctx.t(`${action}.failed`, { name: server.name }), description: failureMessage(cause),
    }))
    const openCurrent = () => {
      const target = targetOf(ctx.sessions.current())
      if (target) open(target)
    }

    ctx.add(Command, (): Command => ({
      id: 'open',
      title: ctx.t('command.title'),
      description: ctx.t('command.description'),
      keywords: 'mcp session servers tools',
      section: 'session',
      slash: { name: 'mcp-session', after: 'mcp' },
      enabled: targetOf(ctx.sessions.current()) !== undefined,
      run: openCurrent,
    }))

    ctx.add(ComposerPill, {
      id: 'servers',
      show: (input): ComposerPillView | undefined => {
        const target = targetOf(input.session)
        const enabled = (target && states.get(target.key)?.servers.filter((server) => server.enabled)) || []
        if (target === undefined || enabled.length === 0) return undefined
        const tones = enabled.map((server) => presence(server).tone)
        const tone = tones.includes('danger') ? 'danger' : tones.includes('warning') ? 'warning' : 'success'
        return {
          icon: 'mcp',
          label: enabled.length === 1 ? `MCP · ${enabled[0].name}` : ctx.plural('pill.label', enabled.length),
          tone: pillTone(tone),
          title: ctx.t('pill.title'),
          rows: [
            ...enabled.map((server) => {
              const shown = presence(server)
              return {
                id: server.name, label: server.name, icon: 'mcp' as const,
                tone: pillTone(shown.tone),
                detail: shown.action ? `${ctx.t(shown.label)} · ${ctx.t(`action.${shown.action}`)}` : ctx.t(shown.label),
                run: () => shown.action ? act(target, server, shown.action) : open(target),
              }
            }),
            { id: 'configure', label: ctx.t('pill.configure'), icon: 'settings-gear' as const, run: () => open(target) },
          ],
        }
      },
    })
  },
})
