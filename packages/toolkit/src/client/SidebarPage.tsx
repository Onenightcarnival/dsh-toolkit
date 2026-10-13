/** Settings → Toolkit: one switch per sidebar row of the mounted modules. */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, useSyncExternalStore } from 'react'
import { styles } from '../../../config-center/src/client/styles.ts'
import type { SidebarPanel } from '../modules.ts'
import type { Key } from './locales.ts'
import type { SidebarStore } from './sidebar.ts'

export interface SidebarPageProps {
  store: SidebarStore
  /** Rows of the mounted modules, in sidebar order. */
  panels: readonly SidebarPanel[]
  /** Error from the initial preferences read. */
  loadError: string | undefined
  translate: (key: Key, values?: Record<string, string>) => string
}

export function SidebarPage({ store, panels, loadError, translate: t }: SidebarPageProps): JSX.Element {
  const hidden = useSyncExternalStore(store.subscribe, store.hidden)
  const [error, setError] = useState(loadError === undefined ? '' : t('error.load', { error: loadError }))

  const toggle = (id: SidebarPanel, visible: boolean): void => {
    setError('')
    const next = visible ? hidden.filter(entry => entry !== id) : [...hidden, id]
    store.save(next).catch((reason: unknown) => {
      setError(t('error.save', { error: reason instanceof Error ? reason.message : String(reason) }))
    })
  }

  return (
    <section style={styles.page}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.heading}>{t('sidebar.title')}</h3>
          <p style={styles.description}>{t('sidebar.intro')}</p>
        </div>
      </div>
      {panels.length === 0 ? <p style={styles.meta}>{t('sidebar.empty')}</p> : (
        <div style={{ ...styles.card, gap: 0, padding: '4px 16px' }}>
          {panels.map((id, index) => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 48, fontSize: 13, borderTop: index === 0 ? undefined : '1px solid rgba(127,127,127,.2)' }}>
              <span>{t(`panel.${id}`)}</span>
              <Switch checked={!hidden.includes(id)} label={t(`panel.${id}`)} onChange={visible => toggle(id, visible)} />
            </div>
          ))}
        </div>
      )}
      {error === '' ? null : <div role="alert" style={{ ...styles.error, marginTop: 12 }}>{error}</div>}
    </section>
  )
}
