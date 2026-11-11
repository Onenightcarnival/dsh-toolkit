import { useState } from 'react'
import { DEFAULT_TIMEOUT_MS, HTTP_AUTH_TYPES, type HttpAuth, type HttpAuthPayload, type HttpAuthType, type HttpTargetPayload, type HttpTargetSummary } from '../../protocol.ts'
import { tt, type HttpKey } from '../locales.ts'
import { Modal, errorMessage } from './common.tsx'
import { KeyValueEditor, recordToRows, rowsToRecord, type KeyValueRow } from './KeyValueEditor.tsx'

export interface TargetFormProps {
  mode: 'create' | 'edit'
  target?: HttpTargetSummary
  onCancel: () => void
  onSave: (payload: HttpTargetPayload) => Promise<void>
  /** Edit mode: ask to delete the target. */
  onDelete?: () => void
  /** Create mode: base URL the form starts with. */
  initialBaseUrl?: string
  /** Create mode: authentication the form starts with. */
  initialAuth?: HttpAuth
}

/** Create / edit dialog; on edit, empty secret fields keep the stored values. */
export function TargetForm(props: TargetFormProps): JSX.Element {
  const t = props.target
  const [name, setName] = useState(t?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(t?.baseUrl ?? props.initialBaseUrl ?? '')
  const seed = t === undefined ? props.initialAuth : undefined
  const [authType, setAuthType] = useState<HttpAuthType>(t?.auth.type ?? seed?.type ?? 'none')
  const [token, setToken] = useState(seed?.type === 'bearer' ? seed.token : '')
  const [username, setUsername] = useState(t?.auth.type === 'basic' ? t.auth.username : seed?.type === 'basic' ? seed.username : '')
  const [password, setPassword] = useState(seed?.type === 'basic' ? seed.password : '')
  const [authName, setAuthName] = useState(t?.auth.type === 'header' || t?.auth.type === 'query' ? t.auth.name : seed?.type === 'header' || seed?.type === 'query' ? seed.name : '')
  const [authValue, setAuthValue] = useState(seed?.type === 'header' || seed?.type === 'query' ? seed.value : '')
  const [headers, setHeaders] = useState<KeyValueRow[]>(recordToRows(t?.headers))
  const [variables, setVariables] = useState<KeyValueRow[]>(recordToRows(t?.variables))
  const [allowedHosts, setAllowedHosts] = useState((t?.allowedHosts ?? []).join('\n'))
  const [allowMutations, setAllowMutations] = useState(t?.allowMutations ?? false)
  const [allowPrivate, setAllowPrivate] = useState(t?.allowPrivate ?? false)
  const [timeoutMs, setTimeoutMs] = useState(String(t?.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const [advanced, setAdvanced] = useState(t !== undefined && (t.allowedHosts.length > 0 || t.allowPrivate || t.timeoutMs !== DEFAULT_TIMEOUT_MS || Object.keys(t.variables).length > 0))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const sameAuthType = t !== undefined && t.auth.type === authType
  const secretPlaceholder = sameAuthType ? tt('form.auth.keep') : ''

  const auth = (): HttpAuthPayload => {
    switch (authType) {
      case 'none': return { type: 'none' }
      case 'bearer': return { type: 'bearer', token }
      case 'basic': return { type: 'basic', username, password }
      case 'header': return { type: 'header', name: authName, value: authValue }
      case 'query': return { type: 'query', name: authName, value: authValue }
    }
  }

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      await props.onSave({
        name,
        baseUrl,
        auth: auth(),
        headers: rowsToRecord(headers),
        variables: rowsToRecord(variables),
        allowedHosts: allowedHosts.split(/\r?\n/).map(s => s.trim()).filter(s => s !== ''),
        allowMutations,
        allowPrivate,
        timeoutMs: Number(timeoutMs),
      })
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <Modal
      title={props.mode === 'create' ? tt('form.title.create') : tt('form.title.edit', { name: t?.name ?? '' })}
      wide
      onClose={props.onCancel}
      footer={<>
        {props.onDelete !== undefined && <button type="button" className="dsh-http-link" data-danger onClick={props.onDelete} disabled={saving}>{tt('targets.delete')}</button>}
        <span className="dsh-http-spacer" />
        <button type="button" className="dsh-http-ghost" onClick={props.onCancel} disabled={saving}>{tt('form.cancel')}</button>
        <button type="button" className="dsh-http-primary" onClick={() => { void submit() }} disabled={saving}>{saving ? tt('form.saving') : tt('form.save')}</button>
      </>}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit() }} className="dsh-http-form">
        <div className="dsh-http-formRow">
          <label className="dsh-http-field" style={{ flex: 2 }}>
            <span className="dsh-http-fieldLabel">{tt('form.baseUrl')}</span>
            <input className="dsh-http-input" data-mono value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value) }} autoFocus placeholder="https://api.example.com/v1" autoCapitalize="off" spellCheck={false} />
          </label>
          <label className="dsh-http-field">
            <span className="dsh-http-fieldLabel">{tt('form.name')}</span>
            <input className="dsh-http-input" value={name} onChange={(e) => { setName(e.target.value) }} placeholder={tt('form.namePlaceholder')} />
          </label>
        </div>

        <div className="dsh-http-field">
          <span className="dsh-http-fieldLabel">{tt('form.auth')}</span>
          <div className="dsh-http-segments" role="radiogroup">
            {HTTP_AUTH_TYPES.map(type => (
              <button key={type} type="button" role="radio" aria-checked={authType === type} className="dsh-http-segment" {...(authType === type ? { 'data-active': '' } : {})} onClick={() => { setAuthType(type) }}>{tt(`form.auth.${type}` as HttpKey)}</button>
            ))}
          </div>
        </div>
        {authType === 'bearer' && (
          <label className="dsh-http-field">
            <span className="dsh-http-fieldLabel">{tt('form.auth.token')}</span>
            <input className="dsh-http-input" data-mono type="password" value={token} onChange={(e) => { setToken(e.target.value) }} autoComplete="new-password" placeholder={secretPlaceholder} />
          </label>
        )}
        {authType === 'basic' && (
          <div className="dsh-http-formRow">
            <label className="dsh-http-field">
              <span className="dsh-http-fieldLabel">{tt('form.auth.username')}</span>
              <input className="dsh-http-input" data-mono value={username} onChange={(e) => { setUsername(e.target.value) }} autoComplete="off" autoCapitalize="off" spellCheck={false} />
            </label>
            <label className="dsh-http-field">
              <span className="dsh-http-fieldLabel">{tt('form.auth.password')}</span>
              <input className="dsh-http-input" data-mono type="password" value={password} onChange={(e) => { setPassword(e.target.value) }} autoComplete="new-password" placeholder={secretPlaceholder} />
            </label>
          </div>
        )}
        {(authType === 'header' || authType === 'query') && (
          <div className="dsh-http-formRow">
            <label className="dsh-http-field">
              <span className="dsh-http-fieldLabel">{tt(authType === 'header' ? 'form.auth.headerName' : 'form.auth.queryName')}</span>
              <input className="dsh-http-input" data-mono value={authName} onChange={(e) => { setAuthName(e.target.value) }} placeholder={authType === 'header' ? 'X-API-Key' : 'api_key'} autoCapitalize="off" spellCheck={false} />
            </label>
            <label className="dsh-http-field" style={{ flex: 2 }}>
              <span className="dsh-http-fieldLabel">{tt('form.auth.value')}</span>
              <input className="dsh-http-input" data-mono type="password" value={authValue} onChange={(e) => { setAuthValue(e.target.value) }} autoComplete="new-password" placeholder={secretPlaceholder} />
            </label>
          </div>
        )}

        <div className="dsh-http-field">
          <span className="dsh-http-fieldLabel">{tt('form.headers')}</span>
          <KeyValueEditor rows={headers} onChange={setHeaders} />
        </div>

        <label className="dsh-http-checkRow">
          <input type="checkbox" className="dsh-http-check" checked={allowMutations} onChange={(e) => { setAllowMutations(e.target.checked) }} />
          <span>{tt('form.allowMutations')}</span>
        </label>

        <button type="button" className="dsh-http-link" onClick={() => { setAdvanced(!advanced) }} aria-expanded={advanced}>{advanced ? '▾' : '▸'} {tt('form.advanced')}</button>
        {advanced && (
          <>
            <div className="dsh-http-field">
              <span className="dsh-http-fieldLabel">{tt('form.variables')}</span>
              <KeyValueEditor rows={variables} onChange={setVariables} />
              <span className="dsh-http-fieldHint">{tt('form.variablesHint')}</span>
            </div>
            <label className="dsh-http-field">
              <span className="dsh-http-fieldLabel">{tt('form.allowedHosts')}</span>
              <textarea className="dsh-http-input dsh-http-textarea" data-mono rows={2} value={allowedHosts} onChange={(e) => { setAllowedHosts(e.target.value) }} placeholder={'cdn.example.com\n*.example.net'} spellCheck={false} />
              <span className="dsh-http-fieldHint">{tt('form.allowedHostsHint')}</span>
            </label>
            <div className="dsh-http-formRow">
              <label className="dsh-http-field" style={{ flex: 0, minWidth: 160 }}>
                <span className="dsh-http-fieldLabel">{tt('form.timeout')}</span>
                <input className="dsh-http-input" data-mono inputMode="numeric" value={timeoutMs} onChange={(e) => { setTimeoutMs(e.target.value) }} />
              </label>
              <label className="dsh-http-checkRow" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>
                <input type="checkbox" className="dsh-http-check" checked={allowPrivate} onChange={(e) => { setAllowPrivate(e.target.checked) }} />
                <span>{tt('form.allowPrivate')}</span>
              </label>
            </div>
          </>
        )}
        {error !== undefined && <div className="dsh-http-formError">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
