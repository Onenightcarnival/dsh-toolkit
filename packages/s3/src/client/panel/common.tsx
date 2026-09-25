import { useEffect, type ReactNode } from 'react'
import { tt } from '../locales.ts'

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatDate(iso: string): string {
  if (iso === '') return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function baseName(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

export interface Banner { kind: 'ok' | 'error' | 'info'; text: string; progress?: number }

export function Modal(props: { title: string; wide?: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode }): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') props.onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [props.onClose])
  return (
    <div className="dsh-s3-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose() }}>
      <div className="dsh-s3-modal" role="dialog" aria-modal="true" aria-label={props.title} {...(props.wide ? { 'data-wide': '' } : {})}>
        <h3 className="dsh-s3-modalTitle">{props.title}</h3>
        {props.children}
        {props.footer !== undefined && <div className="dsh-s3-modalFooter">{props.footer}</div>}
      </div>
    </div>
  )
}

export function BannerView(props: { banner: Banner | undefined; onClose: () => void }): JSX.Element | null {
  if (props.banner === undefined) return null
  return (
    <div className="dsh-s3-banner" data-kind={props.banner.kind} role="status">
      <span>
        {props.banner.text}
        {props.banner.progress !== undefined && (
          <div className="dsh-s3-progressTrack" style={{ marginTop: 6 }}><div className="dsh-s3-progressBar" style={{ width: `${Math.round(props.banner.progress * 100)}%` }} /></div>
        )}
      </span>
      <button type="button" className="dsh-s3-link" onClick={props.onClose} aria-label={tt('browser.close')}>×</button>
    </div>
  )
}

export function FolderIcon(): JSX.Element {
  return <svg className="dsh-s3-icon" data-kind="folder" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2c.4 0 .8.16 1.06.44L8.5 3.5H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12v-8.5z"/></svg>
}

export function FileIcon(): JSX.Element {
  return <svg className="dsh-s3-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M4 1.75h5l3.25 3.25v9.25H4z"/><path d="M9 1.75V5h3.25"/></svg>
}
