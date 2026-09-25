import { useState } from 'react'
import type { S3ProfilePayload, S3ProfileSummary } from '../../protocol.ts'
import { tt } from '../locales.ts'
import { Modal, errorMessage } from './common.tsx'

export interface ProfileFormProps {
  mode: 'create' | 'edit'
  profile?: S3ProfileSummary
  onCancel: () => void
  onSave: (payload: S3ProfilePayload) => Promise<void>
}

export function ProfileForm(props: ProfileFormProps): JSX.Element {
  const p = props.profile
  const [bucket, setBucket] = useState(p?.bucket ?? '')
  const [endpoint, setEndpoint] = useState(p?.endpoint ?? '')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [name, setName] = useState(p?.name ?? '')
  const [region, setRegion] = useState(p?.region ?? 'us-east-1')
  const [pathStyle, setPathStyle] = useState(p?.pathStyle ?? true)
  const [prefix, setPrefix] = useState(p?.prefix ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const payload: S3ProfilePayload = { name, bucket, endpoint, region, pathStyle, prefix }
      if (accessKeyId.trim() !== '' || props.mode === 'create') payload.accessKeyId = accessKeyId
      if (secretAccessKey !== '' || props.mode === 'create') payload.secretAccessKey = secretAccessKey
      await props.onSave(payload)
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <Modal
      title={props.mode === 'create' ? tt('form.title.create') : tt('form.title.edit', { name: p?.name ?? '' })}
      onClose={props.onCancel}
      footer={<>
        <button type="button" className="dsh-s3-ghost" onClick={props.onCancel} disabled={saving}>{tt('form.cancel')}</button>
        <button type="button" className="dsh-s3-primary" onClick={() => { void submit() }} disabled={saving}>{saving ? tt('form.saving') : tt('form.save')}</button>
      </>}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit() }} className="dsh-s3-form">
        <label className="dsh-s3-field">
          <span className="dsh-s3-fieldLabel">{tt('form.bucket')}</span>
          <input className="dsh-s3-input" data-mono value={bucket} onChange={(e) => { setBucket(e.target.value) }} autoFocus placeholder="my-bucket" autoCapitalize="off" spellCheck={false} />
        </label>
        <label className="dsh-s3-field">
          <span className="dsh-s3-fieldLabel">{tt('form.endpoint')}</span>
          <input className="dsh-s3-input" data-mono value={endpoint} onChange={(e) => { setEndpoint(e.target.value) }} placeholder="https://s3.example.com" autoCapitalize="off" spellCheck={false} />
        </label>
        <div className="dsh-s3-formRow">
          <label className="dsh-s3-field">
            <span className="dsh-s3-fieldLabel">{tt('form.accessKeyId')}</span>
            <input className="dsh-s3-input" data-mono value={accessKeyId} onChange={(e) => { setAccessKeyId(e.target.value) }} placeholder={p !== undefined ? p.accessKeyHint : ''} autoComplete="off" autoCapitalize="off" spellCheck={false} />
          </label>
          <label className="dsh-s3-field">
            <span className="dsh-s3-fieldLabel">{tt('form.secretAccessKey')}</span>
            <input className="dsh-s3-input" data-mono type="password" value={secretAccessKey} onChange={(e) => { setSecretAccessKey(e.target.value) }} autoComplete="new-password" placeholder={props.mode === 'edit' ? '••••••••' : ''} />
          </label>
        </div>

        <div className="dsh-s3-formDivider">{tt('form.optional')}</div>

        <div className="dsh-s3-formRow">
          <label className="dsh-s3-field">
            <span className="dsh-s3-fieldLabel">{tt('form.name')}</span>
            <input className="dsh-s3-input" value={name} onChange={(e) => { setName(e.target.value) }} placeholder={bucket.trim() || tt('form.namePlaceholder')} />
          </label>
          <label className="dsh-s3-field">
            <span className="dsh-s3-fieldLabel">{tt('form.region')}</span>
            <input className="dsh-s3-input" data-mono value={region} onChange={(e) => { setRegion(e.target.value) }} placeholder="us-east-1" autoCapitalize="off" spellCheck={false} />
          </label>
        </div>
        <label className="dsh-s3-field">
          <span className="dsh-s3-fieldLabel">{tt('form.prefix')}</span>
          <input className="dsh-s3-input" data-mono value={prefix} onChange={(e) => { setPrefix(e.target.value) }} placeholder="team-a/" autoCapitalize="off" spellCheck={false} />
        </label>
        <label className="dsh-s3-checkRow">
          <input type="checkbox" className="dsh-s3-check" checked={pathStyle} onChange={(e) => { setPathStyle(e.target.checked) }} />
          <span>{tt('form.pathStyle')}</span>
        </label>
        {error !== undefined && <div className="dsh-s3-formError">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
