import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { Context } from '@opencode/plugin/gui'
import type { SessionServer } from '../rpc'
import { failureMessage } from './state'
import type { SessionStates, Target } from './state'

export type Tone = 'success' | 'warning' | 'danger' | 'muted'
type Action = 'signIn' | 'retry'

/** Что показать про сервер в этой сессии: подпись (ключ i18n), цвет и доступное действие. */
export function presence(server: SessionServer): { label: string; tone: Tone; action?: Action } {
  if (!server.enabled) return { label: 'status.off', tone: 'muted' }
  switch (server.status) {
    case 'connected': return { label: 'status.connected', tone: 'success' }
    case 'failed': return { label: 'status.failed', tone: 'danger', action: 'retry' }
    case 'needs_auth': return server.integrationID === null
      ? { label: 'status.needsAuth', tone: 'warning' }
      : { label: 'status.needsAuth', tone: 'warning', action: 'signIn' }
    // disabled у включённого сервера — подключение ещё не началось или его выключили во встроенном /mcp;
    // плашка над полем ввода подключает такой сервер сама.
    case 'pending': case 'disabled': return { label: 'status.connecting', tone: 'warning' }
  }
}

/** Порядок фиксируется при первой загрузке: включённые сверху. Переключение не двигает строки. */
function initialOrder(servers: readonly SessionServer[]): string[] {
  return servers.toSorted((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)).map((server) => server.name)
}

interface Props {
  ctx: Context
  target: Target
  states: SessionStates
}

export function SessionMcpDialog(props: Props) {
  const { ctx, target, states } = props
  const ui = ctx.ui
  const [query, setQuery] = createSignal('')
  const [error, setError] = createSignal('')
  // Желаемое положение переключателя, пока сервер плагина не ответил.
  const [pending, setPending] = createSignal<Record<string, boolean>>({})
  const [acting, setActing] = createSignal<Record<string, true>>({})
  const [order, setOrder] = createSignal<string[]>()
  const lifetime = new AbortController()
  onCleanup(() => lifetime.abort())

  const servers = () => states.get(target.key)?.servers
  const load = () => {
    setError('')
    states.refresh(target, lifetime.signal)
      .then(() => { if (order() === undefined) setOrder(initialOrder(servers() ?? [])) })
      .catch((cause: unknown) => { if (!lifetime.signal.aborted) setError(failureMessage(cause)) })
  }
  onMount(load)

  const enabledCount = () => servers()?.filter((server) => server.enabled).length ?? 0
  const visible = createMemo(() => {
    const list = servers() ?? []
    const rank = new Map((order() ?? []).map((name, index) => [name, index]))
    const sorted = list.toSorted((a, b) => (rank.get(a.name) ?? rank.size) - (rank.get(b.name) ?? rank.size) || a.name.localeCompare(b.name))
    const needle = query().trim().toLowerCase()
    return needle === '' ? sorted : sorted.filter((server) =>
      server.name.toLowerCase().includes(needle) || (server.title ?? '').toLowerCase().includes(needle))
  })

  async function toggle(server: SessionServer, enabled: boolean) {
    if (pending()[server.name] !== undefined) return
    setPending((current) => ({ ...current, [server.name]: enabled }))
    try {
      await states.set(target, server.name, enabled)
    } catch (cause) {
      ctx.toast.show({ variant: 'error', title: ctx.t('toggle.failed', { name: server.name }), description: failureMessage(cause) })
    } finally {
      setPending(({ [server.name]: _, ...rest }) => rest)
    }
  }

  async function act(server: SessionServer, action: Action) {
    if (acting()[server.name]) return
    setActing((current) => ({ ...current, [server.name]: true }))
    try {
      if (action === 'retry') await states.connect(target, server.name)
      else ctx.system.openExternal(await states.signInUrl(target, server))
    } catch (cause) {
      ctx.toast.show({ variant: 'error', title: ctx.t(`${action}.failed`, { name: server.name }), description: failureMessage(cause) })
    } finally {
      setActing(({ [server.name]: _, ...rest }) => rest)
    }
  }

  const submitSearch = () => {
    const only = visible()
    if (only.length === 1) void toggle(only[0], !(pending()[only[0].name] ?? only[0].enabled))
  }

  return <ui.Dialog title={ctx.t('dialog.title')} description={ctx.t('dialog.description')} size="large">
    <div class="smcp">
      <div class="smcp-toolbar">
        <div class="smcp-search">
          <ui.TextInput label={ctx.t('dialog.search')} placeholder={ctx.t('dialog.search')} type="search"
            value={query()} onInput={setQuery} onSubmit={submitSearch} autofocus />
        </div>
        <Show when={servers()}>
          {(list) => <span class="smcp-count" role="status">
            {ctx.t('dialog.count', { enabled: enabledCount(), total: list().length })}
          </span>}
        </Show>
      </div>
      <Show when={error()}>
        <div class="smcp-error" role="alert">
          <span>{error()}</span>
          <ui.Button size="small" variant="ghost" onClick={load}>{ctx.t('common.retry')}</ui.Button>
        </div>
      </Show>
      <div class="smcp-scroll" data-scrollable
        // Нативный listener срабатывает до document scroll-lock диалога. Обычный onWheel в Solid
        // делегируется на document: к этому моменту lock уже может отменить прокрутку списка.
        on:wheel={{ handleEvent: (event: WheelEvent) => event.stopPropagation(), passive: true }}
        on:touchmove={{ handleEvent: (event: TouchEvent) => event.stopPropagation(), passive: true }}>
        <Show when={servers()} fallback={<Show when={!error()}><div class="smcp-state"><ui.Loader /></div></Show>}>
          <Show when={visible().length > 0} fallback={<p class="smcp-state">{ctx.t(servers()!.length > 0 ? 'dialog.noMatches' : 'dialog.empty')}</p>}>
            <ul class="smcp-list">
              <For each={visible()}>
                {(server) => {
                  const shown = () => presence(server)
                  const checked = () => pending()[server.name] ?? server.enabled
                  const busy = () => pending()[server.name] !== undefined
                  const status = () => <span class="smcp-status" data-tone={shown().tone}>{ctx.t(shown().label)}</span>
                  return <li class="smcp-row" data-enabled={checked() ? '' : undefined} data-busy={busy() ? '' : undefined}
                    onClick={() => void toggle(server, !checked())}>
                    <span class="smcp-dot" data-tone={shown().tone} data-pending={shown().label === 'status.connecting' ? '' : undefined} aria-hidden="true" />
                    <span class="smcp-name">
                      <span class="smcp-server">{server.name}</span>
                      <Show when={server.title !== null && server.title !== server.name}>
                        <span class="smcp-title">{server.title}</span>
                      </Show>
                    </span>
                    <span class="smcp-trailing" onClick={(event) => event.stopPropagation()}>
                      <Show when={server.enabled}>
                        <Show when={server.error} fallback={status()}>
                          {(message) => <ui.Tooltip value={<span class="smcp-tooltip">{message()}</span>} placement="left">{status()}</ui.Tooltip>}
                        </Show>
                      </Show>
                      <Show when={shown().action}>
                        {(action) => <ui.Button size="small" variant="ghost" busy={acting()[server.name] === true}
                          onClick={() => void act(server, action())}>{ctx.t(`action.${action()}`)}</ui.Button>}
                      </Show>
                      <ui.Switch label={server.name} hideLabel disabled={busy()} checked={checked()}
                        onChange={(enabled) => void toggle(server, enabled)} />
                    </span>
                  </li>
                }}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </div>
  </ui.Dialog>
}
