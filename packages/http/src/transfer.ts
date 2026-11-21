/**
 * Export and import of the configuration: targets, saved requests and the
 * history limit as one JSON document. An export carries no secrets; an import
 * is validated as a whole before anything is written.
 */

import { randomBytes } from 'node:crypto'
import { CREDENTIAL_HEADERS } from './engine.ts'
import {
  DIRECT_TARGET_ID, HTTP_BUNDLE_FORMAT, HTTP_BUNDLE_VERSION, MAX_HISTORY_LIMIT, MIN_HISTORY_LIMIT,
  type HttpAuth, type HttpBundle, type HttpBundleTarget, type HttpImportConflict, type HttpImportResult, type HttpKeyValue, type HttpSavedRequest, type HttpSettings, type HttpTarget,
} from './protocol.ts'
import { MAX_REQUESTS_PER_TARGET, TargetValidationError, authMissing, buildTarget, missingSecrets, normalizeRequestPatch } from './store.ts'

const MAX_BUNDLE_TARGETS = 200

/** A credential that references a variable is configuration and is exported; a literal one is blanked. */
function exportedSecret(value: string): string {
  return /\{\{[^{}]+\}\}/.test(value) ? value : ''
}

function blankAuth(auth: HttpAuth): HttpAuth {
  switch (auth.type) {
    case 'none': return { type: 'none' }
    case 'bearer': return { type: 'bearer', token: exportedSecret(auth.token) }
    case 'basic': return { type: 'basic', username: auth.username, password: exportedSecret(auth.password) }
    case 'header': return { type: 'header', name: auth.name, value: exportedSecret(auth.value) }
    case 'query': return { type: 'query', name: auth.name, value: exportedSecret(auth.value) }
  }
}

/** A credential header keeps a value that references a variable; a literal value is blanked. */
function exportedHeaderValue(name: string, value: string): string {
  return CREDENTIAL_HEADERS.has(name.trim().toLowerCase()) ? exportedSecret(value) : value
}

/** The configuration as an export document, without secrets. */
export function exportBundle(targets: readonly HttpTarget[], requests: readonly HttpSavedRequest[], settings: HttpSettings, now = Date.now()): HttpBundle {
  return {
    format: HTTP_BUNDLE_FORMAT,
    version: HTTP_BUNDLE_VERSION,
    exportedAt: now,
    settings: { historyLimit: settings.historyLimit },
    targets: targets.map(target => ({
      id: target.id,
      name: target.name,
      baseUrl: target.baseUrl,
      auth: blankAuth(target.auth),
      headers: Object.fromEntries(Object.entries(target.headers).map(([name, value]) => [name, exportedHeaderValue(name, value)])),
      variables: { ...target.variables },
      secrets: Object.fromEntries(Object.keys(target.secrets).map(name => [name, ''])),
      allowedHosts: [...target.allowedHosts],
      allowMutations: target.allowMutations,
      allowPrivate: target.allowPrivate,
      timeoutMs: target.timeoutMs,
    })),
    requests: requests.filter(request => request.targetId === DIRECT_TARGET_ID || targets.some(target => target.id === request.targetId)).map(request => ({
      id: request.id,
      targetId: request.targetId,
      name: request.name,
      method: request.method,
      path: request.path,
      query: request.query,
      headers: request.headers.map((row): HttpKeyValue => ({ ...row, value: exportedHeaderValue(row.key, row.value) })),
      auth: blankAuth(request.auth),
      bodyMode: request.bodyMode,
      body: request.body,
      form: request.form,
      captures: request.captures,
    })),
  }
}

function fail(message: string): never {
  throw new TargetValidationError(message)
}

/** The next state of both stores after an import, and what the import did. */
export interface ImportPlan {
  targets: HttpTarget[]
  requests: HttpSavedRequest[]
  /** History limit of the file when valid. */
  historyLimit?: number
  result: HttpImportResult
}

/**
 * Validate an export document against the current configuration and compute
 * the state an import leaves. Targets match by name, case-insensitive; the
 * requests without a target form one more unit. `overwrite` replaces a matched
 * target's settings and its request list (a stored secret stays when the
 * authentication type is unchanged, a stored secret variable when its name
 * is); `skip` leaves a matched target and its requests as they are. Nothing
 * is written here.
 * @throws TargetValidationError when the document or one of its entries is invalid.
 */
export function planImport(raw: unknown, current: { targets: readonly HttpTarget[]; requests: readonly HttpSavedRequest[] }, conflict: HttpImportConflict): ImportPlan {
  if (typeof raw !== 'object' || raw === null) fail('not a dsh-http export file')
  const bundle = raw as Partial<HttpBundle>
  if (bundle.format !== HTTP_BUNDLE_FORMAT) fail('not a dsh-http export file')
  if (typeof bundle.version !== 'number' || bundle.version > HTTP_BUNDLE_VERSION) fail(`unsupported export version ${String(bundle.version)}`)
  const fileTargets: unknown[] = Array.isArray(bundle.targets) ? bundle.targets : []
  const fileRequests: unknown[] = Array.isArray(bundle.requests) ? bundle.requests : []
  if (fileTargets.length > MAX_BUNDLE_TARGETS) fail(`at most ${MAX_BUNDLE_TARGETS} targets per file`)

  const result: HttpImportResult = { conflicts: [], created: [], overwritten: [], skipped: [], needAuth: [], requests: 0 }
  const targets = [...current.targets]
  /** File target id → target id that receives its requests; absent for a skipped target. */
  const receiving = new Map<string, string>()
  const replaced = new Set<string>()
  const seenNames = new Set<string>()

  for (const entry of fileTargets) {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<HttpBundleTarget>
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (name === '') fail('a target in the file has no name')
    if (seenNames.has(name.toLowerCase())) fail(`the file lists target '${name}' twice`)
    seenNames.add(name.toLowerCase())
    const index = targets.findIndex(target => target.name.toLowerCase() === name.toLowerCase())
    if (index >= 0) result.conflicts.push(targets[index].name)
    if (index >= 0 && conflict === 'skip') {
      result.skipped.push(targets[index].name)
      continue
    }
    const previous = index >= 0 ? targets[index] : undefined
    const payload = { name, baseUrl: item.baseUrl, auth: item.auth, headers: item.headers ?? {}, variables: item.variables ?? {}, secrets: item.secrets ?? {}, allowedHosts: item.allowedHosts ?? [], allowMutations: item.allowMutations === true, allowPrivate: item.allowPrivate === true, timeoutMs: item.timeoutMs }
    let built: HttpTarget
    try {
      built = buildTarget(payload, { previous, taken: targets.filter((_, i) => i !== index).map(target => target.name), allowMissingSecret: true })
    } catch (error) {
      fail(`target '${name}': ${error instanceof Error ? error.message : String(error)}`)
    }
    // A header whose value the export blanked takes the value the overwritten target holds; without one it is left out.
    const kept = new Map(Object.entries(previous?.headers ?? {}).map(([header, value]): [string, string] => [header.toLowerCase(), value]))
    built.headers = Object.fromEntries(Object.entries(built.headers)
      .map(([header, value]): [string, string] => [header, value !== '' ? value : kept.get(header.toLowerCase()) ?? ''])
      .filter(([, value]) => value !== ''))
    if (previous !== undefined) {
      targets[index] = built
      replaced.add(built.id)
      result.overwritten.push(built.name)
    } else {
      targets.push(built)
      result.created.push(built.name)
    }
    if (authMissing(built.auth) || missingSecrets(built).length > 0) result.needAuth.push(built.name)
    if (typeof item.id === 'string' && item.id !== '') receiving.set(item.id, built.id)
  }

  // Requests without a target: one unit that follows the same choice.
  const fileDirect = fileRequests.some(entry => (entry as { targetId?: unknown } | null)?.targetId === DIRECT_TARGET_ID)
  const haveDirect = current.requests.some(request => request.targetId === DIRECT_TARGET_ID)
  if (fileDirect && haveDirect) result.conflicts.push(DIRECT_TARGET_ID)
  if (fileDirect && !(haveDirect && conflict === 'skip')) {
    receiving.set(DIRECT_TARGET_ID, DIRECT_TARGET_ID)
    if (haveDirect) replaced.add(DIRECT_TARGET_ID)
  }

  const requests = current.requests.filter(request => !replaced.has(request.targetId))
  const usedIds = new Set(requests.map(request => request.id))
  const perTarget = new Map<string, number>()
  for (const request of requests) perTarget.set(request.targetId, (perTarget.get(request.targetId) ?? 0) + 1)
  const now = Date.now()
  for (const entry of fileRequests) {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<HttpSavedRequest>
    const targetId = typeof item.targetId === 'string' ? receiving.get(item.targetId) : undefined
    if (targetId === undefined) continue
    const count = (perTarget.get(targetId) ?? 0) + 1
    if (count > MAX_REQUESTS_PER_TARGET) fail(`at most ${MAX_REQUESTS_PER_TARGET} requests per target`)
    perTarget.set(targetId, count)
    let fields: ReturnType<typeof normalizeRequestPatch>
    try {
      fields = normalizeRequestPatch(item)
    } catch (error) {
      fail(`request '${typeof item.name === 'string' && item.name !== '' ? item.name : String(item.path ?? '')}': ${error instanceof Error ? error.message : String(error)}`)
    }
    // The file's id is kept while it is free, so the history stays linked on a re-import.
    const id = typeof item.id === 'string' && /^[0-9a-f]{12}$/.test(item.id) && !usedIds.has(item.id) ? item.id : randomBytes(6).toString('hex')
    usedIds.add(id)
    requests.push({
      id,
      targetId,
      name: fields.name ?? '',
      method: fields.method ?? 'GET',
      path: fields.path ?? '',
      query: fields.query ?? [],
      headers: fields.headers ?? [],
      auth: fields.auth ?? { type: 'none' },
      bodyMode: fields.bodyMode ?? 'none',
      body: fields.body ?? '',
      form: fields.form ?? [],
      captures: fields.captures ?? [],
      createdAt: now,
      updatedAt: now,
    })
    result.requests++
  }

  const limit = bundle.settings?.historyLimit
  const historyLimit = typeof limit === 'number' && Number.isInteger(limit) && limit >= MIN_HISTORY_LIMIT && limit <= MAX_HISTORY_LIMIT ? limit : undefined
  return { targets, requests, ...(historyLimit !== undefined ? { historyLimit } : {}), result }
}
