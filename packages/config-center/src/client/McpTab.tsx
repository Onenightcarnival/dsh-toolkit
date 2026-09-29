/**
 * Settings → Plugins → MCP servers: server list with live state, and one
 * form for the selected server (save, enable, test, delete).
 */
import { useCallback, useEffect, useState } from 'react'
import type { McpServerView, McpStatus } from '../protocol.ts'
import { ApiError, type ConfigCenterApi } from './api.ts'
import { emptyForm, fromForm, issueText, statusText, testText, toForm, type McpForm, type Pair } from './form.ts'
import { tt } from './locales.ts'
import { noticeStyle, styles, type Notice } from './styles.ts'

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

function Pairs({ label, add, keyPlaceholder, pairs, onChange }: { label: string; add: string; keyPlaceholder: string; pairs: Pair[]; onChange: (pairs: Pair[]) => void }): JSX.Element {
  const set = (index: number, pair: Pair): void => onChange(pairs.map((item, i) => (i === index ? pair : item)))
  return (
    <div style={styles.field}>
      <span>{label} <span style={styles.hint}>{tt('mcp.optional')}</span></span>
      <div>
        {pairs.map(([key, value], index) => (
          <div key={index} style={styles.pair}>
            <input style={{ ...styles.input, ...styles.pairKey }} value={key} placeholder={keyPlaceholder} spellCheck={false} onChange={event => set(index, [event.target.value, value])} />
            <input style={styles.input} value={value} placeholder={tt('mcp.value')} spellCheck={false} autoComplete="off" onChange={event => set(index, [key, event.target.value])} />
            <button type="button" style={styles.icon} title={tt('mcp.remove')} aria-label={tt('mcp.remove')} onClick={() => onChange(pairs.filter((_, i) => i !== index))}>×</button>
          </div>
        ))}
      </div>
      <button type="button" style={styles.ghost} onClick={() => onChange([...pairs, ['', '']])}>＋ {add}</button>
    </div>
  )
}

export function McpTab({ api }: { api: ConfigCenterApi }): JSX.Element {
  const [servers, setServers] = useState<McpServerView[]>()
  const [selection, setSelection] = useState<Selection>()
  const [form, setForm] = useState<McpForm>(emptyForm())
  const [busy, setBusy] = useState<'save' | 'test' | 'delete'>()
  const [notice, setNotice] = useState<Notice>()

  const select = useCallback((next: Selection, list: readonly McpServerView[]) => {
    setSelection(next)
    const server = typeof next === 'string' ? list.find(item => item.id === next) : undefined
    setForm(server === undefined ? emptyForm() : toForm(server))
  }, [])

  const load = useCallback(async () => {
    try {
      const { servers: list } = await api.mcp()
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
    setNotice({ kind: 'info', text: tt(server.transport === 'stdio' ? 'mcp.testing.stdio' : 'mcp.testing') })
    try {
      const result = await api.testMcp(server)
      setNotice({ kind: result.ok ? 'ok' : 'error', text: testText(result) })
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
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.heading}>{tt('mcp.title')}</h3>
          <p style={styles.description}>{tt('mcp.intro')}</p>
        </div>
        <div style={styles.actions}>
          <button type="button" style={styles.secondary} onClick={() => { void load() }}>{tt('common.refresh')}</button>
          <button type="button" style={styles.primary} onClick={() => { setNotice(undefined); select(NEW, servers ?? []) }}>{tt('mcp.add')}</button>
        </div>
      </div>

      {servers === undefined ? <p style={styles.meta}>{tt('common.loading')}</p> : (
        <div style={styles.split}>
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

          {selection === undefined ? <div style={{ ...styles.card, ...styles.empty }}>{tt('mcp.none')}</div> : (
            <div style={styles.card}>
              <div style={styles.cardHead}>
                <h4 style={styles.cardTitle}>{current?.serverName ?? tt('mcp.new')}</h4>
                <label style={styles.switch}>
                  <input type="checkbox" checked={form.enabled} onChange={event => patch({ enabled: event.target.checked })} />
                  <span>{tt('mcp.enabled')}</span>
                </label>
              </div>
              {current === undefined ? null : <p style={styles.meta}>{statusText(current.status)}</p>}

              <label style={styles.field}>
                <span>{tt('mcp.name')} <span style={styles.hint}>{tt('mcp.name.hint')}</span></span>
                <input style={styles.input} value={form.serverName} placeholder="my-server" spellCheck={false} onChange={event => patch({ serverName: event.target.value })} />
              </label>
              <label style={styles.field}>
                <span>{tt('mcp.transport')}</span>
                <select style={styles.select} value={form.transport} onChange={event => patch({ transport: event.target.value === 'stdio' ? 'stdio' : 'streamable-http' })}>
                  <option value="streamable-http">{tt('mcp.transport.http')}</option>
                  <option value="stdio">{tt('mcp.transport.stdio')}</option>
                </select>
              </label>

              {stdio ? (
                <>
                  <label style={styles.field}>
                    <span>{tt('mcp.command')} <span style={styles.hint}>{tt('mcp.command.hint')}</span></span>
                    <input style={styles.input} value={form.command} placeholder="npx" spellCheck={false} onChange={event => patch({ command: event.target.value })} />
                  </label>
                  <label style={styles.field}>
                    <span>{tt('mcp.args')} <span style={styles.hint}>{tt('mcp.args.hint')}</span></span>
                    <textarea style={styles.textarea} rows={4} value={form.args} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'} spellCheck={false} onChange={event => patch({ args: event.target.value })} />
                  </label>
                  <Pairs label={tt('mcp.env')} add={tt('mcp.env.add')} keyPlaceholder="API_KEY" pairs={form.env} onChange={env => patch({ env })} />
                  <label style={styles.field}>
                    <span>{tt('mcp.cwd')} <span style={styles.hint}>{tt('mcp.optional')}</span></span>
                    <input style={styles.input} value={form.cwd} placeholder="/path/to/project" spellCheck={false} onChange={event => patch({ cwd: event.target.value })} />
                  </label>
                  <p style={styles.meta}>{tt('mcp.stdio.note')}</p>
                </>
              ) : (
                <>
                  <label style={styles.field}>
                    <span>{tt('mcp.url')}</span>
                    <input style={styles.input} value={form.url} placeholder="http://127.0.0.1:8080/mcp" spellCheck={false} onChange={event => patch({ url: event.target.value })} />
                  </label>
                  <Pairs label={tt('mcp.headers')} add={tt('mcp.headers.add')} keyPlaceholder="Authorization" pairs={form.headers} onChange={headers => patch({ headers })} />
                </>
              )}
              <p style={styles.meta}>{tt('mcp.expression.note')}</p>

              <div style={styles.actions}>
                <button type="button" style={styles.danger} disabled={busy !== undefined} onClick={() => { void remove() }}>{tt('mcp.delete')}</button>
                <span style={styles.spacer} />
                <button type="button" style={styles.secondary} disabled={busy !== undefined} onClick={() => { void test() }}>{busy === 'test' ? tt('mcp.testing') : tt('mcp.test')}</button>
                <button type="button" style={styles.primary} disabled={busy !== undefined} onClick={() => { void save() }}>{busy === 'save' ? tt('common.saving') : tt('common.save')}</button>
              </div>
              {notice === undefined ? null : <div style={noticeStyle(notice)} role="status">{notice.text}</div>}
            </div>
          )}
        </div>
      )}
      {notice !== undefined && (servers === undefined || selection === undefined) ? <div style={{ ...noticeStyle(notice), marginTop: 12 }} role="status">{notice.text}</div> : null}
    </div>
  )
}
