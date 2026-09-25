import { useCallback, useEffect, useState } from 'react'
import type { RdbApi } from '../api.ts'
import { hostEntries, quoteIdentifier, type DbProfilePayload, type DbProfileSummary, type TableInfo, type TableRef } from '../../protocol.ts'
import { tt } from '../locales.ts'
import type { PanelController } from '../mount.tsx'
import { BannerView, Modal, errorMessage, type Banner } from './common.tsx'
import { DataGrid } from './DataGrid.tsx'
import { ProfileForm } from './ProfileForm.tsx'
import { SqlEditor } from './SqlEditor.tsx'
import { Structure } from './Structure.tsx'

export interface RdbPanelProps {
  controller: PanelController
  api: RdbApi
}

type Tab = 'data' | 'structure' | 'sql'
const KIND_LABEL: Record<string, string> = { sqlite: 'sqlite', postgres: 'pg', gaussdb: 'gauss', mysql: 'mysql' }

function TableIcon(props: { kind: TableRef['kind'] }): JSX.Element {
  return props.kind === 'view'
    ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></svg>
    : <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 6.5h12M6.5 6.5v7" /></svg>
}

function profileTarget(p: DbProfileSummary): string {
  if (p.kind === 'sqlite') return p.file
  const nodes = hostEntries(p.host, p.port)
  return `${nodes.length > 1 ? `${nodes[0]} +${nodes.length - 1}` : nodes[0]}/${p.database}${p.targetSessionAttrs !== 'any' ? ` · ${tt(`form.target.${p.targetSessionAttrs}` as 'form.target.any')}` : ''}`
}

export function RdbPanel(props: RdbPanelProps): JSX.Element {
  const { api, controller } = props
  const [profiles, setProfiles] = useState<DbProfileSummary[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [agentTools, setAgentTools] = useState(false)
  const [banner, setBanner] = useState<Banner | undefined>()
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; profile: DbProfileSummary } | undefined>()
  const [confirmDelete, setConfirmDelete] = useState<DbProfileSummary | undefined>()
  const [testing, setTesting] = useState<string | undefined>()
  const [loaded, setLoaded] = useState(false)

  const [schemas, setSchemas] = useState<string[]>([])
  // Selection is tagged with the connection it belongs to, so a stale schema or
  // table never fires a request against a newly picked connection.
  const [sel, setSel] = useState<{ id: string; schema: string; table?: TableRef } | undefined>()
  const [tables, setTables] = useState<TableRef[] | undefined>()
  const [treeFilter, setTreeFilter] = useState('')
  const [info, setInfo] = useState<TableInfo | undefined>()
  const [tab, setTab] = useState<Tab>('data')
  const current = sel !== undefined && sel.id === activeId ? sel : undefined
  const schema = current?.schema ?? ''
  const table = current?.table
  // Functional updates: two calls in one handler must not overwrite each other with a stale snapshot.
  const setSchema = (next: string): void => { setSel(prev => prev !== undefined && prev.id === activeId ? { id: prev.id, schema: next } : prev) }
  const setTable = (next: TableRef | undefined): void => { setSel(prev => prev !== undefined && prev.id === activeId ? { ...prev, table: next } : prev) }

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [list, settings] = await Promise.all([api.profiles(), api.settings()])
      setProfiles(list)
      setAgentTools(settings.agentTools)
      setActiveId(prev => (prev !== undefined && list.some(p => p.id === prev)) ? prev : list[0]?.id)
      setLoaded(true)
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }, [api])

  useEffect(() => {
    const sync = (): void => { if (controller.getSnapshot().panelOpen) void refresh() }
    const unsubscribe = controller.subscribe(sync)
    sync()
    return unsubscribe
  }, [controller, refresh])

  // Connection changed: reload schema list, reset selection.
  useEffect(() => {
    setSchemas([]); setSel(undefined); setTables(undefined); setInfo(undefined); setTreeFilter('')
    if (activeId === undefined) return
    let cancelled = false
    api.schemas(activeId).then(res => {
      if (cancelled) return
      setSchemas(res.schemas); setSel({ id: activeId, schema: res.defaultSchema })
    }, err => { if (!cancelled) setBanner({ kind: 'error', text: errorMessage(err) }) })
    return () => { cancelled = true }
  }, [api, activeId])

  useEffect(() => {
    if (activeId === undefined || schema === '') return
    let cancelled = false
    setTables(undefined)
    api.tables(activeId, schema).then(list => { if (!cancelled) setTables(list) }, err => { if (!cancelled) { setTables([]); setBanner({ kind: 'error', text: errorMessage(err) }) } })
    return () => { cancelled = true }
  }, [api, activeId, schema])

  // Table changed: load its structure (needed for both the grid and the structure tab).
  useEffect(() => {
    setInfo(undefined)
    if (activeId === undefined || table === undefined) return
    let cancelled = false
    api.tableInfo(activeId, table).then(res => { if (!cancelled) setInfo(res) }, err => { if (!cancelled) setBanner({ kind: 'error', text: errorMessage(err) }) })
    return () => { cancelled = true }
  }, [api, activeId, table])

  const toggleAgentTools = async (next: boolean): Promise<void> => {
    setAgentTools(next)
    try {
      const settings = await api.saveSettings({ agentTools: next })
      setAgentTools(settings.agentTools)
      setBanner({ kind: 'ok', text: settings.agentTools ? tt('browser.toolsOn') : tt('browser.toolsOff') })
    } catch (error) {
      setAgentTools(!next)
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const save = async (payload: DbProfilePayload): Promise<void> => {
    if (form === undefined) return
    const saved = form.mode === 'create' ? await api.createProfile(payload) : await api.updateProfile(form.profile.id, payload)
    setForm(undefined)
    await refresh()
    setActiveId(saved.id)
  }

  const runTest = async (profile: DbProfileSummary): Promise<void> => {
    setTesting(profile.id)
    setBanner({ kind: 'info', text: tt('conn.testing') })
    try {
      const result = await api.test(profile.id)
      setBanner(result.ok
        ? { kind: 'ok', text: result.node !== undefined ? tt('conn.testOk', { node: result.node, version: result.serverVersion ?? '', latency: result.latencyMs }) : tt('conn.testOkFile', { version: result.serverVersion ?? '', latency: result.latencyMs }) }
        : { kind: 'error', text: tt('conn.testFail', { error: result.error ?? '?' }) })
    } catch (error) {
      setBanner({ kind: 'error', text: tt('conn.testFail', { error: errorMessage(error) }) })
    } finally { setTesting(undefined) }
  }

  const runDeleteProfile = async (profile: DbProfileSummary): Promise<void> => {
    setConfirmDelete(undefined)
    try { await api.deleteProfile(profile.id); await refresh() } catch (error) { setBanner({ kind: 'error', text: errorMessage(error) }) }
  }

  const active = profiles.find(p => p.id === activeId)
  const filterLc = treeFilter.trim().toLowerCase()
  const visible = (current === undefined ? [] : tables ?? []).filter(t => filterLc === '' || t.name.toLowerCase().includes(filterLc))
  const tableList = visible.filter(t => t.kind === 'table')
  const viewList = visible.filter(t => t.kind === 'view')
  const sameTable = (a: TableRef | undefined, b: TableRef): boolean => a !== undefined && a.schema === b.schema && a.name === b.name

  const treeItem = (t: TableRef): JSX.Element => (
    <button key={`${t.schema}.${t.name}`} type="button" className="dsh-rdb-treeItem" data-kind={t.kind} title={`${t.schema}.${t.name}`}
      {...(sameTable(table, t) ? { 'data-active': '' } : {})}
      onClick={() => { setTable(t); if (tab === 'sql') setTab('data') }}>
      <TableIcon kind={t.kind} /><span>{t.name}</span>
    </button>
  )

  return (
    <section className="dsh-rdb-panel" data-dsh-plugin="rdb" data-dsh-part="panel">
      <header className="dsh-rdb-header">
        <h2 className="dsh-rdb-title">{tt('panel.title')}</h2>
        <label className="dsh-rdb-toggle" {...(agentTools ? { 'data-on': '' } : {})}>
          <input type="checkbox" checked={agentTools} disabled={!loaded} onChange={(e) => { void toggleAgentTools(e.target.checked) }} />
          <span className="dsh-rdb-switch" aria-hidden="true" />
          <span>{tt('panel.agentTools')}</span>
        </label>
        <button type="button" className="dsh-rdb-ghost" onClick={() => { controller.close() }}>{tt('panel.back')}</button>
      </header>

      <BannerView banner={banner} onClose={() => { setBanner(undefined) }} />

      <div className="dsh-rdb-body">
        <aside className="dsh-rdb-side">
          <div className="dsh-rdb-profiles">
            <div className="dsh-rdb-profilesHead">
              <span>{tt('conn.title')}</span>
              <button type="button" className="dsh-rdb-link" onClick={() => { setForm({ mode: 'create' }) }}>+ {tt('conn.add')}</button>
            </div>
            <div className="dsh-rdb-profileList">
              {profiles.length === 0 && loaded && <div className="dsh-rdb-hint">{tt('conn.empty')}</div>}
              {profiles.map(profile => (
                <button key={profile.id} type="button" className="dsh-rdb-profile" {...(profile.id === activeId ? { 'data-active': '' } : {})} onClick={() => { setActiveId(profile.id) }}>
                  <span className="dsh-rdb-profileName"><span className="dsh-rdb-kind">{KIND_LABEL[profile.kind] ?? profile.kind}</span>{profile.name}{profile.allowWrite && <span className="dsh-rdb-writeTag">{tt('conn.writeOn')}</span>}</span>
                  <span className="dsh-rdb-profileMeta" title={profile.kind === 'sqlite' ? profile.file : `${hostEntries(profile.host, profile.port).join(', ')}/${profile.database}`}>{profileTarget(profile)}</span>
                </button>
              ))}
            </div>
            {active !== undefined && (
              <div className="dsh-rdb-profileActions">
                <button type="button" className="dsh-rdb-link" disabled={testing === active.id} onClick={() => { void runTest(active) }}>{tt('conn.test')}</button>
                <button type="button" className="dsh-rdb-link" onClick={() => { setForm({ mode: 'edit', profile: active }) }}>{tt('conn.edit')}</button>
                <button type="button" className="dsh-rdb-link" data-danger onClick={() => { setConfirmDelete(active) }}>{tt('conn.delete')}</button>
              </div>
            )}
          </div>

          {active !== undefined && (
            <div className="dsh-rdb-tree">
              <div className="dsh-rdb-treeHead">
                <span>{tt('tree.title')}</span>
                {schemas.length > 1 && (
                  <select className="dsh-rdb-select" value={schema} onChange={(e) => { setSchema(e.target.value) }}>
                    {schemas.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
              </div>
              <input className="dsh-rdb-input dsh-rdb-treeFilter" data-mono value={treeFilter} placeholder={tt('data.filter')} onChange={(e) => { setTreeFilter(e.target.value) }} />
              <div className="dsh-rdb-treeList">
                {tables === undefined && <div className="dsh-rdb-hint">{tt('tree.loading')}</div>}
                {tables !== undefined && visible.length === 0 && <div className="dsh-rdb-hint">{tt('tree.empty')}</div>}
                {tableList.length > 0 && <div className="dsh-rdb-treeGroup">{tt('tree.tables')} · {tableList.length}</div>}
                {tableList.map(treeItem)}
                {viewList.length > 0 && <div className="dsh-rdb-treeGroup">{tt('tree.views')} · {viewList.length}</div>}
                {viewList.map(treeItem)}
              </div>
            </div>
          )}
        </aside>

        <div className="dsh-rdb-work">
          {active !== undefined ? <>
            <div className="dsh-rdb-tabs" role="tablist">
              {(['data', 'structure', 'sql'] as Tab[]).map(t => (
                <button key={t} type="button" role="tab" className="dsh-rdb-tab" aria-selected={tab === t} {...(tab === t ? { 'data-active': '' } : {})} onClick={() => { setTab(t) }}>{tt(`tab.${t}` as 'tab.data')}</button>
              ))}
              {table !== undefined && <span className="dsh-rdb-tableName">{table.schema}.{table.name}</span>}
            </div>
            {tab === 'sql' ? (
              <SqlEditor key={active.id} api={api} connectionId={active.id} initialSql={table !== undefined ? `SELECT * FROM ${quoteIdentifier(active.kind, table.schema)}.${quoteIdentifier(active.kind, table.name)} LIMIT 100` : ''} />
            ) : table === undefined ? (
              <div className="dsh-rdb-empty">{tt('data.pick')}</div>
            ) : info === undefined ? (
              <div className="dsh-rdb-loading">{tt('tree.loading')}</div>
            ) : tab === 'data' ? (
              <DataGrid key={`${active.id}/${table.schema}.${table.name}`} api={api} connectionId={active.id} kind={active.kind} table={table} info={info} />
            ) : (
              <Structure api={api} connectionId={active.id} table={table} info={info} />
            )}
          </> : (
            <div className="dsh-rdb-empty">{loaded && profiles.length === 0 ? tt('conn.empty') : ''}</div>
          )}
        </div>
      </div>

      {form !== undefined && (
        <ProfileForm mode={form.mode} profile={form.mode === 'edit' ? form.profile : undefined} onCancel={() => { setForm(undefined) }} onSave={save} />
      )}
      {confirmDelete !== undefined && (
        <Modal title={tt('conn.delete')} onClose={() => { setConfirmDelete(undefined) }} footer={<>
          <button type="button" className="dsh-rdb-ghost" onClick={() => { setConfirmDelete(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-rdb-primary" data-danger onClick={() => { void runDeleteProfile(confirmDelete) }}>{tt('conn.delete')}</button>
        </>}>
          <p style={{ margin: 0 }}>{tt('conn.deleteConfirm', { name: confirmDelete.name })}</p>
        </Modal>
      )}
    </section>
  )
}
