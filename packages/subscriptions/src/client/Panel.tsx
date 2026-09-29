import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Catalog, Preferences, ProviderId, Status, Usage } from '../protocol.ts'
import type { SubscriptionsApi } from './api.ts'
import { tt, type Key } from './locales.ts'
import { ContextWindowInput } from './ContextWindowInput.tsx'
import { ProviderLogo } from './ProviderLogo.tsx'

export interface PanelProps { api: SubscriptionsApi; close: () => void }
type Tab = 'models' | 'tools' | 'usage'
const TOOL_CARDS = { codex: [
  { setting: 'web_search', name: 'codex_web_search', title: 'searchTitle', hint: 'searchHint' },
  { setting: 'image_generate', name: 'codex_image_generate', title: 'imageTitle', hint: 'imageHint' },
], antigravity: [
  { setting: 'web_search', name: 'antigravity_web_search', title: 'googleSearchTitle', hint: 'googleSearchHint' },
  { setting: 'image_generate', name: 'antigravity_image_generate', title: 'googleImageTitle', hint: 'googleImageHint' },
] } as const
const PROVIDERS = {
  codex: { name: 'ChatGPT', vendor: 'OpenAI', connect: 'connect', empty: 'emptyTitle', intro: 'intro', callback: 'http://localhost:1455/auth/callback?…' },
  antigravity: { name: 'Antigravity', vendor: 'Google', connect: 'connectGoogle', empty: 'emptyGoogle', intro: 'introGoogle', callback: 'http://localhost:51121/oauth-callback?…' },
} as const
const messageOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message
}

function DisconnectDialog({ label, busy, cancel, confirm }: { label: string; busy: boolean; cancel: () => void; confirm: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className="dsh-sub-modal" aria-labelledby="sub-disconnect-title" onCancel={e => { e.preventDefault(); cancel() }}>
    <h3 id="sub-disconnect-title">{tt('disconnect')}</h3><p>{tt('disconnectHint', { account: label })}</p>
    <div className="dsh-sub-actions"><button autoFocus onClick={cancel}>{tt('cancel')}</button><button className="dsh-sub-danger" disabled={busy} onClick={confirm}>{tt('confirm')}</button></div>
  </dialog>
}

export function SubscriptionsPanel({ api, close }: PanelProps): JSX.Element {
  const [provider, setProvider] = useState<ProviderId>(api.provider ?? 'codex')
  const scopedApi = useMemo(() => provider === (api.provider ?? 'codex') ? api : api.forProvider(provider), [api, provider])
  return <ProviderPanel key={provider} api={scopedApi} close={close} provider={provider} selectProvider={setProvider}/>
}

function ProviderPanel({ api, close, provider, selectProvider }: PanelProps & { provider: ProviderId; selectProvider: (provider: ProviderId) => void }): JSX.Element {
  const profile = PROVIDERS[provider]
  const [status, setStatus] = useState<Status>()
  const [active, setActive] = useState<string>()
  const [catalog, setCatalog] = useState<Catalog>()
  const [usage, setUsage] = useState<{ account: string; value: Usage }>()
  const [tab, setTab] = useState<Tab>('models')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [usageBusy, setUsageBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const [manual, setManual] = useState('')
  const [disconnect, setDisconnect] = useState<Account>()
  const mounted = useRef(true)
  const lock = useRef(false)
  const retryAction = useRef<() => Promise<unknown>>()
  const catalogSequence = useRef(0)
  const usageSequence = useRef(0)
  const statusSequence = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const refreshStatus = useCallback(async (): Promise<Status> => {
    const sequence = ++statusSequence.current
    const next = await api.status()
    if (mounted.current && sequence === statusSequence.current) {
      setStatus(next)
      setActive(previous => next.accounts.some(a => a.key === previous) ? previous : next.accounts[0]?.key)
      if (!next.busy) { setAuthUrl(''); setManual('') }
    }
    return next
  }, [api])
  const refreshCatalog = useCallback(async (force = false): Promise<void> => {
    const sequence = ++catalogSequence.current
    setCatalogBusy(true)
    try {
      const next = await api.catalog(force)
      if (mounted.current && sequence === catalogSequence.current) setCatalog(next)
    } finally {
      if (mounted.current && sequence === catalogSequence.current) setCatalogBusy(false)
    }
  }, [api])
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    if (lock.current) return false
    lock.current = true
    setBusy(true); setError(''); setNotice(''); retryAction.current = undefined
    try { await action(); return true } catch (error) { if (mounted.current) { retryAction.current = action; setError(messageOf(error)) }; return false }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }, [])

  useEffect(() => { void refreshStatus().catch(e => { if (mounted.current) setError(messageOf(e)) }) }, [refreshStatus])
  const accountSignature = JSON.stringify(status?.accounts.map(a => [a.key, a.expiresAt]))
  useEffect(() => {
    if (!status) return
    if (status.accounts.length === 0) { ++catalogSequence.current; setCatalog(undefined); setCatalogBusy(false); return }
    void refreshCatalog().catch(e => { if (mounted.current) setError(messageOf(e)) })
  }, [accountSignature, refreshCatalog])
  useEffect(() => {
    if (!status?.busy) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try { await refreshStatus() } catch (error) { if (!stopped) setError(messageOf(error)) }
      if (!stopped) timer = setTimeout(() => { void poll() }, 1500)
    }
    timer = setTimeout(() => { void poll() }, 1500)
    return () => { stopped = true; clearTimeout(timer) }
  }, [status?.busy, refreshStatus])

  const refreshUsage = useCallback(async (): Promise<void> => {
    if (!active) return
    const sequence = ++usageSequence.current
    setUsageBusy(true)
    try {
      const value = await api.usage(active)
      if (mounted.current && sequence === usageSequence.current) setUsage({ account: active, value })
    } finally { if (mounted.current && sequence === usageSequence.current) setUsageBusy(false) }
  }, [api, active])
  useEffect(() => {
    ++usageSequence.current
    setUsage(undefined); setUsageBusy(false)
    if (tab === 'usage' && active) void refreshUsage().catch(e => { if (mounted.current) setError(messageOf(e)) })
  }, [tab, active, refreshUsage])

  const login = (): void => {
    void run(async () => {
      const { authorizeUrl: url, manualOnly } = await api.login()
      if (!mounted.current) return
      setAuthUrl(url)
      setStatus(previous => ({ accounts: previous?.accounts ?? [], busy: true, manualOnly }))
      window.open(url, '_blank', 'noopener,noreferrer')
    })
  }
  const save = (settings: Preferences): void => {
    void run(async () => {
      await api.save(settings)
      setCatalog(previous => previous ? { ...previous, settings } : previous)
      setNotice(tt('saved'))
    })
  }
  const account = status?.accounts.find(a => a.key === active)
  const ownCatalog = catalog?.accounts.find(a => a.key === active)
  const availableModels = catalog?.models.filter(model => !ownCatalog || ownCatalog.unavailable || ownCatalog.models.some(m => m.id === model.id)) ?? []
  const models = availableModels.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase()))
  const settings = catalog?.settings ?? {}
  const accountLabel = (a: Account): string => settings.accounts?.[a.key]?.alias || a.account || profile.name
  const currentUsage = usage && usage.account === active ? usage.value : undefined

  return <section className="dsh-sub-panel" data-dsh-plugin="subscriptions" data-dsh-part="panel">
    <header className="dsh-sub-header"><h2>{tt('title')}</h2><button onClick={close}>{tt('back')}</button></header>
    {(error || status?.detail) && <div className="dsh-sub-banner" role="alert" data-kind="error"><span>{error || status?.detail}</span><button disabled={busy} onClick={() => { void run(retryAction.current ?? refreshStatus) }}>{tt('retry')}</button></div>}
    {notice && <div className="dsh-sub-banner" role="status">{notice}</div>}
    <div className="dsh-sub-body">
      <aside className="dsh-sub-accounts">
        <div className="dsh-sub-asideHead"><span>{tt('accounts')}</span><button className="dsh-sub-link" disabled={busy || status?.busy || !status} onClick={login}>+ {tt('add')}</button></div>
        <nav className="dsh-sub-providers" aria-label={tt('subscriptionType')}>
          {(Object.keys(PROVIDERS) as ProviderId[]).map(id => <button key={id} className="dsh-sub-provider" aria-pressed={id === provider}
            disabled={busy || status?.busy} onClick={() => selectProvider(id)}>
            <span className="dsh-sub-logo" aria-hidden="true"><ProviderLogo provider={id}/></span>
            <span><strong>{PROVIDERS[id].name}</strong><small>{PROVIDERS[id].vendor}</small></span>
          </button>)}
        </nav>
        <div className="dsh-sub-accountList">
          {!status && <p className="dsh-sub-hint">{tt('loading')}</p>}
          {status?.accounts.length === 0 && <p className="dsh-sub-hint">{tt('disconnected')}</p>}
          {status?.accounts.map(a => <button key={a.key} className="dsh-sub-account" data-active={a.key === active || undefined} onClick={() => setActive(a.key)}>
            <strong title={a.account}>{accountLabel(a)}</strong><small>{a.plan ?? profile.name}{a.isDefault ? ` · ${tt('default')}` : ''}</small>
          </button>)}
        </div>
        <p className="dsh-sub-hint dsh-sub-asideFooter">{tt(profile.intro)}</p>
      </aside>
      <main className="dsh-sub-main">
        {status?.busy && <div className="dsh-sub-auth" role="status">
          <strong>{tt('waiting')}</strong><p>{tt(status.manualOnly ? 'manualOnlyHint' : 'authHint')}</p>
          <div className="dsh-sub-actions">{authUrl && <a href={authUrl} target="_blank" rel="noopener noreferrer">{tt('openAuth')}</a>}<button disabled={busy} onClick={() => { void run(async () => { await api.cancel(); await refreshStatus() }) }}>{tt('cancel')}</button></div>
          <details open={status.manualOnly || undefined}><summary>{tt('manual')}</summary><p className="dsh-sub-hint">{tt('manualHint')}</p><form className="dsh-sub-actions" onSubmit={e => { e.preventDefault(); void run(async () => { await api.manual(manual.trim()); await refreshStatus() }) }}>
            <input aria-label={tt('manual')} value={manual} onChange={e => setManual(e.target.value)} placeholder={profile.callback} autoComplete="off" spellCheck={false}/><button disabled={busy || !manual.trim()}>{tt('submit')}</button>
          </form></details>
        </div>}
        {!account ? <div className="dsh-sub-empty"><span className="dsh-sub-emptyLogo" aria-hidden="true"><ProviderLogo provider={provider}/></span><h3>{tt(profile.empty)}</h3><p>{tt('emptyHint')}</p><button className="dsh-sub-primary" disabled={busy || status?.busy || !status} onClick={login}>{tt(profile.connect)}</button></div> : <>
          <div className="dsh-sub-accountHeader"><div><h3>{accountLabel(account)}</h3><span className="dsh-sub-status">● {tt('connected')}</span><span className="dsh-sub-hint"> · {account.plan ?? profile.name}</span></div><div className="dsh-sub-actions">
            {!account.isDefault && <button disabled={busy} onClick={() => { void run(async () => { await api.setDefault(account.key); await refreshStatus() }) }}>{tt('setDefault')}</button>}
            <button disabled={busy} onClick={() => setDisconnect(account)}>{tt('disconnect')}</button>
          </div></div>
          <div className="dsh-sub-tabs" role="tablist" aria-label={profile.name}>{(['models', 'tools', 'usage'] as const).map(value => <button key={value} role="tab" id={`sub-tab-${value}`} aria-selected={tab === value} aria-controls={`sub-panel-${value}`} onClick={() => setTab(value)}>{tt(value)}{value === 'models' && catalog ? ` ${availableModels.length}` : ''}</button>)}</div>
          <div className="dsh-sub-tabBody" role="tabpanel" id={`sub-panel-${tab}`} aria-labelledby={`sub-tab-${tab}`}>
            {tab === 'models' && <>
              <div className="dsh-sub-toolbar"><input aria-label={tt('search')} placeholder={tt('search')} value={query} onChange={e => setQuery(e.target.value)}/><button disabled={busy || catalogBusy} onClick={() => { void run(() => refreshCatalog(true)) }}>{catalogBusy ? tt('loading') : tt('refresh')}</button></div>
              <p className="dsh-sub-hint">{tt('modelHint')}</p>
              <p className="dsh-sub-hint">{tt('contextHint')}</p>
              {ownCatalog?.unavailable && <p className="dsh-sub-hint" role="status">{tt('unavailable')}</p>}
              <label className="dsh-sub-check"><input type="checkbox" disabled={busy || !catalog || catalogBusy} checked={settings.visibleModels === undefined} onChange={e => save({ ...settings, visibleModels: e.target.checked ? undefined : catalog?.models.map(m => m.id) })}/>{tt('autoModels')}</label>
              <div className="dsh-sub-tableWrap"><table><thead><tr><th>{tt('modelName')}</th><th>{tt('context')}</th><th>{tt('reasoning')}</th></tr></thead><tbody>
                {models.map(model => <tr key={model.id}><td><label className="dsh-sub-check"><input type="checkbox" aria-label={model.name} disabled={busy || catalogBusy} checked={settings.visibleModels?.includes(model.id) ?? true} onChange={e => {
                  const ids = new Set(settings.visibleModels ?? catalog?.models.map(m => m.id)); if (e.target.checked) ids.add(model.id); else ids.delete(model.id); save({ ...settings, visibleModels: [...ids] })
                }}/><span><strong>{model.name}</strong><small>{model.id}</small></span></label></td><td>
                  <ContextWindowInput model={model} configured={settings.contextWindows?.[model.id]} disabled={busy || catalogBusy} save={value => run(async () => {
                    const contextWindows = { ...settings.contextWindows }
                    if (value === undefined) delete contextWindows[model.id]; else contextWindows[model.id] = value
                    const next = { ...settings, contextWindows: Object.keys(contextWindows).length ? contextWindows : undefined }
                    await api.save(next)
                    setCatalog(previous => previous ? { ...previous, settings: next } : previous)
                    await refreshCatalog()
                    setNotice(tt('saved'))
                  })}/>
                </td><td>
                  {model.efforts.length > 0 ? <select aria-label={`${model.name} ${tt('reasoning')}`} value={model.configured ?? ''} disabled={busy || catalogBusy} onChange={e => { const effort = e.target.value || undefined; void run(async () => {
                    await api.effort(model.id, effort); setCatalog(previous => previous ? { ...previous, models: previous.models.map(m => m.id === model.id ? { ...m, configured: effort } : m) } : previous); setNotice(tt('saved'))
                  }) }}><option value="">{tt('providerDefault')}</option>{model.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}</select> : '—'}
                </td></tr>)}
              </tbody></table>{models.length === 0 && <p className="dsh-sub-tableEmpty">{catalogBusy ? tt('loading') : query ? tt('noMatches') : tt('noModels')}</p>}</div>
            </>}
            {tab === 'tools' && <>
              {TOOL_CARDS[provider].map(tool => <div className="dsh-sub-tool" key={tool.name}>
                <div><h4>{tt(tool.title)}</h4><p>{tt(tool.hint)}</p><code>{tool.name}</code></div>
                <label className="dsh-sub-toggle">
                  <input type="checkbox" aria-label={tt(tool.title)} disabled={busy || !catalog || catalogBusy}
                    checked={settings.tools?.[tool.setting] !== false}
                    onChange={e => save({ ...settings, tools: { ...settings.tools, [tool.setting]: e.target.checked } })}/>
                  <span className="dsh-sub-switch" aria-hidden="true"/>
                </label>
              </div>)}
              <p className="dsh-sub-hint">{tt('toolPolicy')}</p>
            </>}
            {tab === 'usage' && <>
              <div className="dsh-sub-toolbar"><p className="dsh-sub-hint">{tt('usageHint')}</p><button disabled={usageBusy || busy} onClick={() => { void run(refreshUsage) }}>{usageBusy ? tt('loading') : tt('refresh')}</button></div>
              {currentUsage?.plan && <p>{tt('plan')} · {currentUsage.plan}</p>}
              {!currentUsage && <p className="dsh-sub-tableEmpty">{usageBusy ? tt('loading') : tt('unknownUsage')}</p>}
              {currentUsage && (!currentUsage.supported || !currentUsage.windows?.length) && <p className="dsh-sub-tableEmpty">{tt('unsupportedUsage')}</p>}
              {currentUsage?.windows?.map((window, index) => <div className="dsh-sub-usage" key={index}><div><strong>{tt(window.kind as Key)}{window.scope ? ` · ${window.scope}` : ''}</strong><span>{Number.isFinite(window.usedPercent) ? `${window.usedPercent.toFixed(0)}% ${tt('used')}` : tt('unknown')}</span></div>
                {Number.isFinite(window.usedPercent) && <progress max={100} value={Math.max(0, Math.min(100, window.usedPercent))} aria-label={tt(window.kind)}/>}
                <small>{tt('resets')} · {window.resetsAt ? new Date(window.resetsAt).toLocaleString() : tt('unknown')}</small>
              </div>)}
            </>}
          </div>
        </>}
      </main>
    </div>
    {disconnect && <DisconnectDialog label={accountLabel(disconnect)} busy={busy} cancel={() => setDisconnect(undefined)} confirm={() => { void run(async () => { await api.logout(disconnect.key); setDisconnect(undefined); await refreshStatus() }) }}/>}
  </section>
}
