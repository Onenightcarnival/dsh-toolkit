import { useEffect, useRef, useState } from 'react'
import type { HttpSavedRequest } from '../../protocol.ts'
import { tt } from '../locales.ts'

export interface RequestListProps {
  requests: HttpSavedRequest[]
  selectedId?: string
  filter: string
  onFilter: (value: string) => void
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => void
  onDuplicate: (id: string) => void
  onCopyCurl: (id: string) => void
  onDelete: (id: string) => void
}

/** Sidebar label of a saved request: its name, else its path, else the untitled label. */
export function requestTitle(request: HttpSavedRequest): string {
  return request.name !== '' ? request.name : request.path.trim() !== '' ? request.path.trim() : tt('requests.untitled')
}

/** Saved requests of the active target: filter, select, rename in place, duplicate, delete. */
export function RequestList(props: RequestListProps): JSX.Element {
  const [menuId, setMenuId] = useState<string | undefined>()
  const [renaming, setRenaming] = useState<{ id: string; value: string } | undefined>()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (menuId === undefined) return
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !(event.target instanceof Element && event.target.closest('[data-http-menu]') !== null)) setMenuId(undefined)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [menuId])

  const needle = props.filter.trim().toLowerCase()
  const shown = props.requests.filter(request => needle === '' || `${request.method} ${request.name} ${request.path}`.toLowerCase().includes(needle))

  const commitRename = (): void => {
    if (renaming === undefined) return
    props.onRename(renaming.id, renaming.value.trim())
    setRenaming(undefined)
  }

  return (
    <>
      <div className="dsh-http-sideFilter">
        <input className="dsh-http-input" value={props.filter} placeholder={tt('requests.filter')} onChange={(e) => { props.onFilter(e.target.value) }} spellCheck={false} aria-label={tt('requests.filter')} />
      </div>
      <div className="dsh-http-historyList" role="list" ref={listRef}>
        {shown.length === 0 && <div className="dsh-http-hint">{props.requests.length === 0 ? tt('requests.empty') : tt('requests.noMatch')}</div>}
        {shown.map(request => (
          <div key={request.id} role="listitem" className="dsh-http-item" {...(request.id === props.selectedId ? { 'data-active': '' } : {})} {...(menuId === request.id ? { 'data-menu-open': '' } : {})}>
            {renaming?.id === request.id ? (
              <div className="dsh-http-itemMain">
                <span className="dsh-http-itemLine">
                  <span className="dsh-http-methodText" data-method={request.method}>{request.method}</span>
                  <input
                    className="dsh-http-input dsh-http-renameInput"
                    value={renaming.value}
                    autoFocus
                    placeholder={request.path.trim() || tt('requests.untitled')}
                    aria-label={tt('requests.rename')}
                    onChange={(e) => { setRenaming({ id: request.id, value: e.target.value }) }}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(undefined) }
                    }}
                  />
                </span>
              </div>
            ) : (
              <button type="button" className="dsh-http-itemMain" onClick={() => { props.onSelect(request.id) }} onDoubleClick={() => { setRenaming({ id: request.id, value: request.name }) }} title={request.name !== '' ? `${request.name}\n${request.method} ${request.path}` : `${request.method} ${request.path}`}>
                <span className="dsh-http-itemLine">
                  <span className="dsh-http-methodText" data-method={request.method}>{request.method}</span>
                  <span className="dsh-http-itemPath" {...(request.name !== '' ? { 'data-named': '' } : {})}>{requestTitle(request)}</span>
                </span>
              </button>
            )}
            {renaming?.id !== request.id && (
              <div className="dsh-http-itemMenu" data-http-menu>
                <button type="button" className="dsh-http-iconButton" aria-label={tt('requests.actions')} title={tt('requests.actions')} aria-haspopup="menu" aria-expanded={menuId === request.id} onClick={() => { setMenuId(menuId === request.id ? undefined : request.id) }}>⋯</button>
                {menuId === request.id && (
                  <div className="dsh-http-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setMenuId(undefined); setRenaming({ id: request.id, value: request.name }) }}>{tt('requests.rename')}</button>
                    <button type="button" role="menuitem" onClick={() => { setMenuId(undefined); props.onDuplicate(request.id) }}>{tt('requests.duplicate')}</button>
                    <button type="button" role="menuitem" onClick={() => { setMenuId(undefined); props.onCopyCurl(request.id) }}>{tt('requests.copyCurl')}</button>
                    <button type="button" role="menuitem" data-danger onClick={() => { setMenuId(undefined); props.onDelete(request.id) }}>{tt('requests.delete')}</button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
