/**
 * Structural edits of a profile patch (`cordis.patch.yml`): a top-level YAML
 * sequence of loader patch rows. Edits address rows by entry id and leave
 * every other row, comment and `!!js` expression as written.
 *
 * MCP servers: children of top-level `insert` lists whose `name` is
 * `@deepseek-ai/dsh-mcp-client`.
 * Built-in plugin settings: top-level override rows (`- id: <entry>`), one
 * `config` key or the `disabled` field per registry option.
 */

import { Scalar, YAMLMap, YAMLSeq, isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml'
import { JS_PREFIX } from './mcp.ts'
import type { McpServer, SettingValue } from './protocol.ts'
import { SETTINGS, settingValueValid, type SettingOption, type SettingValues } from './settings.ts'

export const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

const JS_TAG = 'tag:yaml.org,2002:js'
const STDIO_KEYS = ['command', 'args', 'env', 'cwd'] as const
const HTTP_KEYS = ['url', 'headers'] as const

export type PatchDocument = Document

export type PatchIssue = 'duplicate-name' | 'duplicate-id' | 'missing'

/** An edit the document cannot take; `issue` is the machine-readable reason. */
export class PatchError extends Error {
  readonly issue: PatchIssue
  constructor(issue: PatchIssue, message: string) {
    super(message)
    this.name = 'PatchError'
    this.issue = issue
  }
}

export interface McpEntry {
  id: string
  server: McpServer
}

/**
 * Parse patch text. Blank text and comment-only text are the empty list.
 * @throws on YAML errors or a non-sequence top level.
 */
export function parsePatch(text: string): PatchDocument {
  const document = parseDocument(text.trim() === '' ? '[]\n' : text, {
    customTags: [{ tag: JS_TAG, resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (document.contents === null) document.contents = new YAMLSeq() as unknown as typeof document.contents
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  return document
}

/** Patch text; long scalars stay on one line. */
export function renderPatch(document: PatchDocument): string {
  return document.toString({ lineWidth: 0 })
}

function topRows(document: PatchDocument): YAMLSeq {
  return document.contents as unknown as YAMLSeq
}

/** Form text of a scalar; loader expressions carry the `!!js ` prefix. */
function plain(node: unknown): string | undefined {
  if (!isScalar(node) || node.value === null || node.value === undefined) return undefined
  return node.tag === JS_TAG ? JS_PREFIX + String(node.value) : String(node.value)
}

function plainList(node: unknown): string[] {
  if (!isSeq(node)) return []
  return node.items.flatMap((item) => {
    const value = plain(item)
    return value === undefined ? [] : [value]
  })
}

function plainDict(node: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isMap(node)) return out
  for (const pair of node.items) {
    const key = plain(pair.key)
    const value = plain(pair.value)
    if (key !== undefined && value !== undefined) out[key] = value
  }
  return out
}

function textNode(document: PatchDocument, value: string): Scalar {
  if (!value.startsWith(JS_PREFIX)) return document.createNode(value) as Scalar
  const expression = new Scalar(value.slice(JS_PREFIX.length).trim())
  expression.tag = JS_TAG
  return expression
}

function listNode(document: PatchDocument, values: readonly string[]): YAMLSeq {
  const seq = new YAMLSeq()
  for (const value of values) seq.add(textNode(document, value))
  return seq
}

function dictNode(document: PatchDocument, values: Record<string, string>): YAMLMap {
  const map = new YAMLMap()
  for (const [key, value] of Object.entries(values)) map.set(document.createNode(key), textNode(document, value))
  return map
}

interface Located {
  insert: YAMLSeq
  top: YAMLMap
  node: YAMLMap
}

function mcpNodes(document: PatchDocument): Located[] {
  const found: Located[] = []
  for (const top of topRows(document).items) {
    if (!isMap(top)) continue
    const insert = top.get('insert', true)
    if (!isSeq(insert)) continue
    for (const node of insert.items) {
      if (isMap(node) && node.get('name') === MCP_CLIENT) found.push({ insert, top, node })
    }
  }
  return found
}

function idOf(node: YAMLMap): string {
  const id = node.get('id')
  return typeof id === 'string' ? id : ''
}

/** Top-level rows that override an entry: same id, not an `insert` row. */
function overrideRows(document: PatchDocument, id: string): YAMLMap[] {
  return topRows(document).items.filter((row): row is YAMLMap => isMap(row) && !row.has('insert') && row.get('id') === id)
}

function removeRow(seq: YAMLSeq, row: unknown): void {
  const index = seq.items.indexOf(row)
  if (index >= 0) seq.items.splice(index, 1)
}

/** Drop override rows left with nothing but their address. */
function pruneRows(document: PatchDocument, rows: readonly YAMLMap[]): void {
  for (const row of rows) {
    if (row.items.every(pair => ['id', 'name'].includes(String(plain(pair.key))))) removeRow(topRows(document), row)
  }
}

function readServer(document: PatchDocument, node: YAMLMap): McpServer {
  const config = node.get('config', true)
  const get = (key: string): unknown => (isMap(config) ? config.get(key, true) : undefined)
  let disabled = node.get('disabled') === true
  for (const row of overrideRows(document, idOf(node))) {
    const value = row.get('disabled')
    if (typeof value === 'boolean') disabled = value
  }
  const base = { serverName: plain(get('serverName')) ?? '', enabled: !disabled }
  if (plain(get('transport')) === 'stdio') {
    const server: McpServer = { ...base, transport: 'stdio', command: plain(get('command')) ?? '' }
    const args = plainList(get('args'))
    if (args.length > 0) server.args = args
    const env = plainDict(get('env'))
    if (Object.keys(env).length > 0) server.env = env
    const cwd = plain(get('cwd'))
    if (cwd !== undefined && cwd !== '') server.cwd = cwd
    return server
  }
  const server: McpServer = { ...base, transport: 'streamable-http', url: plain(get('url')) ?? '' }
  const headers = plainDict(get('headers'))
  if (Object.keys(headers).length > 0) server.headers = headers
  return server
}

/** MCP servers in document order. */
export function listMcp(document: PatchDocument): McpEntry[] {
  return mcpNodes(document).map(({ node }) => ({ id: idOf(node), server: readServer(document, node) }))
}

/** The row's `config` map, created when absent or not a map. */
function configOf(row: YAMLMap): YAMLMap {
  const existing: unknown = row.get('config', true)
  if (isMap(existing)) return existing
  const config = new YAMLMap()
  row.set('config', config)
  return config
}

/** Write the form's fields onto the entry's config; a field whose value is unchanged keeps its node and formatting. */
function writeConfig(document: PatchDocument, node: YAMLMap, server: McpServer): void {
  const map = configOf(node)
  const text = (key: string, value: string | undefined): void => {
    if (value === undefined || value === '') map.delete(key)
    else if (plain(map.get(key, true)) !== value) map.set(key, textNode(document, value))
  }
  const list = (key: string, values: readonly string[] | undefined): void => {
    if (values === undefined || values.length === 0) map.delete(key)
    else if (JSON.stringify(plainList(map.get(key, true))) !== JSON.stringify(values)) map.set(key, listNode(document, values))
  }
  const dict = (key: string, values: Record<string, string> | undefined): void => {
    if (values === undefined || Object.keys(values).length === 0) map.delete(key)
    else if (JSON.stringify(Object.entries(plainDict(map.get(key, true)))) !== JSON.stringify(Object.entries(values))) map.set(key, dictNode(document, values))
  }
  text('serverName', server.serverName)
  text('transport', server.transport)
  if (server.transport === 'stdio') {
    for (const key of HTTP_KEYS) map.delete(key)
    text('command', server.command)
    list('args', server.args)
    dict('env', server.env)
    text('cwd', server.cwd)
  } else {
    for (const key of STDIO_KEYS) map.delete(key)
    text('url', server.url)
    dict('headers', server.headers)
  }
}

/** Every entry id declared by an `insert` list of this document. */
function insertedIds(document: PatchDocument): Set<string> {
  const ids = new Set<string>()
  for (const top of topRows(document).items) {
    if (!isMap(top)) continue
    const insert = top.get('insert', true)
    if (!isSeq(insert)) continue
    for (const node of insert.items) if (isMap(node)) ids.add(idOf(node))
  }
  return ids
}

/**
 * Create a server, or update the one addressed by `id`. Fields outside the
 * form (timeouts, reconnect policy) stay as written. An entry whose id follows
 * `mcp-<serverName>` is re-addressed when the name changes.
 * @returns the entry id after the edit.
 * @throws {PatchError} on a name or id already taken, or an unknown `id`.
 */
export function upsertMcp(document: PatchDocument, server: McpServer, id?: string): string {
  const nodes = mcpNodes(document)
  const current = id === undefined ? undefined : nodes.find(({ node }) => idOf(node) === id)
  if (id !== undefined && current === undefined) throw new PatchError('missing', `MCP entry "${id}" is not in the profile patch`)
  for (const { node } of nodes) {
    if (node !== current?.node && readServer(document, node).serverName === server.serverName) {
      throw new PatchError('duplicate-name', `serverName "${server.serverName}" is already in use`)
    }
  }
  const derived = `mcp-${server.serverName}`
  let target: YAMLMap
  let nextId: string
  if (current === undefined) {
    nextId = derived
    if (insertedIds(document).has(nextId)) throw new PatchError('duplicate-id', `entry id "${nextId}" is already in use`)
    target = new YAMLMap()
    target.set('id', nextId)
    target.set('name', MCP_CLIENT)
    const host = nodes[0]?.insert
    if (host !== undefined) host.add(target)
    else {
      const row = new YAMLMap()
      const insert = new YAMLSeq()
      insert.add(target)
      row.set('insert', insert)
      topRows(document).flow = false
      topRows(document).add(row)
    }
  } else {
    target = current.node
    const previousId = idOf(target)
    const previousName = readServer(document, target).serverName
    nextId = previousId === `mcp-${previousName}` ? derived : previousId
    if (nextId !== previousId) {
      if (insertedIds(document).has(nextId)) throw new PatchError('duplicate-id', `entry id "${nextId}" is already in use`)
      for (const row of overrideRows(document, previousId)) removeRow(topRows(document), row)
      target.set('id', nextId)
    }
  }
  const overrides = overrideRows(document, nextId)
  for (const row of overrides) row.delete('disabled')
  pruneRows(document, overrides)
  if (server.enabled) target.delete('disabled')
  else target.set('disabled', true)
  writeConfig(document, target, server)
  return nextId
}

/**
 * Remove a server with its override rows; an `insert` list left empty goes
 * with it.
 * @throws {PatchError} when `id` is not an MCP entry of this document.
 */
export function removeMcp(document: PatchDocument, id: string): void {
  const found = mcpNodes(document).find(({ node }) => idOf(node) === id)
  if (found === undefined) throw new PatchError('missing', `MCP entry "${id}" is not in the profile patch`)
  removeRow(found.insert, found.node)
  if (found.insert.items.length === 0) {
    if (found.top.items.length === 1) removeRow(topRows(document), found.top)
    else found.top.delete('insert')
  }
  for (const row of overrideRows(document, id)) removeRow(topRows(document), row)
}

function optionValue(option: SettingOption, row: YAMLMap): unknown {
  if (option.kind === 'enable') {
    const disabled = row.get('disabled')
    return typeof disabled === 'boolean' ? !disabled : undefined
  }
  const config = row.get('config', true)
  return isMap(config) && option.configKey !== undefined ? config.get(option.configKey) : undefined
}

function clearOption(option: SettingOption, row: YAMLMap): void {
  if (option.kind === 'enable') {
    row.delete('disabled')
    return
  }
  const config = row.get('config', true)
  if (!isMap(config) || option.configKey === undefined) return
  config.delete(option.configKey)
  if (config.items.length === 0) row.delete('config')
}

/** Overrides the document sets, by option key; later rows win. */
export function readSettings(document: PatchDocument): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const option of SETTINGS) {
    for (const row of overrideRows(document, option.entryId)) {
      const value = optionValue(option, row)
      if (settingValueValid(option, value)) out[option.key] = value
    }
  }
  return out
}

/**
 * Apply option values: a value lands on the entry's last override row (created
 * when absent) and leaves the earlier rows; `null` removes the override.
 * Keys outside `values` are untouched.
 */
export function writeSettings(document: PatchDocument, values: SettingValues): void {
  for (const option of SETTINGS) {
    const value = values[option.key]
    if (value === undefined) continue
    const rows = overrideRows(document, option.entryId)
    for (const row of rows) clearOption(option, row)
    if (value !== null) {
      let target = rows.at(-1)
      if (target === undefined) {
        target = new YAMLMap()
        target.set('id', option.entryId)
        topRows(document).flow = false
        topRows(document).add(target)
        rows.push(target)
      }
      if (option.kind === 'enable') target.set('disabled', !value)
      else if (option.configKey !== undefined) configOf(target).set(option.configKey, value)
    }
    pruneRows(document, rows)
  }
}
