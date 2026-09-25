import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { S3Api } from '../api.ts'
import type { S3ListPage, S3ObjectEntry, S3ProfileSummary } from '../../protocol.ts'
import { tt } from '../locales.ts'
import { BannerView, FileIcon, FolderIcon, Modal, baseName, errorMessage, formatDate, humanSize, type Banner } from './common.tsx'

export interface BrowserProps {
  api: S3Api
  profile: S3ProfileSummary
}

type Entry = { kind: 'folder'; key: string } | { kind: 'object'; key: string; object: S3ObjectEntry }

interface Listing {
  prefix: string
  folders: string[]
  objects: S3ObjectEntry[]
  nextToken?: string
  loading: boolean
  error?: string
}

type Dialog =
  | { kind: 'confirmDelete'; keys: string[] }
  | { kind: 'link'; key: string; url?: string; expiresIn: number; copied: boolean; error?: string }
  | { kind: 'preview'; key: string; text?: string; image?: string; truncated?: boolean; size?: number; error?: string; loading: boolean }
  | { kind: 'rename'; key: string; value: string; error?: string; busy: boolean }
  | { kind: 'folder'; value: string; error?: string; busy: boolean }

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

export function Browser(props: BrowserProps): JSX.Element {
  const { api, profile } = props
  const [prefix, setPrefix] = useState('')
  const [listing, setListing] = useState<Listing>({ prefix: '', folders: [], objects: [], loading: true })
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [banner, setBanner] = useState<Banner | undefined>()
  const [dialog, setDialog] = useState<Dialog | undefined>()
  const fileInput = useRef<HTMLInputElement | null>(null)
  const generation = useRef(0)

  const load = useCallback(async (target: string, append = false, token?: string): Promise<void> => {
    const gen = ++generation.current
    setListing(prev => append ? { ...prev, loading: true, error: undefined } : { prefix: target, folders: [], objects: [], loading: true })
    try {
      const page: S3ListPage = await api.list(profile.id, target, token)
      if (gen !== generation.current) return
      setListing(prev => ({
        prefix: target,
        folders: append ? [...prev.folders, ...page.folders] : page.folders,
        objects: append ? [...prev.objects, ...page.objects] : page.objects,
        nextToken: page.truncated ? page.nextToken : undefined,
        loading: false,
      }))
    } catch (error) {
      if (gen !== generation.current) return
      setListing(prev => ({ ...prev, loading: false, error: errorMessage(error) }))
    }
  }, [api, profile.id])

  // Profile switch resets to the root; prefix navigation reloads.
  useEffect(() => { setPrefix(''); setSelected(new Set()); setFilter('') }, [profile.id])
  useEffect(() => { setSelected(new Set()); setFilter(''); void load(prefix) }, [prefix, load])

  const entries = useMemo<Entry[]>(() => {
    const needle = filter.trim().toLowerCase()
    const rows: Entry[] = [
      ...listing.folders.map(key => ({ kind: 'folder', key }) as Entry),
      ...listing.objects.map(object => ({ kind: 'object', key: object.key, object }) as Entry),
    ]
    return needle === '' ? rows : rows.filter(row => baseName(row.key).toLowerCase().includes(needle))
  }, [listing, filter])

  const crumbs = useMemo(() => {
    const parts = prefix.split('/').filter(part => part !== '')
    const items: { label: string; prefix: string }[] = [{ label: profile.bucket + (profile.prefix !== '' ? `/${profile.prefix.replace(/\/$/, '')}` : ''), prefix: '' }]
    let acc = ''
    for (const part of parts) {
      acc += part + '/'
      items.push({ label: part, prefix: acc })
    }
    return items
  }, [prefix, profile.bucket, profile.prefix])

  const toggleSelect = (key: string): void => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const allSelected = entries.length > 0 && entries.every(row => selected.has(row.key))
  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(entries.map(row => row.key)))
  }

  // ------------------------------------------------------------ uploads
  const uploadFiles = async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files)
    for (const file of list) {
      const key = prefix + file.name
      setBanner({ kind: 'info', text: tt('browser.uploading', { name: file.name, percent: 0 }), progress: 0 })
      try {
        await api.upload(profile.id, key, file, (p) => {
          const ratio = p.total > 0 ? p.loaded / p.total : 0
          setBanner({ kind: 'info', text: tt('browser.uploading', { name: file.name, percent: Math.round(ratio * 100) }), progress: ratio })
        }).promise
        setBanner({ kind: 'ok', text: tt('browser.uploadDone', { name: file.name }) })
      } catch (error) {
        setBanner({ kind: 'error', text: tt('browser.uploadFail', { name: file.name, error: errorMessage(error) }) })
        break
      }
    }
    void load(prefix)
  }

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    if (event.dataTransfer.files.length > 0) void uploadFiles(event.dataTransfer.files)
  }

  // ------------------------------------------------------------- delete
  const runDelete = async (keys: string[]): Promise<void> => {
    setDialog(undefined)
    try {
      const result = await api.delete(profile.id, keys)
      if (result.errors.length > 0) {
        setBanner({ kind: 'error', text: `${tt('browser.deleteErrors', { count: result.errors.length })}: ${result.errors.slice(0, 3).map(e => `${e.key} (${e.error})`).join('; ')}` })
      } else {
        setBanner({ kind: 'ok', text: tt('browser.deleted', { count: result.deleted }) })
      }
    } catch (error) {
      setBanner({ kind: 'error', text: tt('error.generic', { error: errorMessage(error) }) })
    }
    setSelected(new Set())
    void load(prefix)
  }

  // ------------------------------------------------------------ presign
  const openLink = (key: string): void => {
    setDialog({ kind: 'link', key, expiresIn: 3600, copied: false })
    void refreshLink(key, 3600)
  }
  const refreshLink = async (key: string, expiresIn: number): Promise<void> => {
    try {
      const result = await api.presign(profile.id, key, expiresIn)
      setDialog(prev => prev?.kind === 'link' && prev.key === key ? { ...prev, url: result.url, expiresIn, copied: false, error: undefined } : prev)
    } catch (error) {
      setDialog(prev => prev?.kind === 'link' && prev.key === key ? { ...prev, url: undefined, expiresIn, error: errorMessage(error) } : prev)
    }
  }
  const copyLink = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      setDialog(prev => prev?.kind === 'link' ? { ...prev, copied: true } : prev)
    } catch {
      // Clipboard denied: the input stays selectable for manual copy.
    }
  }

  // ------------------------------------------------------------ preview
  const openPreview = async (object: S3ObjectEntry): Promise<void> => {
    if (IMAGE_RE.test(object.key)) {
      setDialog({ kind: 'preview', key: object.key, image: api.objectUrl(profile.id, object.key, true), loading: false, size: object.size })
      return
    }
    setDialog({ kind: 'preview', key: object.key, loading: true, size: object.size })
    try {
      const result = await api.text(profile.id, object.key)
      setDialog(prev => prev?.kind === 'preview' && prev.key === object.key ? { ...prev, text: result.text, truncated: result.truncated, size: result.size, loading: false } : prev)
    } catch (error) {
      const message = errorMessage(error)
      setDialog(prev => prev?.kind === 'preview' && prev.key === object.key ? { ...prev, error: /binary/i.test(message) ? tt('browser.previewBinary') : message, loading: false } : prev)
    }
  }

  // ------------------------------------------------------------- rename
  const runRename = async (key: string, value: string): Promise<void> => {
    const name = value.trim()
    if (name === '' || name.includes('/')) {
      setDialog(prev => prev?.kind === 'rename' ? { ...prev, error: tt('browser.renamePrompt') } : prev)
      return
    }
    const dir = key.slice(0, key.lastIndexOf('/') + 1)
    const target = dir + name
    if (target === key) { setDialog(undefined); return }
    setDialog(prev => prev?.kind === 'rename' ? { ...prev, busy: true, error: undefined } : prev)
    try {
      await api.copy(profile.id, key, target, true)
      setDialog(undefined)
      void load(prefix)
    } catch (error) {
      setDialog(prev => prev?.kind === 'rename' ? { ...prev, busy: false, error: errorMessage(error) } : prev)
    }
  }

  // ------------------------------------------------------------- folder
  const runMkdir = async (value: string): Promise<void> => {
    const name = value.trim().replace(/^\/+|\/+$/g, '')
    if (name === '') return
    setDialog(prev => prev?.kind === 'folder' ? { ...prev, busy: true, error: undefined } : prev)
    try {
      await api.mkdir(profile.id, prefix + name + '/')
      setDialog(undefined)
      setBanner({ kind: 'ok', text: tt('browser.folderCreated', { name }) })
      void load(prefix)
    } catch (error) {
      setDialog(prev => prev?.kind === 'folder' ? { ...prev, busy: false, error: errorMessage(error) } : prev)
    }
  }

  const download = (key: string): void => {
    const anchor = document.createElement('a')
    anchor.href = api.objectUrl(profile.id, key)
    anchor.download = baseName(key)
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  return (
    <div className="dsh-s3-browser" onDragOver={(event) => { event.preventDefault() }} onDrop={onDrop}>
      <div className="dsh-s3-toolbar">
        <nav className="dsh-s3-crumbs" aria-label="path">
          {crumbs.map((crumb, index) => {
            const current = index === crumbs.length - 1
            return (
              <span key={crumb.prefix} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
                {index > 0 && <span className="dsh-s3-crumbSep">/</span>}
                <button type="button" className="dsh-s3-crumb" {...(current ? { 'data-current': '' } : {})} onClick={() => { if (!current) setPrefix(crumb.prefix) }} title={crumb.prefix === '' ? tt('browser.root') : crumb.prefix}>
                  {crumb.label}
                </button>
              </span>
            )
          })}
        </nav>
        <input className="dsh-s3-input dsh-s3-filter" value={filter} onChange={(e) => { setFilter(e.target.value) }} placeholder={tt('browser.filter')} />
        <button type="button" className="dsh-s3-ghost" onClick={() => { void load(prefix) }} disabled={listing.loading}>{tt('browser.refresh')}</button>
        <button type="button" className="dsh-s3-ghost" onClick={() => { setDialog({ kind: 'folder', value: '', busy: false }) }}>{tt('browser.newFolder')}</button>
        <button type="button" className="dsh-s3-primary" onClick={() => { fileInput.current?.click() }}>{tt('browser.upload')}</button>
        <input ref={fileInput} type="file" multiple className="dsh-s3-hiddenFile" onChange={(e) => { if (e.target.files !== null && e.target.files.length > 0) { void uploadFiles(e.target.files); e.target.value = '' } }} />
      </div>

      <BannerView banner={banner} onClose={() => { setBanner(undefined) }} />

      <div className="dsh-s3-tableWrap">
        {listing.error !== undefined ? (
          <div className="dsh-s3-empty" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{listing.error}</div>
        ) : listing.loading && entries.length === 0 ? (
          <div className="dsh-s3-loading">{tt('browser.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="dsh-s3-empty">{tt('browser.empty')}</div>
        ) : (
          <table className="dsh-s3-table">
            <thead>
              <tr>
                <th className="dsh-s3-colCheck"><input type="checkbox" className="dsh-s3-check" checked={allSelected} onChange={toggleAll} aria-label="select all" /></th>
                <th>{tt('browser.col.name')}</th>
                <th className="dsh-s3-colSize">{tt('browser.col.size')}</th>
                <th className="dsh-s3-colDate">{tt('browser.col.modified')}</th>
                <th className="dsh-s3-colActions">{tt('browser.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(row => (
                <tr key={row.key} {...(selected.has(row.key) ? { 'data-selected': '' } : {})}>
                  <td className="dsh-s3-colCheck"><input type="checkbox" className="dsh-s3-check" checked={selected.has(row.key)} onChange={() => { toggleSelect(row.key) }} aria-label={row.key} /></td>
                  <td style={{ maxWidth: 0, width: '60%' }}>
                    {row.kind === 'folder' ? (
                      <button type="button" className="dsh-s3-nameBtn" onClick={() => { setPrefix(row.key) }} title={row.key}><FolderIcon /><span className="dsh-s3-nameText">{baseName(row.key)}</span></button>
                    ) : (
                      <button type="button" className="dsh-s3-nameBtn" onClick={() => { void openPreview(row.object) }} title={row.key}><FileIcon /><span className="dsh-s3-nameText">{baseName(row.key)}</span></button>
                    )}
                  </td>
                  <td className="dsh-s3-colSize">{row.kind === 'object' ? humanSize(row.object.size) : '-'}</td>
                  <td className="dsh-s3-colDate">{row.kind === 'object' ? formatDate(row.object.lastModified) : '-'}</td>
                  <td className="dsh-s3-colActions">
                    <span className="dsh-s3-rowActions">
                      {row.kind === 'object' && <>
                        <button type="button" className="dsh-s3-link" onClick={() => { download(row.key) }}>{tt('browser.download')}</button>
                        <button type="button" className="dsh-s3-link" onClick={() => { openLink(row.key) }}>{tt('browser.link')}</button>
                        <button type="button" className="dsh-s3-link" onClick={() => { setDialog({ kind: 'rename', key: row.key, value: baseName(row.key), busy: false }) }}>{tt('browser.rename')}</button>
                      </>}
                      <button type="button" className="dsh-s3-link" data-danger onClick={() => { setDialog({ kind: 'confirmDelete', keys: [row.key] }) }}>{tt('browser.delete')}</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="dsh-s3-footer">
        {selected.size > 0 ? (
          <>
            <span>{tt('browser.selected', { count: selected.size })}</span>
            <button type="button" className="dsh-s3-link" data-danger onClick={() => { setDialog({ kind: 'confirmDelete', keys: [...selected] }) }}>{tt('browser.deleteSelected')}</button>
            <button type="button" className="dsh-s3-link" onClick={() => { setSelected(new Set()) }}>{tt('browser.clearSelection')}</button>
          </>
        ) : (
          <span>{listing.folders.length + listing.objects.length > 0 ? `${listing.folders.length} / ${listing.objects.length}` : ''}</span>
        )}
        <span className="dsh-s3-spacer" />
        {listing.nextToken !== undefined && (
          <button type="button" className="dsh-s3-ghost" disabled={listing.loading} onClick={() => { void load(prefix, true, listing.nextToken) }}>{listing.loading ? tt('browser.loading') : tt('browser.loadMore')}</button>
        )}
      </div>

      {dialog?.kind === 'confirmDelete' && (
        <Modal title={tt('browser.deleteConfirmTitle')} onClose={() => { setDialog(undefined) }} footer={<>
          <button type="button" className="dsh-s3-ghost" onClick={() => { setDialog(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-s3-primary" data-danger onClick={() => { void runDelete(dialog.keys) }}>{tt('browser.deleteConfirmOk')}</button>
        </>}>
          <p style={{ margin: 0 }}>{tt('browser.deleteConfirmBody', { count: dialog.keys.length })}</p>
          <ul className="dsh-s3-keyList">{dialog.keys.map(key => <li key={key}>{key}</li>)}</ul>
        </Modal>
      )}

      {dialog?.kind === 'link' && (
        <Modal title={tt('browser.linkTitle')} onClose={() => { setDialog(undefined) }} footer={
          <button type="button" className="dsh-s3-ghost" onClick={() => { setDialog(undefined) }}>{tt('browser.close')}</button>
        }>
          <div className="dsh-s3-meta">{dialog.key}</div>
          <label className="dsh-s3-field">
            <span className="dsh-s3-fieldLabel">{tt('browser.linkExpires')}</span>
            <select className="dsh-s3-select" value={dialog.expiresIn} onChange={(e) => { void refreshLink(dialog.key, Number(e.target.value)) }}>
              <option value={3600}>{tt('browser.exp.1h')}</option>
              <option value={86400}>{tt('browser.exp.1d')}</option>
              <option value={604800}>{tt('browser.exp.7d')}</option>
            </select>
          </label>
          {dialog.error !== undefined && <div className="dsh-s3-formError">{dialog.error}</div>}
          <div className="dsh-s3-linkRow">
            <input className="dsh-s3-input" data-mono readOnly value={dialog.url ?? tt('browser.loading')} onFocus={(e) => { e.target.select() }} />
            <button type="button" className="dsh-s3-primary" disabled={dialog.url === undefined} onClick={() => { if (dialog.url !== undefined) void copyLink(dialog.url) }}>{dialog.copied ? tt('browser.linkCopied') : tt('browser.linkCopy')}</button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'preview' && (
        <Modal title={baseName(dialog.key)} wide onClose={() => { setDialog(undefined) }} footer={<>
          <button type="button" className="dsh-s3-ghost" onClick={() => { download(dialog.key) }}>{tt('browser.download')}</button>
          <button type="button" className="dsh-s3-ghost" onClick={() => { setDialog(undefined) }}>{tt('browser.close')}</button>
        </>}>
          <div className="dsh-s3-meta">{dialog.key}{dialog.size !== undefined ? ` · ${humanSize(dialog.size)}` : ''}</div>
          {dialog.loading ? (
            <div className="dsh-s3-loading">{tt('browser.loading')}</div>
          ) : dialog.error !== undefined ? (
            <div className="dsh-s3-formError">{dialog.error}</div>
          ) : dialog.image !== undefined ? (
            <img className="dsh-s3-previewImg" src={dialog.image} alt={dialog.key} />
          ) : (
            <>
              <pre className="dsh-s3-pre">{dialog.text}</pre>
              {dialog.truncated && <div className="dsh-s3-fieldHint">{tt('browser.previewTruncated', { size: '512 KB' })}</div>}
            </>
          )}
        </Modal>
      )}

      {dialog?.kind === 'rename' && (
        <Modal title={tt('browser.rename')} onClose={() => { setDialog(undefined) }} footer={<>
          <button type="button" className="dsh-s3-ghost" disabled={dialog.busy} onClick={() => { setDialog(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-s3-primary" disabled={dialog.busy} onClick={() => { void runRename(dialog.key, dialog.value) }}>{dialog.busy ? tt('form.saving') : tt('form.save')}</button>
        </>}>
          <div className="dsh-s3-meta">{dialog.key}</div>
          <label className="dsh-s3-field">
            <span className="dsh-s3-fieldLabel">{tt('browser.renamePrompt')}</span>
            <input className="dsh-s3-input" data-mono autoFocus value={dialog.value} onChange={(e) => { setDialog({ ...dialog, value: e.target.value }) }} onKeyDown={(e) => { if (e.key === 'Enter') void runRename(dialog.key, dialog.value) }} />
          </label>
          {dialog.error !== undefined && <div className="dsh-s3-formError">{dialog.error}</div>}
        </Modal>
      )}

      {dialog?.kind === 'folder' && (
        <Modal title={tt('browser.newFolder')} onClose={() => { setDialog(undefined) }} footer={<>
          <button type="button" className="dsh-s3-ghost" disabled={dialog.busy} onClick={() => { setDialog(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-s3-primary" disabled={dialog.busy || dialog.value.trim() === ''} onClick={() => { void runMkdir(dialog.value) }}>{dialog.busy ? tt('form.saving') : tt('form.save')}</button>
        </>}>
          <div className="dsh-s3-meta">{prefix === '' ? tt('browser.root') : prefix}</div>
          <label className="dsh-s3-field">
            <span className="dsh-s3-fieldLabel">{tt('browser.newFolderPrompt')}</span>
            <input className="dsh-s3-input" data-mono autoFocus value={dialog.value} onChange={(e) => { setDialog({ ...dialog, value: e.target.value }) }} onKeyDown={(e) => { if (e.key === 'Enter') void runMkdir(dialog.value) }} />
          </label>
          {dialog.error !== undefined && <div className="dsh-s3-formError">{dialog.error}</div>}
        </Modal>
      )}
    </div>
  )
}
