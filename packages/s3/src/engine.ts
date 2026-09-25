/**
 * S3 engine: one thin layer over @aws-sdk/client-s3 shared by the routes and
 * the agent tools. Every key that crosses this boundary is RELATIVE to the
 * profile's prefix; the engine maps to/from full bucket keys itself, so the
 * browser and the agent never see (or escape) the scoped prefix.
 */

import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname, extname } from 'node:path'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { S3ListPage, S3ObjectEntry, S3Profile, S3StatResult, S3TestResult } from './protocol.ts'
import type { ProfileStore } from './store.ts'

/** Hard cap on one listing page (S3 itself caps at 1000). */
export const MAX_PAGE = 1000

/** Upper bound for text reads served to the browser / the agent. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Small extension → MIME map so uploads carry a sensible Content-Type. */
const MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', '.yml': 'application/yaml', '.yaml': 'application/yaml', '.xml': 'application/xml',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.ts': 'text/plain; charset=utf-8', '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.tgz': 'application/gzip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.wasm': 'application/wasm', '.parquet': 'application/vnd.apache.parquet', '.log': 'text/plain; charset=utf-8',
}

/** Guess a MIME type from a key/file name. */
export function guessMime(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** Whether a MIME type is renderable as text in the preview. */
export function isTextMime(type: string | undefined): boolean {
  if (type === undefined) return false
  const t = type.toLowerCase()
  return t.startsWith('text/') || t.includes('json') || t.includes('xml') || t.includes('yaml') || t.includes('javascript') || t.includes('x-sh')
}

/** Whether a buffer looks like text (no NUL in the first 8 KiB, valid-ish UTF-8). */
export function looksLikeText(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 8192)
  if (head.length === 0) return true
  let control = 0
  for (const byte of head) {
    if (byte === 0) return false
    // Control bytes other than tab / newline / CR / FF / ESC / backspace.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x1b && byte !== 0x08) control++
  }
  return control / head.length < 0.1
}

/** Normalize a relative key: no leading slashes, no backslashes, no `..` segments. */
export function cleanKey(key: string): string {
  const value = key.replace(/\\/g, '/').replace(/^\/+/, '')
  if (value.split('/').some(seg => seg === '..')) throw new Error('key must not contain ".." segments')
  return value
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    return name + error.message
  }
  return String(error)
}

async function streamToBuffer(body: unknown, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error(`object exceeds the ${maxBytes} byte read limit; use a download instead`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** One S3 engine per host process; clients are cached per profile revision. */
export class S3Engine {
  private readonly clients = new Map<string, { updatedAt: number; client: S3Client }>()
  private readonly store: ProfileStore

  constructor(store: ProfileStore) {
    this.store = store
    store.subscribe(() => { this.clients.clear() })
  }

  /** Resolve a profile by id or name; throws when unknown. */
  profile(idOrName: string): S3Profile {
    const profile = this.store.find(idOrName)
    if (profile === undefined) throw new Error(`unknown bucket profile '${idOrName}' (configure it in the S3 panel first)`)
    return profile
  }

  private client(profile: S3Profile): S3Client {
    const cached = this.clients.get(profile.id)
    if (cached !== undefined && cached.updatedAt === profile.updatedAt) return cached.client
    const client = new S3Client({
      region: profile.region || 'us-east-1',
      ...(profile.endpoint !== '' ? { endpoint: profile.endpoint } : {}),
      forcePathStyle: profile.pathStyle,
      credentials: { accessKeyId: profile.accessKeyId, secretAccessKey: profile.secretAccessKey },
      // Default SDK integrity checksums (CRC32 headers on every PUT/DELETE)
      // break many S3-compatible services; only send them where the API
      // requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    })
    this.clients.set(profile.id, { updatedAt: profile.updatedAt, client })
    return client
  }

  private full(profile: S3Profile, key: string): string {
    return profile.prefix + cleanKey(key)
  }

  private rel(profile: S3Profile, fullKey: string): string {
    return fullKey.startsWith(profile.prefix) ? fullKey.slice(profile.prefix.length) : fullKey
  }

  /** Connection test: one small listing under the profile prefix. */
  async test(idOrName: string): Promise<S3TestResult> {
    const started = Date.now()
    try {
      const profile = this.profile(idOrName)
      const out = await this.client(profile).send(new ListObjectsV2Command({ Bucket: profile.bucket, Prefix: profile.prefix, MaxKeys: 5 }))
      const sample = [...(out.CommonPrefixes ?? []).map(p => p.Prefix ?? ''), ...(out.Contents ?? []).map(o => o.Key ?? '')]
        .filter(k => k !== '').map(k => this.rel(profile, k))
      return { ok: true, latencyMs: Date.now() - started, sample }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: errorText(error) }
    }
  }

  /** One delimiter listing page under a relative prefix. */
  async list(idOrName: string, prefix: string, token?: string, maxKeys = MAX_PAGE): Promise<S3ListPage> {
    const profile = this.profile(idOrName)
    const relPrefix = prefix === '' ? '' : cleanKey(prefix)
    const fullPrefix = profile.prefix + relPrefix
    const out = await this.client(profile).send(new ListObjectsV2Command({
      Bucket: profile.bucket,
      Prefix: fullPrefix,
      Delimiter: '/',
      MaxKeys: Math.max(1, Math.min(MAX_PAGE, maxKeys)),
      ...(token !== undefined && token !== '' ? { ContinuationToken: token } : {}),
    }))
    const folders = (out.CommonPrefixes ?? []).map(p => this.rel(profile, p.Prefix ?? '')).filter(p => p !== '')
    const objects: S3ObjectEntry[] = []
    for (const item of out.Contents ?? []) {
      const key = item.Key ?? ''
      // The folder marker object itself (key === prefix) is not an entry.
      if (key === '' || key === fullPrefix) continue
      objects.push({
        key: this.rel(profile, key),
        size: item.Size ?? 0,
        lastModified: item.LastModified?.toISOString() ?? '',
        ...(item.ETag !== undefined ? { etag: item.ETag } : {}),
        ...(item.StorageClass !== undefined ? { storageClass: item.StorageClass } : {}),
      })
    }
    return {
      prefix: relPrefix,
      folders,
      objects,
      truncated: out.IsTruncated === true,
      ...(out.NextContinuationToken !== undefined ? { nextToken: out.NextContinuationToken } : {}),
    }
  }

  /** Walk every object under a relative prefix (recursive, no delimiter). */
  async *walk(idOrName: string, prefix: string): AsyncGenerator<S3ObjectEntry> {
    const profile = this.profile(idOrName)
    const fullPrefix = profile.prefix + (prefix === '' ? '' : cleanKey(prefix))
    let token: string | undefined
    do {
      const out = await this.client(profile).send(new ListObjectsV2Command({
        Bucket: profile.bucket, Prefix: fullPrefix, MaxKeys: MAX_PAGE,
        ...(token !== undefined ? { ContinuationToken: token } : {}),
      }))
      for (const item of out.Contents ?? []) {
        const key = item.Key ?? ''
        if (key === '') continue
        yield { key: this.rel(profile, key), size: item.Size ?? 0, lastModified: item.LastModified?.toISOString() ?? '' }
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (token !== undefined)
  }

  /** HEAD one object. */
  async stat(idOrName: string, key: string): Promise<S3StatResult> {
    const profile = this.profile(idOrName)
    const out = await this.client(profile).send(new HeadObjectCommand({ Bucket: profile.bucket, Key: this.full(profile, key) }))
    return {
      key: cleanKey(key),
      size: out.ContentLength ?? 0,
      ...(out.ContentType !== undefined ? { contentType: out.ContentType } : {}),
      ...(out.LastModified !== undefined ? { lastModified: out.LastModified.toISOString() } : {}),
      ...(out.ETag !== undefined ? { etag: out.ETag } : {}),
      ...(out.StorageClass !== undefined ? { storageClass: out.StorageClass } : {}),
      metadata: { ...(out.Metadata ?? {}) },
    }
  }

  /** Open one object as a byte stream (download / inline preview). */
  async open(idOrName: string, key: string): Promise<{ body: Readable; contentType: string; size?: number; lastModified?: Date }> {
    const profile = this.profile(idOrName)
    const out = await this.client(profile).send(new GetObjectCommand({ Bucket: profile.bucket, Key: this.full(profile, key) }))
    if (out.Body === undefined) throw new Error('empty response body')
    const body = out.Body instanceof Readable ? out.Body : Readable.from(out.Body as unknown as AsyncIterable<Uint8Array>)
    return {
      body,
      contentType: out.ContentType ?? guessMime(key),
      ...(out.ContentLength !== undefined ? { size: out.ContentLength } : {}),
      ...(out.LastModified !== undefined ? { lastModified: out.LastModified } : {}),
    }
  }

  /** Read one object as text (bounded; binary content is rejected). */
  async getText(idOrName: string, key: string, maxBytes = MAX_TEXT_BYTES): Promise<{ text: string; size: number; contentType: string; truncated: boolean }> {
    const profile = this.profile(idOrName)
    const limit = Math.max(1, Math.min(MAX_TEXT_BYTES, maxBytes))
    const out = await this.client(profile).send(new GetObjectCommand({
      Bucket: profile.bucket, Key: this.full(profile, key), Range: `bytes=0-${limit}`,
    }))
    if (out.Body === undefined) throw new Error('empty response body')
    const buffer = await streamToBuffer(out.Body, limit + 1)
    if (!looksLikeText(buffer)) throw new Error('object is binary; download it instead of reading it as text')
    const total = parseTotal(out.ContentRange) ?? out.ContentLength ?? buffer.length
    const truncated = buffer.length > limit || total > limit
    return {
      text: buffer.subarray(0, limit).toString('utf8'),
      size: total,
      contentType: out.ContentType ?? guessMime(key),
      truncated,
    }
  }

  /** Write a small text/binary body. */
  async put(idOrName: string, key: string, body: Buffer | string, contentType?: string): Promise<{ etag?: string; size: number }> {
    const profile = this.profile(idOrName)
    const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    const out = await this.client(profile).send(new PutObjectCommand({
      Bucket: profile.bucket, Key: this.full(profile, key), Body: buffer,
      ContentType: contentType ?? guessMime(key), ContentLength: buffer.length,
    }))
    return { size: buffer.length, ...(out.ETag !== undefined ? { etag: out.ETag } : {}) }
  }

  /** Stream a body of unknown size (multipart above 5 MiB). */
  async uploadStream(idOrName: string, key: string, body: Readable, contentType?: string, onProgress?: (loaded: number) => void): Promise<void> {
    const profile = this.profile(idOrName)
    const upload = new Upload({
      client: this.client(profile),
      params: { Bucket: profile.bucket, Key: this.full(profile, key), Body: body, ContentType: contentType ?? guessMime(key) },
      partSize: 8 * 1024 * 1024,
      queueSize: 3,
      leavePartsOnError: false,
    })
    if (onProgress !== undefined) upload.on('httpUploadProgress', p => { if (typeof p.loaded === 'number') onProgress(p.loaded) })
    await upload.done()
  }

  /** Upload one local file. */
  async uploadFile(idOrName: string, localPath: string, key: string): Promise<{ size: number }> {
    const size = statSync(localPath).size
    await this.uploadStream(idOrName, key, createReadStream(localPath), guessMime(localPath))
    return { size }
  }

  /** Download one object to a local path (parent dirs created). */
  async downloadFile(idOrName: string, key: string, localPath: string): Promise<{ size: number }> {
    const { body } = await this.open(idOrName, key)
    mkdirSync(dirname(localPath), { recursive: true })
    await pipeline(body, createWriteStream(localPath))
    return { size: statSync(localPath).size }
  }

  /** Create a folder marker (zero-byte object with a trailing slash). */
  async mkdir(idOrName: string, key: string): Promise<void> {
    const profile = this.profile(idOrName)
    const marker = cleanKey(key).replace(/\/+$/, '') + '/'
    await this.client(profile).send(new PutObjectCommand({ Bucket: profile.bucket, Key: profile.prefix + marker, Body: Buffer.alloc(0), ContentLength: 0 }))
  }

  /**
   * Delete objects by relative key. Prefixes ending in `/` delete everything
   * underneath (recursive walk). Returns the deleted count and per-key errors.
   */
  async delete(idOrName: string, keys: string[]): Promise<{ deleted: number; errors: { key: string; error: string }[] }> {
    const profile = this.profile(idOrName)
    const targets: string[] = []
    for (const raw of keys) {
      const key = cleanKey(raw)
      if (key === '') continue
      if (key.endsWith('/')) {
        for await (const entry of this.walk(idOrName, key)) targets.push(profile.prefix + entry.key)
        targets.push(profile.prefix + key) // the marker itself, if any
      } else {
        targets.push(profile.prefix + key)
      }
    }
    const unique = [...new Set(targets)]
    let deleted = 0
    const errors: { key: string; error: string }[] = []
    const client = this.client(profile)
    for (let i = 0; i < unique.length; i += 1000) {
      const batch = unique.slice(i, i + 1000)
      try {
        const out = await client.send(new DeleteObjectsCommand({
          Bucket: profile.bucket, Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true },
        }))
        deleted += batch.length - (out.Errors?.length ?? 0)
        for (const e of out.Errors ?? []) errors.push({ key: this.rel(profile, e.Key ?? ''), error: `${e.Code ?? ''} ${e.Message ?? ''}`.trim() })
      } catch (error) {
        // Some S3-compatible services lack multi-object delete (or reject
        // its checksum header): fall back to one request per key.
        const first = errorText(error)
        for (const Key of batch) {
          try {
            await client.send(new DeleteObjectCommand({ Bucket: profile.bucket, Key }))
            deleted += 1
          } catch (inner) {
            errors.push({ key: this.rel(profile, Key), error: `${errorText(inner)} (batch delete failed: ${first})` })
          }
        }
      }
    }
    return { deleted, errors }
  }

  /** Server-side copy (optionally deleting the source). Objects above 5 GiB need multipart copy and fail here. */
  async copy(idOrName: string, from: string, to: string, move = false): Promise<void> {
    const profile = this.profile(idOrName)
    const source = this.full(profile, from)
    const target = this.full(profile, to)
    if (source === target) throw new Error('source and target are the same key')
    const client = this.client(profile)
    await client.send(new CopyObjectCommand({
      Bucket: profile.bucket,
      Key: target,
      CopySource: `${profile.bucket}/${source.split('/').map(encodeURIComponent).join('/')}`,
      MetadataDirective: 'COPY',
    }))
    if (move) await client.send(new DeleteObjectCommand({ Bucket: profile.bucket, Key: source }))
  }

  /** Presigned URL for a GET (download) or PUT (upload) of one key. */
  async presign(idOrName: string, key: string, expiresIn = 3600, method: 'GET' | 'PUT' = 'GET'): Promise<{ url: string; expiresAt: string }> {
    const profile = this.profile(idOrName)
    const seconds = Math.max(1, Math.min(7 * 24 * 3600, Math.floor(expiresIn)))
    const params = { Bucket: profile.bucket, Key: this.full(profile, key) }
    const command = method === 'PUT' ? new PutObjectCommand(params) : new GetObjectCommand(params)
    const url = await getSignedUrl(this.client(profile), command, { expiresIn: seconds })
    return { url, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() }
  }

  dispose(): void {
    for (const entry of this.clients.values()) entry.client.destroy()
    this.clients.clear()
  }
}

function parseTotal(contentRange: string | undefined): number | undefined {
  const match = contentRange !== undefined ? /\/(\d+)$/.exec(contentRange) : null
  return match !== null ? Number(match[1]) : undefined
}
