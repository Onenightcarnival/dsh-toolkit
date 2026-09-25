/** Browser-side client for the /api/dsh-s3 route family (same origin, cookie auth). */

import { S3_API, type S3ListPage, type S3ProfilePayload, type S3ProfileSummary, type S3Settings, type S3StatResult, type S3TestResult } from '../protocol.ts'
import { tt } from './locales.ts'

export class S3ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'S3ApiError'
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (response.status === 404) throw new S3ApiError(tt('error.disabled'), 404)
    throw new S3ApiError(`HTTP ${response.status}`, response.status)
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | null)?.error
    throw new S3ApiError(typeof error === 'string' ? error : `HTTP ${response.status}`, response.status)
  }
  return body as T
}

const JSON_HEADERS = { 'content-type': 'application/json' }

export interface UploadProgress { loaded: number; total: number }

export class S3Api {
  async profiles(): Promise<S3ProfileSummary[]> {
    return (await readJson<{ profiles: S3ProfileSummary[] }>(await fetch(S3_API.profiles, { credentials: 'same-origin' }))).profiles
  }

  async createProfile(payload: S3ProfilePayload): Promise<S3ProfileSummary> {
    return (await readJson<{ profile: S3ProfileSummary }>(await fetch(S3_API.profiles, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload), credentials: 'same-origin' }))).profile
  }

  async updateProfile(id: string, payload: S3ProfilePayload): Promise<S3ProfileSummary> {
    return (await readJson<{ profile: S3ProfileSummary }>(await fetch(`${S3_API.profiles}?id=${encodeURIComponent(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(payload), credentials: 'same-origin' }))).profile
  }

  async deleteProfile(id: string): Promise<void> {
    await readJson(await fetch(`${S3_API.profiles}?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }))
  }

  async settings(): Promise<S3Settings> {
    return (await readJson<{ settings: S3Settings }>(await fetch(S3_API.settings, { credentials: 'same-origin' }))).settings
  }

  async saveSettings(patch: Partial<S3Settings>): Promise<S3Settings> {
    return (await readJson<{ settings: S3Settings }>(await fetch(S3_API.settings, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(patch), credentials: 'same-origin' }))).settings
  }

  async test(id: string): Promise<S3TestResult> {
    return (await readJson<{ result: S3TestResult }>(await fetch(S3_API.test, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id }), credentials: 'same-origin' }))).result
  }

  async list(id: string, prefix: string, token?: string): Promise<S3ListPage> {
    const params = new URLSearchParams({ id, prefix })
    if (token !== undefined) params.set('token', token)
    return (await readJson<{ page: S3ListPage }>(await fetch(`${S3_API.list}?${params.toString()}`, { credentials: 'same-origin' }))).page
  }

  async stat(id: string, key: string): Promise<S3StatResult> {
    const params = new URLSearchParams({ id, key })
    return (await readJson<{ stat: S3StatResult }>(await fetch(`${S3_API.stat}?${params.toString()}`, { credentials: 'same-origin' }))).stat
  }

  async text(id: string, key: string): Promise<{ text: string; size: number; contentType: string; truncated: boolean; maxBytes: number }> {
    const params = new URLSearchParams({ id, key })
    return readJson(await fetch(`${S3_API.text}?${params.toString()}`, { credentials: 'same-origin' }))
  }

  objectUrl(id: string, key: string, inline = false): string {
    const params = new URLSearchParams({ id, key })
    if (inline) params.set('inline', '1')
    return `${S3_API.object}?${params.toString()}`
  }

  /** XHR so upload progress is observable; resolves on 2xx. */
  upload(id: string, key: string, file: File, onProgress?: (p: UploadProgress) => void): { promise: Promise<void>; abort: () => void } {
    const xhr = new XMLHttpRequest()
    const params = new URLSearchParams({ id, key })
    const promise = new Promise<void>((resolve, reject) => {
      xhr.open('PUT', `${S3_API.upload}?${params.toString()}`)
      xhr.withCredentials = true
      if (file.type !== '') xhr.setRequestHeader('content-type', file.type)
      xhr.upload.onprogress = (event) => {
        if (onProgress !== undefined && event.lengthComputable) onProgress({ loaded: event.loaded, total: event.total })
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve()
          return
        }
        let message = `HTTP ${xhr.status}`
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: unknown }
          if (typeof parsed.error === 'string') message = parsed.error
        } catch { /* keep the status */ }
        reject(new S3ApiError(message, xhr.status))
      }
      xhr.onerror = () => { reject(new S3ApiError('network error')) }
      xhr.onabort = () => { reject(new S3ApiError('aborted')) }
      xhr.send(file)
    })
    return { promise, abort: () => { xhr.abort() } }
  }

  async delete(id: string, keys: string[]): Promise<{ deleted: number; errors: { key: string; error: string }[] }> {
    return (await readJson<{ result: { deleted: number; errors: { key: string; error: string }[] } }>(await fetch(S3_API.delete, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id, keys }), credentials: 'same-origin' }))).result
  }

  async mkdir(id: string, key: string): Promise<void> {
    await readJson(await fetch(S3_API.folder, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id, key }), credentials: 'same-origin' }))
  }

  async presign(id: string, key: string, expiresIn: number): Promise<{ url: string; expiresAt: string }> {
    return readJson(await fetch(S3_API.presign, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id, key, expiresIn, method: 'GET' }), credentials: 'same-origin' }))
  }

  async copy(id: string, from: string, to: string, move: boolean): Promise<void> {
    await readJson(await fetch(S3_API.copy, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id, from, to, move }), credentials: 'same-origin' }))
  }
}
