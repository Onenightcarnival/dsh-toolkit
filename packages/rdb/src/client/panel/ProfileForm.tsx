import { useState } from 'react'
import { TARGET_SESSION_ATTRS, type DbKind, type DbProfilePayload, type DbProfileSummary, type TargetSessionAttrs } from '../../protocol.ts'
import { tt } from '../locales.ts'
import { Modal, errorMessage } from './common.tsx'

export interface ProfileFormProps {
  mode: 'create' | 'edit'
  profile?: DbProfileSummary
  onCancel: () => void
  onSave: (payload: DbProfilePayload) => Promise<void>
}

const DEFAULT_PORT: Record<DbKind, number> = { sqlite: 0, postgres: 5432, gaussdb: 8000, mysql: 3306 }

export function ProfileForm(props: ProfileFormProps): JSX.Element {
  const p = props.profile
  const [kind, setKind] = useState<DbKind>(p?.kind ?? 'postgres')
  const [file, setFile] = useState(p?.file ?? '')
  const [host, setHost] = useState(p?.host ?? '')
  const [port, setPort] = useState(p !== undefined && p.port > 0 ? String(p.port) : '')
  const [database, setDatabase] = useState(p?.database ?? '')
  const [user, setUser] = useState(p?.user ?? '')
  const [password, setPassword] = useState('')
  const [ssl, setSsl] = useState(p?.ssl ?? false)
  const [target, setTarget] = useState<TargetSessionAttrs>(p?.targetSessionAttrs ?? 'any')
  const [loadBalance, setLoadBalance] = useState(p?.loadBalanceHosts ?? false)
  const [name, setName] = useState(p?.name ?? '')
  const [allowWrite, setAllowWrite] = useState(p?.allowWrite ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const changeKind = (next: DbKind): void => {
    setKind(next)
    if (port === '' || port === String(DEFAULT_PORT[kind])) setPort(next === 'sqlite' ? '' : String(DEFAULT_PORT[next]))
  }

  const submit = async (): Promise<void> => {
    setSaving(true); setError(undefined)
    try {
      const payload: DbProfilePayload = { kind, name, ssl, allowWrite }
      if (kind === 'sqlite') payload.file = file
      else {
        payload.host = host; payload.database = database; payload.user = user
        payload.port = port.trim() === '' ? DEFAULT_PORT[kind] : Number(port)
        payload.targetSessionAttrs = target; payload.loadBalanceHosts = loadBalance
        if (password !== '' || props.mode === 'create') payload.password = password
      }
      await props.onSave(payload)
    } catch (err) { setError(errorMessage(err)); setSaving(false) }
  }

  const input = (value: string, set: (v: string) => void, extra: Record<string, unknown> = {}) => (
    <input className="dsh-rdb-input" data-mono value={value} onChange={(e) => { set(e.target.value) }} autoCapitalize="off" spellCheck={false} {...extra} />
  )

  return (
    <Modal
      title={props.mode === 'create' ? tt('form.title.create') : tt('form.title.edit', { name: p?.name ?? '' })}
      onClose={props.onCancel}
      footer={<>
        <button type="button" className="dsh-rdb-ghost" onClick={props.onCancel} disabled={saving}>{tt('form.cancel')}</button>
        <button type="button" className="dsh-rdb-primary" onClick={() => { void submit() }} disabled={saving}>{saving ? tt('form.saving') : tt('form.save')}</button>
      </>}
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="dsh-rdb-form">
        <div className="dsh-rdb-segmented" role="radiogroup" aria-label={tt('form.kind')}>
          {(['postgres', 'mysql', 'gaussdb', 'sqlite'] as DbKind[]).map(k => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} {...(kind === k ? { 'data-active': '' } : {})} onClick={() => { changeKind(k) }}>{tt(`form.kind.${k}` as 'form.kind.sqlite')}</button>
          ))}
        </div>
        {kind === 'sqlite' ? (
          <label className="dsh-rdb-field">
            <span className="dsh-rdb-fieldLabel">{tt('form.file')}</span>
            {input(file, setFile, { placeholder: '/path/to/data.sqlite', autoFocus: true })}
          </label>
        ) : (
          <>
            <div className="dsh-rdb-formRow" style={{ gridTemplateColumns: '1fr 120px' }}>
              <label className="dsh-rdb-field">
                <span className="dsh-rdb-fieldLabel">{tt('form.host')}</span>
                {input(host, setHost, { placeholder: 'db1.example.com, db2.example.com', autoFocus: true })}
              </label>
              <label className="dsh-rdb-field">
                <span className="dsh-rdb-fieldLabel">{tt('form.port')}</span>
                {input(port, setPort, { placeholder: String(DEFAULT_PORT[kind]), inputMode: 'numeric' })}
              </label>
            </div>
            <label className="dsh-rdb-field">
              <span className="dsh-rdb-fieldLabel">{tt('form.database')}</span>
              {input(database, setDatabase, { placeholder: kind === 'mysql' ? 'mydb' : 'postgres' })}
            </label>
            <div className="dsh-rdb-formRow">
              <label className="dsh-rdb-field">
                <span className="dsh-rdb-fieldLabel">{tt('form.user')}</span>
                {input(user, setUser, { autoComplete: 'off' })}
              </label>
              <label className="dsh-rdb-field">
                <span className="dsh-rdb-fieldLabel">{tt('form.password')}</span>
                <input className="dsh-rdb-input" data-mono type="password" value={password} onChange={(e) => { setPassword(e.target.value) }} autoComplete="new-password" placeholder={props.mode === 'edit' ? '••••••••' : ''} />
                {props.mode === 'edit' && <span className="dsh-rdb-fieldHint">{tt('form.passwordKeep')}</span>}
              </label>
            </div>
            <label className="dsh-rdb-checkRow">
              <input type="checkbox" className="dsh-rdb-check" checked={ssl} onChange={(e) => { setSsl(e.target.checked) }} />
              <span>{tt('form.ssl')}</span>
            </label>
          </>
        )}
        <div className="dsh-rdb-formDivider">{tt('form.optional')}</div>
        {kind !== 'sqlite' && (
          <div className="dsh-rdb-formRow" style={{ alignItems: 'end' }}>
            <label className="dsh-rdb-field">
              <span className="dsh-rdb-fieldLabel">{tt('form.target')}</span>
              <select className="dsh-rdb-select" value={target} onChange={(e) => { setTarget(e.target.value as TargetSessionAttrs) }}>
                {TARGET_SESSION_ATTRS.map(v => <option key={v} value={v}>{tt(`form.target.${v}` as 'form.target.any')}</option>)}
              </select>
            </label>
            <label className="dsh-rdb-checkRow" style={{ paddingBottom: 8 }}>
              <input type="checkbox" className="dsh-rdb-check" checked={loadBalance} onChange={(e) => { setLoadBalance(e.target.checked) }} />
              <span>{tt('form.loadBalance')}</span>
            </label>
          </div>
        )}
        <label className="dsh-rdb-field">
          <span className="dsh-rdb-fieldLabel">{tt('form.name')}</span>
          <input className="dsh-rdb-input" value={name} onChange={(e) => { setName(e.target.value) }} placeholder={tt('form.namePlaceholder')} />
        </label>
        <label className="dsh-rdb-checkRow">
          <input type="checkbox" className="dsh-rdb-check" checked={allowWrite} onChange={(e) => { setAllowWrite(e.target.checked) }} />
          <span>{tt('form.allowWrite')}</span>
        </label>
        {error !== undefined && <div className="dsh-rdb-formError">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
