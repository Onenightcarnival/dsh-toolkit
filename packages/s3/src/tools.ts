/**
 * Agent tools (s3_*): the same engine the panel uses, so a bucket configured
 * in the GUI is immediately operable by the agent — but only while the user
 * has switched "agent tools" on in the panel. Keys are relative to the
 * profile prefix. Nothing here ever returns credentials.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { MAX_TEXT_BYTES, type S3Engine } from './engine.ts'
import type { S3ListPage, S3ProfileSummary, S3StatResult } from './protocol.ts'
import type { ProfileStore } from './store.ts'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function err(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    return name + error.message
  }
  return String(error)
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

const PROFILE_PARAM = { type: 'string', required: true, description: 'Bucket profile name (or id) from s3_buckets.' } as const

/** Agent-visible listing cap per call (keeps one page inside the context budget). */
const TOOL_LIST_MAX = 500

export function s3BucketsTool(store: ProfileStore) {
  return defineTool({
    name: 's3_buckets',
    description: 'List the S3-compatible bucket profiles configured in the dsh S3 panel (name, bucket, endpoint, region, key prefix). Every other s3_* tool takes one of these profile names. Triggers: S3, bucket, object storage, MinIO, OSS, COS, R2, cloud storage files.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          profiles: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                bucket: { type: 'string', required: true },
                endpoint: { type: 'string', required: true },
                region: { type: 'string', required: true },
                accessKeyHint: { type: 'string', required: true },
                pathStyle: { type: 'boolean', required: true },
                prefix: { type: 'string', required: true },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { profiles?: S3ProfileSummary[] }) => {
        const profiles = value.profiles ?? []
        if (profiles.length === 0) return text('no bucket profiles configured (the user adds them in the S3 panel)')
        return text(['name | bucket | endpoint | region | prefix', '--- | --- | --- | --- | ---',
          ...profiles.map(p => `${p.name} | ${p.bucket} | ${p.endpoint || '(aws)'} | ${p.region} | ${p.prefix || '/'}`)].join('\n'))
      },
    },
    async execute() {
      return { profiles: store.list().map(p => store.summarize(p)) }
    },
  })
}

export function s3ListTool(engine: S3Engine) {
  return defineTool({
    name: 's3_list',
    description: 'List one "directory" level of a bucket profile: sub-prefixes (folders) and objects directly under `prefix` (delimiter "/"). Paginated — pass `token` from the previous result to continue. Set `recursive` to walk every object under the prefix instead (capped by `max`). Keys are relative to the profile prefix.',
    parameters: {
      profile: PROFILE_PARAM,
      prefix: { type: 'string', description: 'Key prefix to list under, e.g. "logs/2026/" (empty = root of the profile).' },
      token: { type: 'string', description: 'Continuation token from a previous truncated page.' },
      max: { type: 'integer', description: `Max entries to return (default 200, cap ${TOOL_LIST_MAX}).` },
      recursive: { type: 'boolean', description: 'Walk all objects under the prefix (no folder grouping).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          prefix: { type: 'string' },
          folders: { type: 'array', items: { type: 'string' } },
          objects: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                lastModified: { type: 'string', required: true },
                etag: { type: 'string' },
                storageClass: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean' },
          nextToken: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: Partial<S3ListPage> & { ok: boolean; error?: string }) => {
        if (!value.ok) return text(`list failed: ${value.error ?? 'unknown error'}`)
        const lines: string[] = [`prefix: ${value.prefix || '/'}`]
        for (const folder of value.folders ?? []) lines.push(`[dir]  ${folder}`)
        for (const object of value.objects ?? []) lines.push(`${human(object.size).padStart(10)}  ${object.lastModified.slice(0, 19).replace('T', ' ')}  ${object.key}`)
        if ((value.folders?.length ?? 0) + (value.objects?.length ?? 0) === 0) lines.push('(empty)')
        if (value.truncated) lines.push(value.nextToken !== undefined ? `… truncated; continue with token=${value.nextToken}` : '… truncated at max; raise max or narrow the prefix')
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const max = Math.max(1, Math.min(TOOL_LIST_MAX, args.max ?? 200))
      try {
        if (args.recursive === true) {
          const objects: S3ListPage['objects'] = []
          let truncated = false
          for await (const entry of engine.walk(args.profile, args.prefix ?? '')) {
            if (objects.length >= max) { truncated = true; break }
            objects.push(entry)
          }
          return { ok: true, prefix: args.prefix ?? '', folders: [], objects, truncated }
        }
        const page = await engine.list(args.profile, args.prefix ?? '', args.token, max)
        return { ok: true, ...page }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

export function s3StatTool(engine: S3Engine) {
  return defineTool({
    name: 's3_stat',
    description: 'HEAD one object: size, content type, last modified, ETag, storage class, user metadata.',
    parameters: {
      profile: PROFILE_PARAM,
      key: { type: 'string', required: true, description: 'Object key (relative to the profile prefix).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          key: { type: 'string' },
          size: { type: 'integer' },
          contentType: { type: 'string' },
          lastModified: { type: 'string' },
          etag: { type: 'string' },
          storageClass: { type: 'string' },
          metadata: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: Partial<S3StatResult> & { ok: boolean; error?: string }) => {
        if (!value.ok) return text(`stat failed: ${value.error ?? 'unknown error'}`)
        const meta = Object.entries(value.metadata ?? {}).map(([k, v]) => `  ${k}: ${v}`).join('\n')
        return text([`key: ${value.key}`, `size: ${human(value.size ?? 0)} (${value.size} bytes)`, `content-type: ${value.contentType ?? '-'}`,
          `last-modified: ${value.lastModified ?? '-'}`, `etag: ${value.etag ?? '-'}`, `storage-class: ${value.storageClass ?? 'STANDARD'}`,
          meta !== '' ? `metadata:\n${meta}` : 'metadata: (none)'].join('\n'))
      },
    },
    async execute(args) {
      try {
        return { ok: true, ...(await engine.stat(args.profile, args.key)) }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

export function s3GetTool(engine: S3Engine) {
  return defineTool({
    name: 's3_get',
    description: `Read a TEXT object (config, log, CSV, JSON, HTML…) from a bucket and return its content. Bounded by maxBytes (default 200 KiB, cap ${MAX_TEXT_BYTES}); binary objects are rejected — use s3_download for those.`,
    parameters: {
      profile: PROFILE_PARAM,
      key: { type: 'string', required: true, description: 'Object key (relative to the profile prefix).' },
      maxBytes: { type: 'integer', description: 'Read at most this many bytes.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string' },
          size: { type: 'integer' },
          contentType: { type: 'string' },
          truncated: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; text?: string; size?: number; truncated?: boolean; error?: string }) => {
        if (!value.ok) return text(`read failed: ${value.error ?? 'unknown error'}`)
        const tail = value.truncated ? `\n[truncated: showing the first part of ${value.size ?? 0} bytes; raise maxBytes or s3_download the object]` : ''
        return text((value.text ?? '') + tail)
      },
    },
    async execute(args) {
      try {
        const result = await engine.getText(args.profile, args.key, args.maxBytes ?? 200 * 1024)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

export function s3PutTool(engine: S3Engine) {
  return defineTool({
    name: 's3_put',
    description: 'Write a text object (create or overwrite) with the given content. For files already on this machine use s3_upload instead. Overwrites silently — s3_stat first if the key may exist.',
    parameters: {
      profile: PROFILE_PARAM,
      key: { type: 'string', required: true, description: 'Destination key (relative to the profile prefix).' },
      content: { type: 'string', required: true, description: 'UTF-8 text content.' },
      contentType: { type: 'string', description: 'MIME type (default: guessed from the key extension).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, size: { type: 'integer' }, etag: { type: 'string' }, error: { type: 'string' } },
      },
      render: (args, value: { ok: boolean; size?: number; error?: string }) => text(value.ok
        ? `wrote ${args.key} (${value.size ?? 0} bytes)`
        : `write failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        return { ok: true, ...(await engine.put(args.profile, args.key, args.content, args.contentType)) }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

export function s3UploadTool(engine: S3Engine) {
  return defineTool({
    name: 's3_upload',
    description: 'Upload a file FROM this machine (the dsh host) to a bucket. Large files use multipart upload automatically.',
    parameters: {
      profile: PROFILE_PARAM,
      localPath: { type: 'string', required: true, description: 'Absolute path of the source file on THIS machine.' },
      key: { type: 'string', required: true, description: 'Destination key (relative to the profile prefix).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, size: { type: 'integer' }, error: { type: 'string' } },
      },
      render: (args, value: { ok: boolean; size?: number; error?: string }) => text(value.ok
        ? `uploaded ${args.localPath} → ${args.key} (${human(value.size ?? 0)})`
        : `upload failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        return { ok: true, ...(await engine.uploadFile(args.profile, args.localPath, args.key)) }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

export function s3DownloadTool(engine: S3Engine) {
  return defineTool({
    name: 's3_download',
    description: 'Download one object to a path on this machine (the dsh host); parent directories are created. Use this for binary objects or anything larger than s3_get allows.',
    parameters: {
      profile: PROFILE_PARAM,
      key: { type: 'string', required: true, description: 'Object key (relative to the profile prefix).' },
      localPath: { type: 'string', required: true, description: 'Absolute destination path on THIS machine.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, size: { type: 'integer' }, error: { type: 'string' } },
      },
      render: (args, value: { ok: boolean; size?: number; error?: string }) => text(value.ok
        ? `downloaded ${args.key} → ${args.localPath} (${human(value.size ?? 0)})`
        : `download failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        return { ok: true, ...(await engine.downloadFile(args.profile, args.key, args.localPath)) }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

export function s3DeleteTool(engine: S3Engine) {
  return defineTool({
    name: 's3_delete',
    description: 'PERMANENTLY delete objects. A key ending in "/" deletes everything under that prefix (recursive). Irreversible unless bucket versioning is on — list first, show the user exactly what will be deleted, and only call with confirm=true after they agree.',
    parameters: {
      profile: PROFILE_PARAM,
      keys: { type: 'array', required: true, items: { type: 'string' }, description: 'Object keys (or prefixes ending in "/") to delete, relative to the profile prefix.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true; set it only after the user explicitly confirmed this exact deletion.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          deleted: { type: 'integer' },
          errors: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string', required: true }, error: { type: 'string', required: true } } } },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; deleted?: number; errors?: { key: string; error: string }[]; error?: string }) => {
        if (!value.ok) return text(`delete failed: ${value.error ?? 'unknown error'}`)
        const lines = [`deleted ${value.deleted ?? 0} object(s)`]
        for (const e of value.errors ?? []) lines.push(`  failed: ${e.key} — ${e.error}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      if (args.confirm !== true) return { ok: false, error: 'refused: confirm must be true (ask the user first)' }
      try {
        return { ok: true, ...(await engine.delete(args.profile, args.keys)) }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

export function s3CopyTool(engine: S3Engine) {
  return defineTool({
    name: 's3_copy',
    description: 'Server-side copy (or move/rename with move=true) of one object inside the same bucket profile. Objects above 5 GiB are not supported.',
    parameters: {
      profile: PROFILE_PARAM,
      from: { type: 'string', required: true, description: 'Source key.' },
      to: { type: 'string', required: true, description: 'Destination key.' },
      move: { type: 'boolean', description: 'Delete the source after copying (rename).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } } },
      render: (args, value: { ok: boolean; error?: string }) => text(value.ok
        ? `${args.move === true ? 'moved' : 'copied'} ${args.from} → ${args.to}`
        : `copy failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        await engine.copy(args.profile, args.from, args.to, args.move === true)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

export function s3PresignTool(engine: S3Engine) {
  return defineTool({
    name: 's3_presign',
    description: 'Create a time-limited presigned URL for one object: GET to share a download link, PUT to let someone upload to that key. The URL is the only credential-free way to hand an object to a third party.',
    parameters: {
      profile: PROFILE_PARAM,
      key: { type: 'string', required: true, description: 'Object key.' },
      expiresIn: { type: 'integer', description: 'Validity in seconds (default 3600, max 604800).' },
      method: { type: 'string', enum: ['GET', 'PUT'], description: 'GET (default) or PUT.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, url: { type: 'string' }, expiresAt: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value: { ok: boolean; url?: string; expiresAt?: string; error?: string }) => text(value.ok
        ? `${value.url}\n(expires ${value.expiresAt})`
        : `presign failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        return { ok: true, ...(await engine.presign(args.profile, args.key, args.expiresIn ?? 3600, args.method === 'PUT' ? 'PUT' : 'GET')) }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

export function s3MkdirTool(engine: S3Engine) {
  return defineTool({
    name: 's3_mkdir',
    description: 'Create an empty "folder" marker (zero-byte object with a trailing slash) so the prefix shows up in listings before it has objects.',
    parameters: {
      profile: PROFILE_PARAM,
      key: { type: 'string', required: true, description: 'Folder key, e.g. "backups/2026/".' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, error: { type: 'string' } } },
      render: (args, value: { ok: boolean; error?: string }) => text(value.ok ? `created folder ${args.key}` : `mkdir failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        await engine.mkdir(args.profile, args.key)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: err(error) }
      }
    },
  })
}

/** Every tool, in registration order. */
export function allTools(store: ProfileStore, engine: S3Engine) {
  return [
    s3BucketsTool(store),
    s3ListTool(engine),
    s3StatTool(engine),
    s3GetTool(engine),
    s3PutTool(engine),
    s3UploadTool(engine),
    s3DownloadTool(engine),
    s3CopyTool(engine),
    s3PresignTool(engine),
    s3MkdirTool(engine),
    s3DeleteTool(engine),
  ]
}
