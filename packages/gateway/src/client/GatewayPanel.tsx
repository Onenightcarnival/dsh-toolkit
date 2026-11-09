/**
 * Sidebar panel of the gateway: one header with the listener state and three
 * tabs (overview, keys, usage). Key model allowlists are picked in a
 * provider → model tree dialog; the usage tab is filters, metrics, detail table.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GatewayApi } from './api.ts'
import { tt, type Key } from './locales.ts'
import { formatCompact, formatNumber } from './format.ts'
import { DETAIL_LIMIT, type ApiKeyView, type GatewayModel, type GatewaySettings, type GatewayStatus, type UsageFilter, type UsageRange, type UsageSummary } from '../protocol.ts'

const TABS = ['overview', 'keys', 'usage'] as const
type Tab = typeof TABS[number]
const TAB_KEY = 'dsh-gateway:tab'
const RANGES = ['today', '7d', '30d'] as const
const PROTOCOLS = ['chat', 'responses', 'messages'] as const

type Notice = { kind: 'ok' | 'err' | 'info'; text: string }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const formatCost = (value: number | null): string => value === null ? '—' : value.toFixed(value >= 1 ? 2 : 4)
const formatTime = (time: number): string => new Date(time).toLocaleString()
const copyText = (text: string): Promise<void> => navigator.clipboard.writeText(text)

function readTab(): Tab {
  try {
    const stored = localStorage.getItem(TAB_KEY)
    return (TABS as readonly string[]).includes(stored ?? '') ? stored as Tab : 'overview'
  } catch {
    return 'overview'
  }
}

interface Shared {
  api: GatewayApi
  status: GatewayStatus
  busy: boolean
  run: (action: () => Promise<void>, ok?: string) => Promise<void>
  refresh: () => Promise<void>
  save: (patch: Partial<GatewaySettings>) => Promise<void>
}

export function GatewayPanel({ api, close }: { api: GatewayApi; close: () => void }): JSX.Element {
  const [status, setStatus] = useState<GatewayStatus>()
  const [notice, setNotice] = useState<Notice>()
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>(readTab)
  useEffect(() => { try { localStorage.setItem(TAB_KEY, tab) } catch { /* optional */ } }, [tab])
  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status())
    } catch (error) {
      setNotice({ kind: 'err', text: tt('error.generic', { message: message(error) }) })
    }
  }, [api])
  useEffect(() => { void refresh() }, [refresh])

  const run = async (action: () => Promise<void>, ok?: string): Promise<void> => {
    setBusy(true)
    try {
      await action()
      setNotice(ok === undefined ? undefined : { kind: 'ok', text: ok })
    } catch (error) {
      setNotice({ kind: 'err', text: tt('error.generic', { message: message(error) }) })
    } finally {
      setBusy(false)
    }
  }
  const save = (patch: Partial<GatewaySettings>): Promise<void> => run(async () => {
    if (status === undefined) return
    setStatus(await api.saveSettings({ ...status.settings, ...patch }))
  }, tt('saved'))

  const state = status === undefined ? undefined
    : status.listening ? { className: 'gw-badge on', text: tt('listener.state.on', { url: `http://${status.listening.host}:${status.listening.port}/v1` }) }
    : status.listenError ? { className: 'gw-badge err', text: tt('listener.state.error', { error: status.listenError }) }
    : { className: 'gw-badge', text: tt('listener.state.off') }

  return <div className="gw-app">
    <div className="gw-top">
      <h1>{tt('title')}</h1>
      {state && <span className={state.className} title={state.text}>{state.text}</span>}
      <span className="gw-grow" />
      <button disabled={busy} onClick={() => { void refresh() }}>{tt('refresh')}</button>
      <button className="gw-close" aria-label={tt('close')} title={tt('close')} onClick={close}>×</button>
    </div>
    <div className="gw-tabs" role="tablist" aria-label={tt('title')}>
      {TABS.map(value => <button key={value} role="tab" id={`gw-tab-${value}`} aria-selected={tab === value} aria-controls={`gw-panel-${value}`} onClick={() => setTab(value)}>{tt(`tab.${value}` as Key)}</button>)}
    </div>
    <div className="gw-body" role="tabpanel" id={`gw-panel-${tab}`} aria-labelledby={`gw-tab-${tab}`}>
      {notice && <p role={notice.kind === 'err' ? 'alert' : 'status'} className={`gw-notice ${notice.kind === 'info' ? '' : notice.kind}`}>{notice.text}</p>}
      {status === undefined
        ? <p className="gw-empty">{tt('loading')}</p>
        : tab === 'overview' ? <OverviewTab api={api} status={status} busy={busy} run={run} refresh={refresh} save={save} />
          : tab === 'keys' ? <KeysTab api={api} status={status} busy={busy} run={run} refresh={refresh} save={save} />
            : <UsageTab api={api} status={status} />}
    </div>
  </div>
}

function OverviewTab({ status, busy, save }: Shared): JSX.Element {
  const [draft, setDraft] = useState({ enabled: status.settings.enabled, host: status.settings.host, port: status.settings.port })
  useEffect(() => { setDraft({ enabled: status.settings.enabled, host: status.settings.host, port: status.settings.port }) }, [status])
  const stateClass = status.listening ? 'gw-notice ok' : status.listenError ? 'gw-notice err' : 'gw-notice'
  const stateText = status.listening
    ? tt('listener.state.on', { url: `http://${status.listening.host}:${status.listening.port}/v1` })
    : status.listenError ? tt('listener.state.error', { error: status.listenError }) : tt('listener.state.off')
  return <>
    <div className="gw-card">
      <h2>{tt('listener.title')}</h2>
      <p className={stateClass}>{stateText}</p>
      <label className="gw-switch"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />{tt('listener.enabled')}</label>
      <div className="gw-row">
        <label className="gw-field">{tt('listener.host')}<input className="gw-mono" style={{ width: 220 }} value={draft.host} onChange={e => setDraft({ ...draft, host: e.target.value })} spellCheck={false} /></label>
        <label className="gw-field">{tt('listener.port')}<input className="gw-mono" style={{ width: 110 }} value={String(draft.port)} onChange={e => setDraft({ ...draft, port: Number(e.target.value) })} inputMode="numeric" /></label>
      </div>
      <p className="gw-hint">{tt('listener.hostHint')}</p>
      <div className="gw-row"><button className="gw-primary" disabled={busy} onClick={() => { void save(draft) }}>{tt('save')}</button></div>
    </div>
    <div className="gw-card">
      <h2>{tt('listener.endpoints')}</h2>
      <div className="gw-table-wrap"><table><tbody>
        <tr><td><code className="gw-code">GET /v1/models</code></td><td>{tt('endpoint.models')}</td></tr>
        <tr><td><code className="gw-code">POST /v1/chat/completions</code></td><td>{tt('endpoint.chat')}</td></tr>
        <tr><td><code className="gw-code">POST /v1/responses</code></td><td>{tt('endpoint.responses')}</td></tr>
        <tr><td><code className="gw-code">POST /v1/messages</code></td><td>{tt('endpoint.messages')}</td></tr>
      </tbody></table></div>
      <p className="gw-hint">{tt('endpoint.authHint')}</p>
    </div>
    <div className="gw-stats">
      <div className="gw-stat"><div className="gw-stat-label">{tt('models.title')}</div><div className="gw-stat-value">{status.models.length}</div></div>
      <div className="gw-stat"><div className="gw-stat-label">{tt('keys.title')}</div><div className="gw-stat-value">{status.keys.filter(key => key.enabled).length} / {status.keys.length}</div></div>
    </div>
  </>
}

/** Allowlist summary shown on a picker button: all models, or a count. */
function allowlistLabel(models: string[] | null): string {
  return models === null ? tt('keys.modelsAll') : tt('keys.modelsCount', { count: models.length })
}

interface ProviderGroup { provider: string; name: string; models: GatewayModel[] }

function groupByProvider(models: GatewayModel[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>()
  for (const model of models) {
    const group = groups.get(model.provider) ?? { provider: model.provider, name: model.providerName, models: [] }
    group.models.push(model)
    groups.set(model.provider, group)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Provider → model tree with checkboxes. A provider box selects or clears
 * every model under it and shows the partial state. An empty selection means
 * every model and is handed back as `null`.
 */
function ModelPicker({ models, selected, onClose, onConfirm }: { models: GatewayModel[]; selected: string[] | null; onClose: () => void; onConfirm: (models: string[] | null) => void }): JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selected ?? []))
  const [query, setQuery] = useState('')
  const groups = useMemo(() => groupByProvider(models), [models])
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // One provider opens by itself; otherwise providers with a picked model open.
    if (groups.length <= 1) return new Set(groups.map(group => group.provider))
    const initial = new Set(selected ?? [])
    return new Set(groups.filter(group => group.models.some(model => initial.has(model.id))).map(group => group.provider))
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [onClose])
  const known = useMemo(() => new Set(models.map(model => model.id)), [models])
  // Ids of a stored allowlist that the host no longer offers stay selectable so saving does not drop them silently.
  const stale = [...picked].filter(id => !known.has(id))
  const needle = query.trim().toLowerCase()
  const visible = (model: GatewayModel): boolean => needle === '' || `${model.id} ${model.name} ${model.providerName}`.toLowerCase().includes(needle)
  const toggleModel = (id: string): void => setPicked(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const toggleGroup = (group: ProviderGroup, on: boolean): void => setPicked(current => {
    const next = new Set(current)
    for (const model of group.models) { if (on) next.add(model.id); else next.delete(model.id) }
    return next
  })
  const toggleExpanded = (provider: string): void => setExpanded(current => {
    const next = new Set(current)
    if (next.has(provider)) next.delete(provider)
    else next.add(provider)
    return next
  })
  return <div className="gw-overlay" onClick={onClose}>
    <div className="gw-dialog" role="dialog" aria-modal="true" aria-labelledby="gw-picker-title" onClick={event => event.stopPropagation()}>
      <div className="gw-row between">
        <h2 id="gw-picker-title">{tt('keys.pickTitle')}</h2>
        <button className="gw-close" aria-label={tt('close')} onClick={onClose}>×</button>
      </div>
      <p className="gw-hint">{tt('keys.pickHint')}</p>
      <div className="gw-row between">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder={tt('keys.search')} spellCheck={false} style={{ flex: 1, minWidth: 160 }} />
        <button className="gw-small" onClick={() => setPicked(new Set())} disabled={picked.size === 0}>{tt('keys.pickAll')}</button>
      </div>
      <div className="gw-list">
        {models.length === 0 && <p className="gw-empty" style={{ padding: 12 }}>{tt('models.empty')}</p>}
        {groups.map(group => {
          const shown = group.models.filter(visible)
          if (shown.length === 0) return null
          const pickedCount = group.models.filter(model => picked.has(model.id)).length
          const all = pickedCount === group.models.length
          const open = needle !== '' || expanded.has(group.provider)
          return <div key={group.provider} role="group" aria-label={group.name}>
            <div className="gw-group-head">
              <button className="gw-caret" aria-label={open ? tt('keys.pickCollapse') : tt('keys.pickExpand')} aria-expanded={open} onClick={() => toggleExpanded(group.provider)}>{open ? '▾' : '▸'}</button>
              <label className="gw-group-label">
                <input type="checkbox" checked={all} ref={el => { if (el) el.indeterminate = !all && pickedCount > 0 }} onChange={e => toggleGroup(group, e.target.checked)} />
                <span>{group.name}</span>
                <span className="gw-group-count">{tt('keys.pickGroupCount', { picked: pickedCount, total: group.models.length })}</span>
              </label>
            </div>
            {open && shown.map(model => <label key={model.id} className="gw-check-row child">
              <input type="checkbox" checked={picked.has(model.id)} onChange={() => toggleModel(model.id)} />
              <span className="gw-check-main"><span className="gw-mono">{model.id}</span><span className="gw-hint">{model.name}</span></span>
            </label>)}
          </div>
        })}
        {stale.map(id => <label key={id} className="gw-check-row off">
          <input type="checkbox" checked onChange={() => toggleModel(id)} />
          <span className="gw-check-main"><span className="gw-mono">{id}</span><span className="gw-hint">{tt('keys.pickStale')}</span></span>
        </label>)}
      </div>
      <div className="gw-row between">
        <span className="gw-hint">{allowlistLabel(picked.size === 0 ? null : [...picked])}</span>
        <span className="gw-row">
          <button onClick={onClose}>{tt('cancel')}</button>
          <button className="gw-primary" onClick={() => onConfirm(picked.size === 0 ? null : [...picked])}>{tt('confirm')}</button>
        </span>
      </div>
    </div>
  </div>
}

function KeysTab({ api, status, busy, run, refresh }: Shared): JSX.Element {
  const [name, setName] = useState('')
  const [models, setModels] = useState<string[] | null>(null)
  const [created, setCreated] = useState<string>()
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string>()
  /** Picker target: the creation form, or an existing key. */
  const [picker, setPicker] = useState<{ target: 'new' } | { target: ApiKeyView }>()
  const forget = (id: string): void => setRevealed(current => { const next = { ...current }; delete next[id]; return next })
  const create = (): Promise<void> => run(async () => {
    const result = await api.createKey(name.trim() === '' ? 'key' : name.trim(), models)
    setCreated(result.key)
    setName('')
    setModels(null)
    await refresh()
  })
  const toggle = (key: ApiKeyView): Promise<void> => run(async () => { await api.updateKey(key.id, { enabled: !key.enabled }); await refresh() })
  const remove = (key: ApiKeyView): Promise<void> => run(async () => {
    if (!window.confirm(tt('keys.deleteConfirm'))) return
    await api.deleteKey(key.id)
    forget(key.id)
    await refresh()
  })
  const reveal = (key: ApiKeyView): Promise<void> => run(async () => {
    if (revealed[key.id] !== undefined) { forget(key.id); return }
    const result = await api.revealKey(key.id)
    setRevealed(current => ({ ...current, [key.id]: result.key }))
  })
  const copy = (key: ApiKeyView): Promise<void> => run(async () => {
    const value = revealed[key.id] ?? (await api.revealKey(key.id)).key
    await copyText(value)
    setCopied(key.id)
    setTimeout(() => setCopied(current => current === key.id ? undefined : current), 1500)
  })
  const confirmPicker = (next: string[] | null): void => {
    const current = picker
    setPicker(undefined)
    if (current === undefined) return
    if (current.target === 'new') { setModels(next); return }
    const key = current.target
    void run(async () => { await api.updateKey(key.id, { models: next }); await refresh() }, tt('saved'))
  }
  return <>
    <div className="gw-card">
      <h2>{tt('keys.title')}</h2>
      {created && <p className="gw-notice ok">{tt('keys.created')} <code className="gw-code">{created}</code> <button className="gw-small" onClick={() => { void copyText(created) }}>{tt('keys.copy')}</button></p>}
      {status.keys.length === 0
        ? <p className="gw-empty">{tt('keys.empty')}</p>
        : <div className="gw-table-wrap"><table><thead><tr><th>{tt('keys.name')}</th><th>{tt('usage.key')}</th><th>{tt('keys.models')}</th><th>{tt('keys.lastUsed')}</th><th></th></tr></thead>
          <tbody>{status.keys.map(key => <tr key={key.id} className={key.enabled ? undefined : 'off'}>
            <td>{key.name}{key.enabled ? '' : ` (${tt('keys.disabled')})`}</td>
            <td className="gw-mono">{revealed[key.id] ?? `${key.prefix}…`}</td>
            <td><button className="gw-small" disabled={busy} title={key.models === null ? undefined : key.models.join(', ')} onClick={() => setPicker({ target: key })}>{allowlistLabel(key.models)} ▾</button></td>
            <td>{key.lastUsedAt === null ? tt('keys.never') : formatTime(key.lastUsedAt)}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button className="gw-small" disabled={busy} onClick={() => { void reveal(key) }}>{revealed[key.id] === undefined ? tt('keys.reveal') : tt('keys.hide')}</button>{' '}
              <button className="gw-small" disabled={busy} onClick={() => { void copy(key) }}>{copied === key.id ? tt('keys.copied') : tt('keys.copy')}</button>{' '}
              <button className="gw-small" disabled={busy} onClick={() => { void toggle(key) }}>{key.enabled ? tt('keys.disable') : tt('keys.enable')}</button>{' '}
              <button className="gw-small gw-danger" disabled={busy} onClick={() => { void remove(key) }}>{tt('keys.delete')}</button>
            </td>
          </tr>)}</tbody></table></div>}
    </div>
    <div className="gw-card">
      <h2>{tt('keys.create')}</h2>
      <div className="gw-row">
        <label className="gw-field">{tt('keys.name')}<input style={{ width: 180 }} value={name} onChange={e => setName(e.target.value)} /></label>
        <div className="gw-field">{tt('keys.models')}<button disabled={busy} title={models === null ? undefined : models.join(', ')} onClick={() => setPicker({ target: 'new' })}>{allowlistLabel(models)} ▾</button></div>
        <button className="gw-primary" style={{ alignSelf: 'flex-end' }} disabled={busy} onClick={() => { void create() }}>{tt('keys.create')}</button>
      </div>
      <p className="gw-hint">{tt('keys.modelsHint')}</p>
    </div>
    {picker && <ModelPicker models={status.models} selected={picker.target === 'new' ? models : picker.target.models} onClose={() => setPicker(undefined)} onConfirm={confirmPicker} />}
  </>
}

/** Usage summary of a range and filter, refetched when either changes. */
function useUsage(api: GatewayApi, range: UsageRange, filter: UsageFilter): { summary?: UsageSummary; error: string } {
  const [summary, setSummary] = useState<UsageSummary>()
  const [error, setError] = useState('')
  const key = JSON.stringify(filter)
  useEffect(() => {
    let active = true
    api.usage(range, JSON.parse(key) as UsageFilter).then(next => { if (active) { setSummary(next); setError('') } }, (reason: unknown) => { if (active) setError(message(reason)) })
    return () => { active = false }
  }, [api, range, key])
  return { summary, error }
}

/** Filter select: the current value stays listed even when the range no longer carries it. */
function FilterSelect({ label, value, options, onChange }: { label: string; value: string | undefined; options: Array<{ value: string; label: string }>; onChange: (value: string | undefined) => void }): JSX.Element {
  const listed = value === undefined || options.some(option => option.value === value) ? options : [...options, { value, label: value }]
  return <label className="gw-field">{label}
    <select value={value ?? ''} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)}>
      <option value="">{tt('usage.filter.all')}</option>
      {listed.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>
}

function UsageTab({ api, status }: { api: GatewayApi; status: GatewayStatus }): JSX.Element {
  const [range, setRange] = useState<UsageRange>('today')
  const [filter, setFilter] = useState<UsageFilter>({})
  const { summary, error } = useUsage(api, range, filter)
  const totals = summary?.totals
  const cost = totals !== undefined && totals.cost !== null
  const patch = (next: Partial<UsageFilter>): void => setFilter(current => {
    const merged = { ...current, ...next }
    for (const field of Object.keys(merged) as Array<keyof UsageFilter>) if (merged[field] === undefined) delete merged[field]
    return merged
  })
  const keyName = (id: string): string => summary?.facets.keys.find(key => key.id === id)?.name ?? status.keys.find(key => key.id === id)?.name ?? id
  const facets = summary?.facets ?? { keys: status.keys.map(key => ({ id: key.id, name: key.name })), models: status.models.map(model => model.id), protocols: [...PROTOCOLS] }
  const metric = (key: Key, value: number): [Key, string, string] => [key, formatCompact(value), formatNumber(value)]
  const cards: Array<[Key, string, string]> = totals === undefined ? [] : [
    metric('usage.requests', totals.requests), metric('usage.errors', totals.errors),
    metric('usage.input', totals.inputTokens), metric('usage.output', totals.outputTokens),
    metric('usage.cacheRead', totals.cacheReadTokens), metric('usage.reasoning', totals.reasoningTokens),
    ...cost ? [['usage.cost', formatCost(totals.cost), formatCost(totals.cost)] as [Key, string, string]] : [],
  ]
  const active = Object.keys(filter).length > 0
  return <>
    <div className="gw-filters">
      <div className="gw-field">{tt('usage.title')}<div className="gw-ranges">{RANGES.map(value => <button key={value} className="gw-small" aria-pressed={value === range} onClick={() => setRange(value)}>{tt(`usage.range.${value}`)}</button>)}</div></div>
      <FilterSelect label={tt('usage.filter.key')} value={filter.keyId} options={facets.keys.map(key => ({ value: key.id, label: key.name }))} onChange={value => patch({ keyId: value })} />
      <FilterSelect label={tt('usage.filter.model')} value={filter.modelId} options={facets.models.map(id => ({ value: id, label: id }))} onChange={value => patch({ modelId: value })} />
      <FilterSelect label={tt('usage.filter.protocol')} value={filter.protocol} options={facets.protocols.map(id => ({ value: id, label: id }))} onChange={value => patch({ protocol: value })} />
      <FilterSelect label={tt('usage.filter.outcome')} value={filter.outcome} options={[{ value: 'ok', label: tt('usage.outcome.ok') }, { value: 'error', label: tt('usage.outcome.error') }]} onChange={value => patch({ outcome: value === 'ok' || value === 'error' ? value : undefined })} />
      <button className="gw-small" disabled={!active} onClick={() => setFilter({})}>{tt('usage.reset')}</button>
    </div>
    {error && <p role="alert" className="gw-notice err">{error}</p>}
    {totals && <div className="gw-stats">
      {cards.map(([key, value, exact]) => <div key={key} className="gw-stat"><div className="gw-stat-label">{tt(key)}</div><div className="gw-stat-value" title={exact}>{value}</div></div>)}
    </div>}
    {summary && <div className="gw-card">
      <div className="gw-row between"><h2>{tt('usage.details')}</h2><span className="gw-hint">{tt('usage.matched', { shown: summary.rows.length, total: summary.matched })}</span></div>
      {summary.rows.length === 0 ? <p className="gw-empty">{tt('usage.empty')}</p> : <div className="gw-table-wrap"><table className="gw-wide"><thead><tr>
        <th>{tt('usage.time')}</th><th>{tt('usage.protocol')}</th><th>{tt('usage.model')}</th><th>{tt('usage.key')}</th>
        <th className="gw-num">{tt('usage.inputShort')}</th><th className="gw-num">{tt('usage.outputShort')}</th><th className="gw-num">{tt('usage.cacheShort')}</th><th className="gw-num">{tt('usage.reasoningShort')}</th>
        <th className="gw-num">{tt('usage.ttft')}</th><th className="gw-num">{tt('usage.duration')}</th><th>{tt('usage.status')}</th><th>{tt('usage.error')}</th>
      </tr></thead><tbody>{summary.rows.map((row, index) => <tr key={`${row.time}-${index}`}>
        <td>{formatTime(row.time)}</td>
        <td>{row.protocol}{row.stream ? ` · ${tt('usage.stream')}` : ''}</td>
        <td className="gw-mono wrap">{row.modelId}</td>
        <td>{keyName(row.keyId)}</td>
        {[row.inputTokens, row.outputTokens, row.cacheReadTokens, row.reasoningTokens].map((value, column) => <td key={column} className="gw-num" title={formatNumber(value)}>{formatCompact(value)}</td>)}
        <td className="gw-num">{row.ttftMs === null ? '—' : `${row.ttftMs} ms`}</td><td className="gw-num">{row.durationMs} ms</td>
        <td style={{ color: row.status >= 400 ? '#f07171' : undefined }}>{row.status}</td><td className="gw-mono">{row.errorCode ?? ''}</td>
      </tr>)}</tbody></table></div>}
      {summary.matched > summary.rows.length && <p className="gw-hint">{tt('usage.truncated', { limit: DETAIL_LIMIT })}</p>}
    </div>}
  </>
}
