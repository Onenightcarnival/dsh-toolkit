import { useEffect, useState } from 'react'
import type { EnvironmentStatus } from '../protocol.ts'
import type { ConfigCenterApi } from './api.ts'
import { tt } from './locales.ts'
import { styles } from './styles.ts'

/** A settings section shared by the standalone plugin and integrated toolkit. */
export function EnvironmentPage({ api }: { api: ConfigCenterApi }): JSX.Element {
  const [status, setStatus] = useState<EnvironmentStatus>()
  const [error, setError] = useState('')
  const [requesting, setRequesting] = useState(false)
  const busy = requesting || (status !== undefined && ['downloading', 'verifying', 'installing'].includes(status.state))

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      let interval = 10_000
      try {
        const next = await api.environment()
        if (['downloading', 'verifying', 'installing'].includes(next.state)) interval = 1500
        if (active) { setStatus(next); setError('') }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)) }
      if (active) timer = setTimeout(() => { void poll() }, interval)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [api])

  const install = async (): Promise<void> => {
    setRequesting(true)
    setError('')
    try { setStatus(await api.installEnvironment()) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setRequesting(false) }
  }
  const refresh = async (): Promise<void> => {
    try { setStatus(await api.environment()); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  return <section style={{ maxWidth: 760, color: 'inherit' }}>
    <div style={styles.header}>
      <div><h3 style={styles.heading}>{tt('environment.title')}</h3><p style={styles.description}>{tt('environment.intro')}</p></div>
      <button type="button" style={styles.secondary} disabled={busy} onClick={() => { void refresh() }}>{tt('environment.refresh')}</button>
    </div>
    <div style={{ ...styles.card, background: 'var(--dsw-alias-bg-layer-1)' }}>
      <div style={styles.cardHead}>
        <h4 style={{ ...styles.cardTitle, fontSize: 17 }}>uv / uvx</h4>
        <span role="status" style={{ fontSize: 12, padding: '4px 8px', borderRadius: 8, background: 'var(--dsw-alias-interactive-bg-hover)' }}>
          {status ? tt(`environment.state.${status.state}`) : tt('common.loading')}
        </span>
      </div>
      <p style={styles.description}>{tt('environment.uvDescription')}</p>
      {status && <>
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '10px 16px', fontSize: 13, margin: '6px 0' }}>
          <dt>{tt('environment.version')}</dt><dd style={{ margin: 0 }}>{status.version ?? '—'}</dd>
          <dt>{tt('environment.available')}</dt><dd style={{ margin: 0 }}>{status.recommendedVersion}</dd>
          <dt>{tt('environment.platform')}</dt><dd style={{ margin: 0 }}>{status.target}</dd>
          <dt>{tt('environment.path')}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{status.path}</dd>
          <dt>{tt('environment.data')}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{status.dataDirectory}</dd>
        </dl>
        {busy && <progress aria-label={tt('environment.progress')} max={100} value={status.state === 'downloading' ? status.progress : undefined} style={{ width: '100%', accentColor: 'var(--dsw-alias-state-business-primary)' }} />}
        {!status.supported && <p style={styles.meta}>{tt('environment.unsupported')}</p>}
        <p style={styles.meta}>{tt('environment.python')}</p>
        <div style={styles.actions}>
          <a href="https://docs.astral.sh/uv/" target="_blank" rel="noreferrer" style={{ color: 'var(--dsw-alias-state-business-primary)' }}>{tt('environment.docs')}</a>
          <span style={styles.spacer} />
          <button type="button" style={styles.primary} disabled={busy || !status.supported} onClick={() => { void install() }}>
            {busy ? tt('environment.working') : status.ready ? tt('environment.repair') : tt('environment.install')}
          </button>
        </div>
      </>}
      {(error || status?.error) && <div role="alert" style={styles.error}>{error || status?.error}</div>}
    </div>
  </section>
}
