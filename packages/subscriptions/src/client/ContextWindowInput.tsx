import { useEffect, useId, useState } from 'react'
import type { Model } from '../protocol.ts'
import { formatCapacity, parseCapacity } from './capacity.ts'
import { tt } from './locales.ts'

export function ContextWindowInput({ model, configured, disabled, save }: {
  model: Model
  configured?: number
  disabled: boolean
  save: (value: number | undefined) => Promise<boolean>
}): JSX.Element {
  const initial = configured === undefined ? '' : formatCapacity(configured)
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState('')
  const hintId = useId()
  useEffect(() => { setDraft(initial); setError('') }, [initial, model.id])
  const fallback = model.defaultContextWindow ?? model.contextWindow
  const dirty = draft !== initial
  const submit = (): void => {
    const value = parseCapacity(draft)
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      setError(tt('contextInvalid')); return
    }
    if (value !== undefined && model.maxContextWindow !== undefined && value > model.maxContextWindow) {
      setError(tt('contextTooLarge', { max: formatCapacity(model.maxContextWindow) })); return
    }
    setError('')
    void save(value).then(saved => { if (saved) setDraft(value === undefined ? '' : formatCapacity(value)) })
  }
  return <form className="dsh-sub-context" onSubmit={e => { e.preventDefault(); submit() }}>
    <div className="dsh-sub-contextControls">
      <input aria-label={`${model.name} ${tt('context')}`} aria-describedby={hintId} aria-invalid={!!error}
        disabled={disabled} value={draft} placeholder={fallback === undefined ? '256K / 1M' : formatCapacity(fallback)}
        autoComplete="off" spellCheck={false}
        onChange={e => { setDraft(e.target.value); setError('') }}
        onKeyDown={e => { if (e.key === 'Escape') { setDraft(initial); setError('') } }}/>
      {dirty && <button disabled={disabled} aria-label={`${model.name} ${tt('saveContext')}`}>{tt('save')}</button>}
      {!dirty && configured !== undefined && <button type="button" className="dsh-sub-link" disabled={disabled}
        aria-label={`${model.name} ${tt('resetContext')}`} onClick={() => { setError(''); void save(undefined) }}>{tt('resetContext')}</button>}
    </div>
    <small id={hintId}>{fallback === undefined ? tt('providerDefault') : tt('contextDefault', { value: formatCapacity(fallback) })}
      {model.maxContextWindow !== undefined ? ` · ${tt('contextMax', { value: formatCapacity(model.maxContextWindow) })}` : ''}</small>
    {configured !== undefined && model.contextWindow !== undefined && configured !== model.contextWindow && <small>{tt('contextEffective', { value: formatCapacity(model.contextWindow) })}</small>}
    {error && <small className="dsh-sub-fieldError" role="alert">{error}</small>}
  </form>
}
