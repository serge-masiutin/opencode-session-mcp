import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { SessionMcpDialog } from '../../gui/dialog'
import '../../gui/dialog.css'
import './style.css'

// Песочница реального компонента с минимальным host API. Не подключает MCP или модели.
const [servers, setServers] = createSignal(Array.from({ length: 49 }, (_, index) => ({
  name: `example-server-${String(index + 1).padStart(2, '0')}`,
  title: index === 0 ? 'Очень длинное название сервера для проверки переполнения строки' : `Сервер ${index + 1}`,
  enabled: false, status: 'disabled' as const, error: null, integrationID: null,
})))
const ui = {
  Dialog: (props: any) => <section role="dialog" aria-label={props.title}>
    <h1>{props.title}</h1><p>{props.description}</p>
    <div class="fixture-body"><div class="fixture-host-scroll" data-scrollable>{props.children}</div></div>
  </section>,
  TextInput: (props: any) => <input type={props.type} aria-label={props.label} placeholder={props.placeholder}
    value={props.value} onInput={(e) => props.onInput(e.currentTarget.value)}
    onKeyDown={(e) => { if (e.key === 'Enter') props.onSubmit() }} />,
  Switch: (props: any) => <input type="checkbox" aria-label={props.label} checked={props.checked}
    disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.checked)} />,
  Button: (props: any) => <button onClick={props.onClick} disabled={props.busy}>{props.children}</button>,
  Tooltip: (props: any) => <span>{props.children}</span>,
  Loader: () => <span>Загрузка…</span>,
}
const ctx = { ui, t: (key: string, vars?: any) => key === 'dialog.count'
  ? `Включено ${vars.enabled} из ${vars.total}`
  : ({ 'dialog.title': 'MCP этой сессии', 'dialog.description': 'Серверы видит только эта сессия.', 'dialog.search': 'Найти сервер…' } as Record<string, string>)[key] ?? key,
  toast: { show: console.error }, system: { openExternal: () => { throw new Error('OAuth is not part of this fixture') } },
}
const states = {
  get: () => ({ servers: servers() }), refresh: async () => {},
  set: async (_: unknown, name: string, enabled: boolean) => setServers(servers().map((s) => s.name === name ? { ...s, enabled } : s)),
}
// Воспроизводит блокировку прокрутки модального host: вложенный список должен обработать
// нативный wheel до document. Без исправления колесо над строками не сдвигает список.
document.addEventListener('wheel', (event) => event.preventDefault(), { passive: false })
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') ?? 'light'
render(() => <SessionMcpDialog ctx={ctx as any} target={{ key: 'fixture' } as any} states={states as any} />, document.getElementById('app')!)
