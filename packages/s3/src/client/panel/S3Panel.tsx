import { useCallback, useEffect, useState } from 'react'
import type { S3Api } from '../api.ts'
import type { S3ProfilePayload, S3ProfileSummary } from '../../protocol.ts'
import { tt } from '../locales.ts'
import type { PanelController } from '../mount.tsx'
import { Browser } from './Browser.tsx'
import { BannerView, Modal, errorMessage, type Banner } from './common.tsx'
import { ProfileForm } from './ProfileForm.tsx'

export interface S3PanelProps {
  controller: PanelController
  api: S3Api
}

export function S3Panel(props: S3PanelProps): JSX.Element {
  const { api, controller } = props
  const [profiles, setProfiles] = useState<S3ProfileSummary[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [agentTools, setAgentTools] = useState(false)
  const [banner, setBanner] = useState<Banner | undefined>()
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; profile: S3ProfileSummary } | undefined>()
  const [confirmDelete, setConfirmDelete] = useState<S3ProfileSummary | undefined>()
  const [testing, setTesting] = useState<string | undefined>()
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [list, settings] = await Promise.all([api.profiles(), api.settings()])
      setProfiles(list)
      setAgentTools(settings.agentTools)
      setActiveId(prev => (prev !== undefined && list.some(p => p.id === prev)) ? prev : list[0]?.id)
      setLoaded(true)
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }, [api])

  // Load when the panel opens (cheap; picks up CLI-side edits of the store).
  useEffect(() => {
    const sync = (): void => { if (controller.getSnapshot().panelOpen) void refresh() }
    const unsubscribe = controller.subscribe(sync)
    sync()
    return unsubscribe
  }, [controller, refresh])

  const toggleAgentTools = async (next: boolean): Promise<void> => {
    setAgentTools(next)
    try {
      const settings = await api.saveSettings({ agentTools: next })
      setAgentTools(settings.agentTools)
      setBanner({ kind: 'ok', text: settings.agentTools ? tt('browser.toolsOn') : tt('browser.toolsOff') })
    } catch (error) {
      setAgentTools(!next)
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const save = async (payload: S3ProfilePayload): Promise<void> => {
    if (form === undefined) return
    const saved = form.mode === 'create' ? await api.createProfile(payload) : await api.updateProfile(form.profile.id, payload)
    setForm(undefined)
    await refresh()
    setActiveId(saved.id)
  }

  const runTest = async (profile: S3ProfileSummary): Promise<void> => {
    setTesting(profile.id)
    setBanner({ kind: 'info', text: tt('profiles.testing') })
    try {
      const result = await api.test(profile.id)
      setBanner(result.ok
        ? { kind: 'ok', text: tt('profiles.testOk', { latency: result.latencyMs }) }
        : { kind: 'error', text: tt('profiles.testFail', { error: result.error ?? '?' }) })
    } catch (error) {
      setBanner({ kind: 'error', text: tt('profiles.testFail', { error: errorMessage(error) }) })
    } finally {
      setTesting(undefined)
    }
  }

  const runDeleteProfile = async (profile: S3ProfileSummary): Promise<void> => {
    setConfirmDelete(undefined)
    try {
      await api.deleteProfile(profile.id)
      await refresh()
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const active = profiles.find(p => p.id === activeId)

  return (
    <section className="dsh-s3-panel" data-dsh-plugin="s3" data-dsh-part="panel">
      <header className="dsh-s3-header">
        <h2 className="dsh-s3-title">{tt('panel.title')}</h2>
        <label className="dsh-s3-toggle" {...(agentTools ? { 'data-on': '' } : {})}>
          <input type="checkbox" checked={agentTools} disabled={!loaded} onChange={(e) => { void toggleAgentTools(e.target.checked) }} />
          <span className="dsh-s3-switch" aria-hidden="true" />
          <span>{tt('panel.agentTools')}</span>
        </label>
        <button type="button" className="dsh-s3-ghost" onClick={() => { controller.close() }}>{tt('panel.back')}</button>
      </header>

      <BannerView banner={banner} onClose={() => { setBanner(undefined) }} />

      <div className="dsh-s3-body">
        <aside className="dsh-s3-profiles">
          <div className="dsh-s3-profilesHead">
            <span>{tt('profiles.title')}</span>
            <button type="button" className="dsh-s3-link" onClick={() => { setForm({ mode: 'create' }) }}>+ {tt('profiles.add')}</button>
          </div>
          <div className="dsh-s3-profileList">
            {profiles.length === 0 && loaded && <div className="dsh-s3-hint">{tt('profiles.empty')}</div>}
            {profiles.map(profile => (
              <button key={profile.id} type="button" className="dsh-s3-profile" {...(profile.id === activeId ? { 'data-active': '' } : {})} onClick={() => { setActiveId(profile.id) }}>
                <span className="dsh-s3-profileName">{profile.name}</span>
                <span className="dsh-s3-profileMeta" title={`${profile.bucket} · ${profile.endpoint || 'AWS'} · ${profile.region}`}>{profile.bucket}{profile.prefix !== '' ? `/${profile.prefix}` : ''}</span>
                <span className="dsh-s3-profileMeta">{profile.endpoint !== '' ? profile.endpoint.replace(/^https?:\/\//, '') : `AWS · ${profile.region}`}</span>
              </button>
            ))}
          </div>
          {active !== undefined && (
            <div className="dsh-s3-profileActions">
              <button type="button" className="dsh-s3-link" disabled={testing === active.id} onClick={() => { void runTest(active) }}>{tt('profiles.test')}</button>
              <button type="button" className="dsh-s3-link" onClick={() => { setForm({ mode: 'edit', profile: active }) }}>{tt('profiles.edit')}</button>
              <button type="button" className="dsh-s3-link" data-danger onClick={() => { setConfirmDelete(active) }}>{tt('profiles.delete')}</button>
            </div>
          )}
        </aside>

        {active !== undefined ? (
          <Browser key={active.id} api={api} profile={active} />
        ) : (
          <div className="dsh-s3-browser"><div className="dsh-s3-empty">{tt('browser.selectProfile')}</div></div>
        )}
      </div>

      {form !== undefined && (
        <ProfileForm mode={form.mode} profile={form.mode === 'edit' ? form.profile : undefined} onCancel={() => { setForm(undefined) }} onSave={save} />
      )}
      {confirmDelete !== undefined && (
        <Modal title={tt('profiles.delete')} onClose={() => { setConfirmDelete(undefined) }} footer={<>
          <button type="button" className="dsh-s3-ghost" onClick={() => { setConfirmDelete(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-s3-primary" data-danger onClick={() => { void runDeleteProfile(confirmDelete) }}>{tt('profiles.delete')}</button>
        </>}>
          <p style={{ margin: 0 }}>{tt('profiles.deleteConfirm', { name: confirmDelete.name })}</p>
        </Modal>
      )}
    </section>
  )
}
