/** User skill library with source preview and ZIP installation. */
import { useEffect, useRef, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigCenterApi } from './api.ts'
import type { SkillList, SkillDetail, SkillFile, SkillInstallResult } from '../protocol.ts'
import { tt } from './locales.ts'
import { mcpStyles as styles } from './styles.ts'

export function SkillsIcon({ size }: { size: number }): JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z" /></svg>
}

export function SkillsPage({ api, close }: { api: ConfigCenterApi; close: () => void }): JSX.Element {
  const [list, setList] = useState<SkillList>()
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<SkillDetail>()
  const [file, setFile] = useState('')
  const [preview, setPreview] = useState<SkillFile>()
  const [previewError, setPreviewError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState<{ file: File; result: SkillInstallResult }>()
  const input = useRef<HTMLInputElement>(null)
  const error = (value: unknown) => setNotice(value instanceof Error ? value.message : String(value))
  const applyList = (next: SkillList): void => {
    setList(next)
    setSelected(current => next.skills.some(skill => skill.name === current) ? current : next.skills[0]?.name ?? '')
  }
  useEffect(() => {
    let active = true
    void api.skills().then(next => { if (active) applyList(next) }).catch(value => { if (active) error(value) })
    return () => { active = false }
  }, [api, revision])
  useEffect(() => {
    let active = true
    setDetail(undefined); setFile(''); setPreview(undefined); setPreviewError('')
    if (selected) void api.skillDetail(selected).then(next => { if (active) { setDetail(next); setFile(next.entryFile) } }).catch(value => { if (active) error(value) })
    return () => { active = false }
  }, [api, selected, revision])
  useEffect(() => {
    let active = true
    setPreview(undefined); setPreviewError('')
    if (selected && file) void api.skillFile(selected, file).then(next => { if (active) setPreview(next) }).catch(value => { if (active) setPreviewError(value instanceof Error ? value.message : String(value)) })
    return () => { active = false }
  }, [api, selected, file, revision])
  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setNotice('')
    try { await operation() } catch (value) { error(value) } finally { setBusy(false) }
  }
  const install = (archive: File, policy: 'ask' | 'skip' | 'replace') => run(async () => {
    const result = await api.installSkills(archive, policy)
    if (policy === 'ask' && result.conflicts.length) { setPending({ file: archive, result }); return }
    setPending(undefined)
    setNotice(tt('skills.installed', { count: result.installed.length, skipped: result.skipped.length }))
    if (result.installed[0]) setSelected(result.installed[0])
    setRevision(value => value + 1)
  })
  return <section className="dsh-skills-page" aria-label={tt('skills.title')} style={styles.page}>
    <style>{`
      .dsh-skills-body{display:flex;gap:12px;flex:1;min-height:0;min-width:0}
      .dsh-skills-list{width:clamp(180px,24%,300px);flex:none;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);padding-right:12px}
      .dsh-skills-item{display:flex;flex-direction:column;gap:5px;width:100%;text-align:left;padding:10px;border:1px solid transparent;border-radius:8px;color:inherit;background:transparent;font:inherit;cursor:pointer}
      .dsh-skills-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-skills-item[aria-current=true]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l1)}
      .dsh-skills-item strong{overflow-wrap:anywhere}
      .dsh-skills-item small{color:var(--dsw-alias-label-secondary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
      .dsh-skills-detail{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;min-width:0;overflow:auto}
      .dsh-skills-files{display:flex;flex:1;min-height:180px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
      .dsh-skills-tree{width:clamp(140px,25%,240px);flex:none;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:6px}
      .dsh-skills-tree button{display:block;width:100%;text-align:left;font:inherit;color:inherit;background:transparent;border:0;border-radius:5px;padding:6px;overflow-wrap:anywhere;cursor:pointer}
      .dsh-skills-tree button[aria-current=true]{background:var(--dsw-alias-interactive-bg-active)}
      .dsh-skills-preview{flex:1;min-width:0;display:flex;flex-direction:column}
      .dsh-skills-preview pre{flex:1;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;padding:12px;margin:0}
      .dsh-skills-metadata{max-height:180px;overflow:auto;font-size:12px}
      .dsh-skills-metadata pre{white-space:pre-wrap;overflow-wrap:anywhere}
      @container(max-width:700px){.dsh-skills-body{flex-direction:column}.dsh-skills-list{width:auto;max-height:140px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 0 8px}.dsh-skills-files{flex-direction:column}.dsh-skills-tree{width:auto;max-height:100px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-skills-preview{min-height:180px}}
    `}</style>
    <header style={{ ...styles.header, flexWrap: 'wrap' }}>
      <h2 style={styles.heading}>{tt('skills.title')}</h2>
      <Button size="sm" disabled={busy} onClick={() => { setNotice(''); setRevision(value => value + 1) }}>{tt('common.refresh')}</Button>
      <Button size="sm" disabled={busy} onClick={() => { void run(() => api.openSkills()) }}>{tt('skills.open')}</Button>
      <Button size="sm" variant="primary" disabled={busy || !!pending} onClick={() => input.current?.click()}>{tt('skills.install')}</Button>
      <Button size="sm" variant="outline" onClick={close}>{tt('common.back')}</Button>
      <input ref={input} type="file" accept=".zip" hidden onChange={event => { const archive = event.target.files?.[0]; event.target.value = ''; if (archive) void install(archive, 'ask') }} />
    </header>
    {notice && <div role="status" style={{ ...styles.info, flex: 'none', maxHeight: 120, overflow: 'auto' }}>{notice}</div>}
    {pending && <div style={{ ...styles.info, minHeight: 0, maxHeight: '35%', overflow: 'auto' }} role="group" aria-label={tt('skills.conflicts')}>
      <strong>{tt('skills.conflicts')}</strong>: {pending.result.conflicts.join(', ')}
      <p>{tt('skills.replaceHint')}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button disabled={busy} onClick={() => { void install(pending.file, 'replace') }}>{tt('skills.replace')}</Button>
        <Button disabled={busy} onClick={() => { void install(pending.file, 'skip') }}>{tt('skills.skip')}</Button>
        <Button disabled={busy} onClick={() => setPending(undefined)}>{tt('skills.cancel')}</Button>
      </div>
    </div>}
    {!list ? <p>{tt('common.loading')}</p> : !list.skills.length ? <p style={styles.empty}>{tt('skills.empty')}</p> : <div className="dsh-skills-body">
      <nav className="dsh-skills-list" aria-label={tt('skills.title')}>
        {list.skills.map(skill => <button key={skill.name} className="dsh-skills-item" aria-current={selected === skill.name} onClick={() => { setSelected(skill.name); setNotice('') }}>
          <strong>{skill.name}</strong>
          <small>{[skill.version, skill.enabled ? tt('skills.enabled') : tt('mcp.off')].filter(Boolean).join(' · ')}</small>
          <small>{skill.description}</small>
        </button>)}
      </nav>
      {detail && <article className="dsh-skills-detail">
        <div style={{ ...styles.cardHead, flexWrap: 'wrap' }}>
          <h3 style={{ ...styles.cardTitle, flex: 1 }}>{detail.name}</h3>
          <Switch checked={detail.enabled} disabled={busy} label={tt('mcp.enabled')} onChange={enabled => { void run(async () => { applyList(await api.setSkillEnabled(detail.name, enabled)); setRevision(value => value + 1) }) }} />
          <Button size="sm" disabled={busy} onClick={() => { void run(() => api.openSkills(detail.name)) }}>{tt('skills.open')}</Button>
          <Button size="sm" style={styles.danger} disabled={busy} onClick={() => { if (window.confirm(tt('skills.deleteConfirm', { name: detail.name }))) void run(async () => { applyList(await api.deleteSkill(detail.name)); setRevision(value => value + 1) }) }}>{tt('mcp.delete')}</Button>
        </div>
        {detail.description && <p style={{ ...styles.meta, overflowWrap: 'anywhere', maxHeight: 80, overflow: 'auto' }}>{detail.description}</p>}
        <details className="dsh-skills-metadata"><summary>{tt('skills.metadata')}</summary><p>{detail.path}</p><pre>{JSON.stringify(detail.frontmatter, null, 2)}</pre></details>
        <div className="dsh-skills-files">
          <nav className="dsh-skills-tree" aria-label={tt('skills.files')}>
            {detail.files.map(entry => <button key={entry.path} aria-current={file === entry.path} onClick={() => { setFile(entry.path); setNotice('') }}>{entry.path}</button>)}
            {detail.truncated && <small>{tt('skills.truncated')}</small>}
          </nav>
          <div className="dsh-skills-preview">
            <div style={{ padding: 8, fontSize: 12, overflowWrap: 'anywhere' }}>{file}</div>
            {previewError ? <div role="status" style={{ padding: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }}>{previewError}</div> : <pre>{preview?.text ?? ''}</pre>}
            {preview?.truncated && <small>{tt('skills.truncated')}</small>}
          </div>
        </div>
      </article>}
    </div>}
  </section>
}
