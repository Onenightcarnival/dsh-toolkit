/**
 * Wire contract shared by the host half (routes/tools) and the browser half
 * (panel). Keep this file dependency-free: the client bundle imports it.
 */

/** Route family paths (exact). */
export const S3_API = {
  profiles: '/api/dsh-s3/profiles',
  settings: '/api/dsh-s3/settings',
  test: '/api/dsh-s3/test',
  list: '/api/dsh-s3/list',
  object: '/api/dsh-s3/object',
  text: '/api/dsh-s3/text',
  upload: '/api/dsh-s3/upload',
  delete: '/api/dsh-s3/delete',
  folder: '/api/dsh-s3/folder',
  presign: '/api/dsh-s3/presign',
  copy: '/api/dsh-s3/copy',
  stat: '/api/dsh-s3/stat',
} as const

/** One bucket connection as stored on disk (secret included). */
export interface S3Profile {
  /** Stable id (random, never shown as the primary label). */
  id: string
  /** Display name; also what the agent tools address (unique). */
  name: string
  bucket: string
  /** Service endpoint URL; empty means AWS S3 (region-derived). */
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Path-style addressing (MinIO / most self-hosted); false = virtual-hosted. */
  pathStyle: boolean
  /** Optional key prefix the browser and tools stay under ('' = whole bucket). */
  prefix: string
  createdAt: number
  updatedAt: number
}

/** Secret-free projection for the browser and the agent. */
export interface S3ProfileSummary {
  id: string
  name: string
  bucket: string
  endpoint: string
  region: string
  /** Masked access key (first 4 chars) so the user can tell keys apart. */
  accessKeyHint: string
  pathStyle: boolean
  prefix: string
  createdAt: number
  updatedAt: number
}

/** Create/update payload from the browser (secret optional on update). */
export interface S3ProfilePayload {
  name?: string
  bucket?: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  pathStyle?: boolean
  prefix?: string
}

/** Plugin-level switches stored next to the profiles. */
export interface S3Settings {
  /** Register the s3_* agent tools (and the system-prompt notice). */
  agentTools: boolean
}

/** One listed object. */
export interface S3ObjectEntry {
  key: string
  size: number
  /** ISO timestamp. */
  lastModified: string
  etag?: string
  storageClass?: string
}

/** One delimiter listing page. */
export interface S3ListPage {
  prefix: string
  folders: string[]
  objects: S3ObjectEntry[]
  nextToken?: string
  truncated: boolean
}

/** HEAD result. */
export interface S3StatResult {
  key: string
  size: number
  contentType?: string
  lastModified?: string
  etag?: string
  storageClass?: string
  metadata: Record<string, string>
}

/** Connection test outcome. */
export interface S3TestResult {
  ok: boolean
  latencyMs: number
  error?: string
  /** First few keys seen (proves list permission). */
  sample?: string[]
}
