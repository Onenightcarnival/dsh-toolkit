/**
 * Main sidebar → MCP: server list with live state, and one
 * form for the selected server (save, enable, test, delete).
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpServerView, McpStatus } from '../protocol.ts'
import { DEFAULT_STDIO_TIMEOUT_SECONDS, MAX_STDIO_TIMEOUT_SECONDS } from '../protocol.ts'
import { ApiError, type ConfigCenterApi } from './api.ts'
import { emptyForm, fromForm, issueText, statusText, testText, toForm, type McpForm, type Pair } from './form.ts'
import { tt } from './locales.ts'
import { noticeStyle, mcpStyles as styles, type Notice } from './styles.ts'
import { Select } from './Select.tsx'

const NEW = Symbol('new')
type Selection = string | typeof NEW | undefined

function failure(error: unknown): Notice {
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'error', text: error instanceof ApiError ? issueText(error.issue, message) : message }
}

function dotStyle(status: McpStatus) {
  if (status.state === 'connected') return { ...styles.dot, ...styles.dotOk }
  if (status.state === 'failed') return { ...styles.dot, ...styles.dotError }
  return styles.dot
}

function Feedback({ notice }: { notice: Notice }): JSX.Element {
  return <div style={noticeStyle(notice)} role="status">
    {notice.text}
    {notice.details && <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer' }}>{tt('mcp.details')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto', font: 'inherit' }}>{notice.details}</pre></details>}
  </div>
}

function Pairs({ label, add, keyPlaceholder, pairs, onChange }: { label: string; add: string; keyPlaceholder: string; pairs: Pair[]; onChange: (pairs: Pair[]) => void }): JSX.Element {
  const set = (index: number, pair: Pair): void => onChange(pairs.map((item, i) => (i === index ? pair : item)))
  return (
    <div style={styles.field}>
      <span>{label}</span>
      <div>
        {pairs.map(([key, value], index) => (
          <div key={index} style={styles.pair} className="dsh-mcp-pair">
            <Input value={key} placeholder={keyPlaceholder} aria-label={keyPlaceholder} spellCheck={false} onChange={event => set(index, [event.target.value, value])} />
            <Input value={value} placeholder={tt('mcp.value')} aria-label={tt('mcp.value')} spellCheck={false} autoComplete="off" onChange={event => set(index, [key, event.target.value])} />
            <Button size="sm" title={tt('mcp.remove')} aria-label={tt('mcp.remove')} onClick={() => onChange(pairs.filter((_, i) => i !== index))}>×</Button>
          </div>
        ))}
      </div>
      <Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...pairs, ['', '']])}>＋ {add}</Button>
    </div>
  )
}

export function McpTab({ api, close }: { api: ConfigCenterApi; close: () => void }): JSX.Element {
  const [servers, setServers] = useState<McpServerView[]>()
  const [selection, setSelection] = useState<Selection>()
  const [form, setForm] = useState<McpForm>(emptyForm())
  const [busy, setBusy] = useState<'save' | 'test' | 'delete'>()
  const [notice, setNotice] = useState<Notice>()
  const [timeout, setTimeoutValue] = useState(String(DEFAULT_STDIO_TIMEOUT_SECONDS))
  const [savedTimeout, setSavedTimeout] = useState(DEFAULT_STDIO_TIMEOUT_SECONDS)
  const [savingTimeout, setSavingTimeout] = useState(false)
  const [timeoutNotice, setTimeoutNotice] = useState<Notice>()

  const select = useCallback((next: Selection, list: readonly McpServerView[]) => {
    setSelection(next)
    const server = typeof next === 'string' ? list.find(item => item.id === next) : undefined
    setForm(server === undefined ? emptyForm() : toForm(server))
  }, [])

  const load = useCallback(async () => {
    try {
      const { servers: list, stdioTimeoutSeconds } = await api.mcp()
      setSavedTimeout(stdioTimeoutSeconds)
      setTimeoutValue(String(stdioTimeoutSeconds))
      setServers(list)
      setSelection((current) => {
        if (current === NEW || (typeof current === 'string' && list.some(item => item.id === current))) return current
        const first = list[0]
        setForm(first === undefined ? emptyForm() : toForm(first))
        return first?.id
      })
    } catch (error) {
      setServers([])
      setNotice(failure(error))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const patch = (changes: Partial<McpForm>): void => setForm(previous => ({ ...previous, ...changes }))
  const current = typeof selection === 'string' ? servers?.find(item => item.id === selection) : undefined

  const saveTimeout = async (): Promise<void> => {
    const seconds = Number(timeout)
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_STDIO_TIMEOUT_SECONDS) {
      setTimeoutNotice({ kind: 'error', text: tt('mcp.issue.stdioTimeout') })
      return
    }
    setSavingTimeout(true)
    try {
      const result = await api.saveMcpTimeout(seconds)
      setSavedTimeout(result.stdioTimeoutSeconds)
      setTimeoutValue(String(result.stdioTimeoutSeconds))
      setTimeoutNotice({ kind: 'ok', text: tt('common.saved') })
    } catch (error) { setTimeoutNotice(failure(error)) }
    finally { setSavingTimeout(false) }
  }

  const save = async (): Promise<void> => {
    const server = fromForm(form)
    setBusy('save')
    setNotice(server.enabled ? { kind: 'info', text: tt('mcp.saving.connect') } : undefined)
    try {
      const saved = await api.saveMcp(server, form.id)
      setServers(saved.servers)
      select(saved.id, saved.servers)
      setNotice({ kind: 'ok', text: tt(saved.application === 'applied' ? 'common.saved' : 'common.savedRestart') })
    } catch (error) {
      setNotice(failure(error))
      if (error instanceof ApiError && error.issue === 'missing') await load()
    } finally {
      setBusy(undefined)
    }
  }

  const test = async (): Promise<void> => {
    const server = fromForm(form)
    setBusy('test')
    setNotice({ kind: 'info', text: tt(server.transport === 'stdio' ? 'mcp.testing.stdio' : 'mcp.testing', { seconds: savedTimeout }) })
    try {
      const result = await api.testMcp(server)
      setNotice({ kind: result.ok ? 'ok' : 'error', text: testText({ ...result, detail: '' }), details: result.detail || undefined })
    } catch (error) {
      setNotice(failure(error))
    } finally {
      setBusy(undefined)
    }
  }

  const remove = async (): Promise<void> => {
    if (form.id === undefined) {
      select(servers?.[0]?.id, servers ?? [])
      return
    }
    if (!window.confirm(tt('mcp.delete.confirm', { name: current?.serverName ?? form.serverName }))) return
    setBusy('delete')
    try {
      const { servers: list } = await api.deleteMcp(form.id)
      setServers(list)
      select(list[0]?.id, list)
      setNotice({ kind: 'ok', text: tt('mcp.deleted') })
    } catch (error) {
      setNotice(failure(error))
      await load()
    } finally {
      setBusy(undefined)
    }
  }

  const stdio = form.transport === 'stdio'
  return (
    <section aria-label="MCP" style={styles.page} className="dsh-mcp-page">
      <style>{`
        .dsh-mcp-pair>span{flex:1;min-width:0}
        .dsh-mcp-pair>span:first-child{flex:0 0 34%}
        .dsh-mcp-page input,.dsh-mcp-page button,.dsh-mcp-page label,.dsh-mcp-page summary{font-family:var(--dsw-font-family,sans-serif)}
        .dsh-mcp-page [role=option]:hover{background:var(--dsw-alias-interactive-bg-hover)!important}
        @container(max-width:640px){
          .dsh-mcp-split{flex-direction:column}
          .dsh-mcp-sidebar{width:auto!important;max-height:150px;border-right:0!important;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 0 8px!important}
        }
      `}</style>
      <header style={styles.header}>
        <h2 style={styles.heading}>{tt('mcp.title')}</h2>
        <Button size="sm" variant="ghost" onClick={() => { void load() }}>{tt('common.refresh')}</Button>
        <Button size="sm" variant="outline" onClick={close}>{tt('common.back')}</Button>
      </header>
      <details style={styles.settings}>
        <summary style={{ cursor: 'pointer', padding: '4px 0' }}>{tt('mcp.connectionSettings')}</summary>
        <div style={styles.settingsBody}>
          <label style={{ ...styles.field, width: 220 }}>
            <span>{tt('mcp.stdioTimeout')}</span>
            <Input type="number" min={1} max={MAX_STDIO_TIMEOUT_SECONDS} step={1} value={timeout} disabled={savingTimeout || busy !== undefined} onChange={event => { setTimeoutValue(event.target.value); setTimeoutNotice(undefined) }} />
          </label>
          <Button size="sm" variant="outline" disabled={savingTimeout || busy !== undefined || servers === undefined} onClick={() => { void saveTimeout() }}>{tt('mcp.saveTimeout')}</Button>
        </div>
        <p style={styles.meta}>{tt('mcp.stdioTimeout.hint')}</p>
        {timeoutNotice && <Feedback notice={timeoutNotice} />}
      </details>
      {servers === undefined ? <p style={styles.meta}>{tt('common.loading')}</p> : (
        <div style={styles.split} className="dsh-mcp-split">
          <aside style={styles.sidebar} className="dsh-mcp-sidebar">
            <div style={styles.listHead}>
              <span>{tt('mcp.servers')}</span>
              <Button size="sm" onClick={() => { setNotice(undefined); select(NEW, servers ?? []) }}>＋ {tt('mcp.add')}</Button>
            </div>
            <div style={styles.list} role="listbox" aria-label={tt('mcp.title')}>
              {servers.length === 0 && selection !== NEW ? <div style={styles.empty}>{tt('mcp.empty')}</div> : null}
              {servers.map(server => (
                <button
                  key={server.id}
                  type="button"
                  role="option"
                  aria-selected={server.id === selection}
                  title={statusText(server.status)}
                  style={{ ...styles.row, ...(server.id === selection ? styles.rowSelected : {}) }}
                  onClick={() => { setNotice(undefined); select(server.id, servers) }}
                >
                  <span style={dotStyle(server.status)} />
                  <span style={styles.rowName}>{server.serverName}</span>
                  {server.enabled ? null : <span style={styles.rowTag}>{tt('mcp.off')}</span>}
                </button>
              ))}
              {selection === NEW ? (
                <div style={{ ...styles.row, ...styles.rowSelected, cursor: 'default' }}>
                  <span style={styles.dot} />
                  <span style={styles.rowName}>{form.serverName.trim() === '' ? tt('mcp.new') : form.serverName}</span>
                </div>
              ) : null}
            </div>
          </aside>
          {selection === undefined ? <div style={{ ...styles.card, ...styles.empty }}>{tt('mcp.none')}</div> : (
            <div style={styles.card} className="dsh-mcp-editor">
              <div style={styles.editorScroll} className="dsh-mcp-editor-scroll">
                <div style={styles.form}>
                  <div style={styles.cardHead}>
                    <h4 style={styles.cardTitle}>{current?.serverName ?? (form.serverName || tt('mcp.new'))}</h4>
                    <div style={styles.switch}>
                      <span>{tt('mcp.enabled')}</span>
                      <Switch checked={form.enabled} label={tt('mcp.enabled')} onChange={enabled => patch({ enabled })} />
                    </div>
                  </div>
                  {current === undefined ? null : <p style={styles.meta}>{statusText(current.status)}</p>}
                  <label style={styles.field}>
                    <span>{tt('mcp.name')}</span>
                    <Input value={form.serverName} placeholder="my-server" spellCheck={false} onChange={event => patch({ serverName: event.target.value })} />
                  </label>
                  <label style={styles.field}>
                    <span>{tt('mcp.transport')}</span>
                    <Select style={styles.select} label={tt('mcp.transport')} value={form.transport}
                      onChange={value => patch({ transport: value === 'stdio' ? 'stdio' : 'streamable-http' })}
                      options={[
                        { value: 'streamable-http', label: tt('mcp.transport.http') },
                        { value: 'stdio', label: tt('mcp.transport.stdio') },
                      ]} />
                  </label>
                  {stdio ? (
                    <>
                      <label style={styles.field}>
                        <span>{tt('mcp.command')}</span>
                        <Input value={form.command} placeholder="npx / uvx" spellCheck={false} onChange={event => patch({ command: event.target.value })} />
                      </label>
                      <label style={styles.field}>
                        <span>{tt('mcp.args')} <span style={styles.hint}>{tt('mcp.args.hint')}</span></span>
                        <textarea style={styles.textarea} rows={4} value={form.args} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'} spellCheck={false} onChange={event => patch({ args: event.target.value })} />
                      </label>
                      <Pairs label={tt('mcp.env')} add={tt('mcp.env.add')} keyPlaceholder="API_KEY" pairs={form.env} onChange={env => patch({ env })} />
                      <label style={styles.field}>
                        <span>{tt('mcp.cwd')} <span style={styles.hint}>{tt('mcp.optional')}</span></span>
                        <Input value={form.cwd} placeholder="/path/to/project" spellCheck={false} onChange={event => patch({ cwd: event.target.value })} />
                      </label>
                    </>
                  ) : (
                    <>
                      <label style={styles.field}>
                        <span>{tt('mcp.url')}</span>
                        <Input value={form.url} placeholder="http://127.0.0.1:8080/mcp" spellCheck={false} onChange={event => patch({ url: event.target.value })} />
                      </label>
                      <Pairs label={tt('mcp.headers')} add={tt('mcp.headers.add')} keyPlaceholder="Authorization" pairs={form.headers} onChange={headers => patch({ headers })} />
                    </>
                  )}
                </div>
              </div>
              {notice === undefined ? null : <div style={styles.feedback}><Feedback notice={notice} /></div>}
              <div style={styles.actions}>
                <Button style={styles.danger} disabled={busy !== undefined} onClick={() => { void remove() }}>{tt('mcp.delete')}</Button>
                <span style={styles.spacer} />
                <Button variant="outline" disabled={busy !== undefined || savingTimeout} onClick={() => { void test() }}>{busy === 'test' ? tt('mcp.testing') : tt('mcp.test')}</Button>
                <Button variant="primary" disabled={busy !== undefined || savingTimeout} onClick={() => { void save() }}>{busy === 'save' ? tt('common.saving') : tt('common.save')}</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {notice !== undefined && (servers === undefined || selection === undefined) ? <div style={{ ...noticeStyle(notice), marginTop: 12 }} role="status">{notice.text}</div> : null}
    </section>
  )
}