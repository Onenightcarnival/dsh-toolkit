import { useEffect, useRef, useState } from 'react'
import { API, FIELDS, emptySnapshot, sortEntries, type Commit, type Entry, type Kind, type Snapshot, type State } from '../model.ts'
import { DirectoryView, ResumeView, entryName } from './views.tsx'
import { t, zh, type Key } from './locales.ts'

async function request(input?: Commit | { agentTools: boolean } | { clear: true; baseRevision: number }): Promise<State> {
  const response = await fetch(API, { method: input ? ('clear' in input ? 'DELETE' : 'agentTools' in input ? 'PATCH' : 'POST') : 'GET', credentials: 'same-origin',
    ...(input ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'generic')
  return body as State
}
function message(error: unknown): string {
  const key = `error.${error instanceof Error ? error.message : 'generic'}`
  return t(key in zh ? key as Key : 'error.generic')
}
function download(state: State): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 3, exportedAt: new Date().toISOString(), entries: state.entries }, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = 'career-memory.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function differences(before: Snapshot, after: Snapshot): { label: string; before: string; after: string }[] {
  const changes: { label: string; before: string; after: string }[] = []
  for (const id of new Set([...before.entries, ...after.entries].map(e => e.id))) {
    const a = before.entries.find(e => e.id === id), b = after.entries.find(e => e.id === id)
    for (const key of new Set([...Object.keys(a?.fields ?? {}), ...Object.keys(b?.fields ?? {})])) {
      const av = a?.fields[key] ?? '', bv = b?.fields[key] ?? ''
      const display = (value: string, snapshot: Snapshot) => ['parentId', 'workId'].includes(key) ? (value ? entryName(snapshot.entries.find(e => e.id === value)) : '') : value
      if (av !== bv) changes.push({ label: `${entryName(b ?? a)} · ${t(key as Key)}`, before: display(av, before), after: display(bv, after) })
    }
    if (JSON.stringify(a?.protected ?? []) !== JSON.stringify(b?.protected ?? [])) changes.push({ label: `${entryName(b ?? a)} · ${t('protected')}`, before: (a?.protected ?? []).map(k => t(k as Key)).join(', '), after: (b?.protected ?? []).map(k => t(k as Key)).join(', ') })
  }
  return changes
}

export function MemoryPanel({ close }: { close: () => void }): JSX.Element {
  const [state, setState] = useState<State>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState('profile')
  const [view, setView] = useState<'resume' | 'directory'>(() => { try { return localStorage.getItem('dsh-memory:view') === 'directory' ? 'directory' : 'resume' } catch { return 'resume' } })
  const [history, setHistory] = useState(false)
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest')
  const [revision, setRevision] = useState<number>()
  const [editor, setEditor] = useState<{ entry: Entry; base: number; unprotect: string[] }>()
  const [confirm, setConfirm] = useState<{ title: Key; hint: Key; input: Commit | { clear: true; baseRevision: number } }>()
  const importer = useRef<HTMLInputElement>(null)
  async function refresh(): Promise<void> { try { setState(await request()); setError('') } catch (e) { setError(message(e)) } }
  useEffect(() => { void refresh(); const timer = setInterval(() => { void request().then(setState).catch(() => {}) }, 5000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) { setEditor(undefined); setConfirm(undefined) } }
    document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener)
  }, [busy])
  useEffect(() => { try { localStorage.setItem('dsh-memory:view', view) } catch {} }, [view])
  async function setTools(agentTools: boolean): Promise<void> {
    setBusy(true); setError('')
    try { setState(await request({ agentTools })) } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function commit(input: Commit | { clear: true; baseRevision: number }): Promise<void> {
    setBusy(true); setError('')
    try {
      setState(await request(input)); setEditor(undefined); setConfirm(undefined)
      if ('clear' in input) { setSelected('profile'); setHistory(false); setRevision(undefined) }
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }
  function edit(entry: Entry): void { setError(''); setEditor({ entry: structuredClone(entry), base: state!.revision, unprotect: [] }) }
  function add(kind: Kind, parentId?: string): void { edit({ id: crypto.randomUUID(), kind, fields: parentId ? { [kind === 'project' ? 'workId' : 'parentId']: parentId } : {}, protected: [] }) }
  function remove(entry: Entry): void { setConfirm({ title: 'removeTitle', hint: 'removeHint', input: { baseRevision: state!.revision, summary: t('deleteSummary'), changes: [{ id: entry.id, kind: entry.kind, remove: true }] } }) }
  const entries = sortEntries(state?.entries ?? [], order)
  const open = (id: string) => { setSelected(id); setView('directory'); setHistory(false) }
  const selectedRevision = state?.history.find(h => h.revision === revision) ?? state?.history.at(-1)


  return <div className="mem-app">
    <header className="mem-top"><h1>{t('entry')}</h1>
      <nav><button aria-pressed={history} onClick={() => setHistory(!history)}>{t(history ? 'back' : 'history')}</button><button onClick={() => state && download(state)} disabled={!state}>{t('export')}</button><button onClick={() => importer.current?.click()}>{t('import')}</button><button onClick={() => void refresh()}>{t('refresh')}</button><button className="mem-danger" disabled={!state || busy} onClick={() => setConfirm({ title: 'clearTitle', hint: 'clearHint', input: { clear: true, baseRevision: state!.revision } })}>{t('clear')}</button><button aria-label={t('close')} onClick={close}>×</button></nav>
    </header>
    <input ref={importer} type="file" accept="application/json,.json" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file || !state) return
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('invalid')
        const data = JSON.parse(await file.text())
        if (![1, 2, 3].includes(data.schemaVersion) || !Array.isArray(data.entries)) throw new Error('invalid')
        setConfirm({ title: 'importTitle', hint: 'importHint', input: { baseRevision: state.revision, summary: t('importSummary'), imported: { schemaVersion: data.schemaVersion, entries: data.entries } } })
      } catch (e) { setError(message(e)) }
    }}/>
    {error && !editor && !confirm && <p className="mem-error" role="alert">{error}</p>}
    {!state ? <p className="mem-loading">{t('loading')}</p> : <>
      <div className="mem-status"><span>{t('revision')} {state.revision} <span className="mem-dot">·</span> {state.history.at(-1) ? new Date(state.history.at(-1)!.time).toLocaleString() : '—'}</span><label className="mem-toggle"><input type="checkbox" checked={state.agentTools} disabled={busy} onChange={e => void setTools(e.target.checked)}/><span className="mem-switch" aria-hidden="true"/>{t('agentTools')}</label></div>
      {!history && <div className="mem-viewbar"><div className="mem-segments" role="group" aria-label={t('view')}>{(['resume', 'directory'] as const).map(mode => <button key={mode} aria-pressed={view === mode} onClick={() => setView(mode)}>{t(mode === 'resume' ? 'resumeView' : 'directory')}</button>)}</div><label className="mem-sort">{t('createdAt')}<select aria-label={t('sort')} value={order} onChange={e => setOrder(e.target.value as typeof order)}><option value="newest">{t('newest')}</option><option value="oldest">{t('oldest')}</option></select></label></div>}
      <main className={`mem-scroll${!history && view === 'directory' ? ' mem-scroll-directory' : ''}`}>
      {history ? <div className="mem-history"><aside><h2>{t('history')}</h2>{!state.history.length && <p className="mem-muted">{t('emptyHistory')}</p>}{[...state.history].reverse().map(h => <button className={h.revision === selectedRevision?.revision ? 'mem-active' : ''} key={h.revision} onClick={() => setRevision(h.revision)}><span>v{h.revision} <small>{t(h.actor)}</small></span><strong>{h.summary}</strong><time>{new Date(h.time).toLocaleString()}</time></button>)}</aside>
        {selectedRevision && <section className="mem-history-detail"><div className="mem-section-heading"><div><h2>{selectedRevision.summary}</h2><p className="mem-muted">{t(selectedRevision.actor)} · {selectedRevision.source}</p></div><button disabled={busy || selectedRevision.revision === state.revision} onClick={() => setConfirm({ title: 'restoreTitle', hint: 'restoreHint', input: { baseRevision: state.revision, summary: t('restoreSummary'), restore: selectedRevision.revision } })}>{t('restore')}</button></div>
          {differences(state.history.find(h => h.revision === selectedRevision.revision - 1)?.snapshot ?? emptySnapshot(), selectedRevision.snapshot).map((d, i) => <article className="mem-diff" key={i}><h3>{d.label}</h3><div><section><small>{t('before')}</small><p>{d.before || '—'}</p></section><section><small>{t('after')}</small><p>{d.after || '—'}</p></section></div></article>)}
        </section>}
      </div> : view === 'directory' ? <DirectoryView entries={entries} selected={selected} edit={edit} remove={remove} add={add} open={open}/> : <ResumeView entries={entries} edit={edit} remove={remove} add={add} open={open}/>}

      </main>
    </>}
    {editor && <div className="mem-overlay"><form role="dialog" aria-modal="true" aria-labelledby="mem-edit-title" className="mem-dialog" onSubmit={event => { event.preventDefault(); void commit({ baseRevision: editor.base, summary: `${t('edit')} · ${entryName(editor.entry)}`, changes: [{ id: editor.entry.id, kind: editor.entry.kind, fields: editor.entry.fields, unprotect: editor.unprotect }] }) }}><header><h2 id="mem-edit-title">{t('edit')} · {t(editor.entry.kind === 'profile' ? 'personal' : editor.entry.kind)}</h2><button type="button" aria-label={t('close')} disabled={busy} onClick={() => setEditor(undefined)}>×</button></header><div className="mem-form-body">{error && <p className="mem-error" role="alert">{error}</p>}
      {FIELDS[editor.entry.kind].map((key, index) => <div className="mem-field" key={key}><label htmlFor={`mem-field-${key}`}>{t(key as Key)}{editor.entry.protected.includes(key) && <small className="mem-badge">{t('protected')}</small>}</label>
        {key === 'parentId' || key === 'workId' ? <select id={`mem-field-${key}`} value={editor.entry.fields[key] ?? ''} required={key === 'parentId'} onChange={e => setEditor({ ...editor, entry: { ...editor.entry, fields: { ...editor.entry.fields, [key]: e.target.value } } })}><option value="">{t(key === 'workId' ? 'noWork' : 'none')}</option>{entries.filter(e => key === 'workId' ? e.kind === 'work' : e.kind === 'project' || e.id === editor.entry.fields.parentId).map(e => <option key={e.id} value={e.id}>{entryName(e)}</option>)}</select> : ['name', 'position', 'title', 'period', 'organization', 'jobTitle', 'role'].includes(key) ? <input id={`mem-field-${key}`} type="text" autoFocus={index === 0} maxLength={12000} required={key === 'title'} value={editor.entry.fields[key] ?? ''} onChange={e => setEditor({ ...editor, entry: { ...editor.entry, fields: { ...editor.entry.fields, [key]: e.target.value } } })}/> : <textarea id={`mem-field-${key}`} autoFocus={index === 0} rows={4} maxLength={key === 'highlights' ? 50000 : 12000} value={editor.entry.fields[key] ?? ''} onChange={e => setEditor({ ...editor, entry: { ...editor.entry, fields: { ...editor.entry.fields, [key]: e.target.value } } })}/>}
        {editor.entry.protected.includes(key) && <label className="mem-unlock"><input type="checkbox" checked={editor.unprotect.includes(key)} onChange={e => setEditor({ ...editor, unprotect: e.target.checked ? [...editor.unprotect, key] : editor.unprotect.filter(k => k !== key) })}/>{t('unlock')}</label>}
      </div>)}
      </div><footer><button type="button" disabled={busy} onClick={() => setEditor(undefined)}>{t('cancel')}</button><button className="mem-primary" disabled={busy}>{t('save')}</button></footer></form></div>}
    {confirm && <div className="mem-overlay"><div role={'clear' in confirm.input ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="mem-confirm-title" aria-describedby="mem-confirm-hint" className="mem-dialog mem-confirm"><h2 id="mem-confirm-title">{t(confirm.title)}</h2><p id="mem-confirm-hint">{t(confirm.hint)}</p>{error && <p className="mem-error" role="alert">{error}</p>}<footer><button autoFocus disabled={busy} onClick={() => { setConfirm(undefined); setError('') }}>{t('cancel')}</button><button className={`mem-primary${'clear' in confirm.input ? ' mem-destructive' : ''}`} disabled={busy} onClick={() => void commit(confirm.input)}>{t('clear' in confirm.input ? 'confirmClear' : 'confirm')}</button></footer></div></div>}
  </div>
}
