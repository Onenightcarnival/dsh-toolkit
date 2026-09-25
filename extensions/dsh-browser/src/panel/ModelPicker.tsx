/**
 * Composer chip that names the model the next request will use, and the menu
 * that changes it: every provider dsh has configured, its models, and the
 * reasoning efforts of the chosen model. Selection is applied by the parent
 * through `session.selectModel`; this component only renders and reports.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PanelCopy } from './strings.ts'
import {
  findCatalogModel,
  providerRoutable,
  sameSelection,
  selectionForModel,
  selectionLabel,
  type ModelCatalog,
  type ModelSelection,
} from './models.ts'

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

export interface ModelPickerProps {
  catalog: ModelCatalog | null
  /** Loading state of the catalog while the menu is open. */
  loading: boolean
  /** Catalog load failure, shown inside the menu. */
  loadError: string | null
  selection: ModelSelection | null
  open: boolean
  disabled: boolean
  busy: boolean
  copy: PanelCopy
  onToggle: () => void
  onClose: () => void
  onSelect: (selection: ModelSelection) => void
}

export function ModelPicker({
  catalog, loading, loadError, selection, open, disabled, busy, copy, onToggle, onClose, onSelect,
}: ModelPickerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  // The composer box clips overflow, so the menu is fixed to the viewport and
  // anchored above the chip; re-anchored on resize while open.
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const place = (): void => {
      const rect = chipRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      setAnchor({ left: Math.max(8, rect.left), bottom: Math.max(8, window.innerHeight - rect.top + 6) })
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  const label = selectionLabel(catalog, selection)
  const current = findCatalogModel(catalog, selection)
  const efforts = current?.model.reasoning?.efforts ?? []

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-chip"
        ref={chipRef}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={copy.model.open}
        title={label === '' ? copy.model.open : `${copy.model.open}: ${label}`}
        onClick={onToggle}
      >
        <span className="model-chip-label">{label === '' ? copy.model.unknown : label}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div
          className="model-menu"
          role="listbox"
          aria-label={copy.model.title}
          aria-busy={busy || loading}
          style={anchor === null ? undefined : { left: anchor.left, bottom: anchor.bottom }}
        >
          {loading && catalog === null && <p className="model-menu-note">{copy.model.loading}</p>}
          {loadError !== null && <p className="model-menu-note model-menu-error">{copy.model.loadFailed(loadError)}</p>}
          {catalog !== null && catalog.groups.length === 0 && loadError === null && (
            <p className="model-menu-note">{copy.model.empty}</p>
          )}
          {catalog !== null && catalog.groups.map((group) => {
            const routable = providerRoutable(catalog, group.id)
            return (
              <section className="model-group" key={group.id} aria-label={group.name}>
                <header className="model-group-name">
                  <span>{group.name}</span>
                  {!routable && <span className="model-group-flag">{copy.model.unroutable}</span>}
                </header>
                {group.models.length === 0 && <p className="model-menu-note">{copy.model.groupEmpty}</p>}
                {group.models.map((model) => {
                  const candidate = selectionForModel(group, model, selection)
                  const selected = selection !== null && selection.provider === group.id && selection.model === model.id
                  return (
                    <button
                      type="button"
                      key={model.id}
                      role="option"
                      aria-selected={selected}
                      className={`model-option${selected ? ' selected' : ''}`}
                      disabled={busy || !routable}
                      title={model.description ?? model.id}
                      onClick={() => { if (!sameSelection(selection, candidate)) onSelect(candidate) }}
                    >
                      <span className="model-option-name">{model.name}</span>
                      {model.name !== model.id && <span className="model-option-id">{model.id}</span>}
                    </button>
                  )
                })}
              </section>
            )
          })}
          {catalog !== null && catalog.failures.length > 0 && (
            <p className="model-menu-note model-menu-error">
              {copy.model.failures(catalog.failures.map((failure) => failure.name).join(', '))}
            </p>
          )}
          {selection !== null && efforts.length > 0 && (
            <section className="model-efforts" aria-label={copy.model.reasoning}>
              <header className="model-group-name"><span>{copy.model.reasoning}</span></header>
              <div className="model-effort-row" role="radiogroup" aria-label={copy.model.reasoning}>
                {efforts.map((effort) => {
                  const active = selection.reasoningEffort === effort.id
                  return (
                    <button
                      type="button"
                      key={effort.id}
                      role="radio"
                      aria-checked={active}
                      className={`model-effort${active ? ' selected' : ''}`}
                      disabled={busy}
                      title={effort.description ?? effort.name}
                      onClick={() => { if (!active) onSelect({ ...selection, reasoningEffort: effort.id }) }}
                    >{effort.name}</button>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
