import { useEffect, useRef, useState } from 'react'
import type { ConfigCenterApi } from './api.ts'
import type { LocalLogs } from '../protocol.ts'
import { styles } from './styles.ts'
import { tt } from './locales.ts'

/** 固定来源日志的尾部快照；离开页签后停止轮询。 */
export function LogsPage({ api }: { api: ConfigCenterApi }): JSX.Element {
  const [data, setData] = useState<LocalLogs>()
  const [automatic, setAutomatic] = useState(true)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const output = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      try {
        const next = await api.logs()
        if (active) { setData(next); setError('') }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)) }
      if (active && automatic) timer = setTimeout(() => { void refresh() }, 2000)
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [api, automatic, revision])
  useEffect(() => { if (follow.current && output.current) output.current.scrollTop = output.current.scrollHeight }, [data?.text])
  const download = (): void => {
    if (!data) return
    const url = URL.createObjectURL(new Blob(['\uFEFF', data.text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = 'dsh-server.log'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section style={{ color: 'inherit', minWidth: 0 }}>
    <div style={{ ...styles.header, flexWrap: 'wrap' }}>
      <h3 style={styles.heading}>{tt('logs.title')}</h3>
      <div style={{ ...styles.actions, flexWrap: 'wrap' }}>
        <label style={styles.switch}><input type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)} />{tt('logs.auto')}</label>
        <button style={styles.secondary} onClick={() => setRevision(value => value + 1)}>{tt('logs.refresh')}</button>
        <button style={styles.secondary} disabled={!data?.text} onClick={download}>{tt('logs.download')}</button>
      </div>
    </div>
    {!!data?.sources.length && <p style={styles.meta}>dsh-server.log</p>}
    {error && <p role="alert" style={styles.error}>{error}</p>}
    <pre ref={output} tabIndex={0} aria-label={tt('logs.title')} onScroll={() => { const node = output.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40 }}
      style={{ background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-main, #8884)', borderRadius: 10, padding: 16, height: 'min(55vh, 520px)', minHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '12px/1.6 ui-monospace, Consolas, monospace' }}>
      {data ? data.text || tt(data.sources.length ? 'logs.empty' : 'logs.unavailable') : tt('common.loading')}
    </pre>
    <p style={styles.meta}>{data?.truncated ? tt('logs.tail') + ' ' : ''}{tt('logs.privacy')}</p>
  </section>
}
