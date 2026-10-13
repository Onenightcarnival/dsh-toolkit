/** Settings → Left sidebar: one visibility switch per sidebar row of any plugin, plus hide-all and show-all. */
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, useSyncExternalStore } from 'react'
import { styles } from '../../../config-center/src/client/styles.ts'
import type { Key } from './locales.ts'
import type { RowList } from './rows.ts'
import type { SidebarStore } from './sidebar.ts'

export interface SidebarPageProps {
  store: SidebarStore
  rows: RowList
  /** Error from the initial preferences read. */
  loadError: string | undefined
  translate: (key: Key, values?: Record<string, string>) => string
}

export function SidebarPage({ store, rows, loadError, translate: t }: SidebarPageProps): JSX.Element {
  const hidden = useSyncExternalStore(store.subscribe, store.hidden)
  const list = useSyncExternalStore(rows.subscribe, rows.getSnapshot)
  const [error, setError] = useState(loadError === undefined ? '' : t('error.load', { error: loadError }))

  const save = (next: readonly string[]): void => {
    setError('')
    store.save(next).catch((reason: unknown) => {
      setError(t('error.save', { error: reason instanceof Error ? reason.message : String(reason) }))
    })
  }
  const toggle = (id: string, visible: boolean): void => {
    save(visible ? hidden.filter(entry => entry !== id) : [...hidden, id])
  }
  /** Bulk actions cover the listed rows; ids of absent plugins keep their state. */
  const listed = new Set(list.map(row => row.id))
  const allHidden = list.every(row => hidden.includes(row.id))
  const allShown = list.every(row => !hidden.includes(row.id))

  return (
    <section style={styles.page}>
      <div style={{ ...styles.header, alignItems: 'center' }}>
        <h3 style={styles.heading}>{t('sidebar.title')}</h3>
        {list.length === 0 ? null : (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="outline" disabled={allHidden} onClick={() => save([...new Set([...hidden, ...listed])])}>{t('sidebar.hideAll')}</Button>
            <Button size="sm" variant="outline" disabled={allShown} onClick={() => save(hidden.filter(id => !listed.has(id)))}>{t('sidebar.showAll')}</Button>
          </div>
        )}
      </div>
      {list.length === 0 ? <p style={styles.meta}>{t('sidebar.empty')}</p> : (
        <div style={{ ...styles.card, gap: 0, padding: '4px 16px' }}>
          {list.map((row, index) => (
            <div key={row.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 48, fontSize: 13, borderTop: index === 0 ? undefined : '1px solid rgba(127,127,127,.2)' }}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{row.label}</span>
              <Switch checked={!hidden.includes(row.id)} label={row.label} onChange={visible => toggle(row.id, visible)} />
            </div>
          ))}
        </div>
      )}
      {error === '' ? null : <div role="alert" style={{ ...styles.error, marginTop: 12 }}>{error}</div>}
    </section>
  )
}
