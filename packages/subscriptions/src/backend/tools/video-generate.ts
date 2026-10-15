/**
 * `grok_video_generate` tool: generate short videos through the Grok
 * subscription's Imagine video endpoint and save them as MP4 files under the
 * harness home. The xAI API is asynchronous: POST `/v1/videos/generations`
 * returns a `request_id`, GET `/v1/videos/{request_id}` is polled until the
 * status leaves `pending`, and the completed response carries a temporary MP4
 * URL that is downloaded at once. The result is the saved file path; the
 * client toolview plays the file through the `video` RPC endpoint.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GrokSession } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager } from '../providers/accounts.js'
import { httpLlmError } from '../providers/common.js'
import type { FetchFn } from '../providers/common.js'

/** Tool name owned by this plugin. */
export const VIDEO_GENERATE_TOOL_NAME = 'grok_video_generate'
/** Endpoint the generation request is posted to. */
export const VIDEO_GENERATE_URL = 'https://api.x.ai/v1/videos/generations'
/** The video model the Grok subscription endpoint serves. */
export const VIDEO_GENERATE_MODEL = 'grok-imagine-video-1.5'
/** Polling endpoint for one generation request. */
export function videoStatusUrl(requestId: string): string {
  return `https://api.x.ai/v1/videos/${encodeURIComponent(requestId)}`
}

/** Default delay between two status polls. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000
/** Default overall deadline for one generation (submit → done). */
export const DEFAULT_MAX_WAIT_MS = 10 * 60_000
/** xAI's supported clip length range in seconds. */
const DURATION_RANGE = { min: 1, max: 15 } as const

/** Dependencies of the `grok_video_generate` tool. */
export interface VideoGenerateToolOptions {
  /** Grok session source; a missing session throws the log-in hint. */
  tokens: AccountTokenManager<GrokSession>
  /** Fetch implementation (injectable for tests). */
  fetchFn?: FetchFn
  /** Directory override for saved videos (defaults under the harness home). */
  videosDir?: string
  /** Delay between status polls (injectable for tests). */
  pollIntervalMs?: number
  /** Overall deadline from submit to completion. */
  maxWaitMs?: number
  /** Creation-time policy; false rejects the call for that session. */
  enabled?: (createdAt: number | undefined) => boolean
}

/** Tool arguments as the schema admits them. */
export interface VideoGenerateArgs {
  prompt: string
  duration?: number
  aspect_ratio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '3:2' | '2:3'
  resolution?: '480p' | '720p' | '1080p'
  image_url?: string
}

/** The wire request body for one generation call. */
export interface VideoGenerateRequestBody {
  prompt: string
  model: string
  duration?: number
  aspect_ratio?: string
  resolution?: string
  image?: { url: string }
}

/**
 * Assemble the request body from tool arguments.
 * @param args - raw tool arguments.
 * @returns the JSON body.
 * @throws on an empty prompt or a duration outside 1–15 seconds.
 */
export function buildVideoGenerateBody(args: VideoGenerateArgs): VideoGenerateRequestBody {
  const prompt = args.prompt.trim()
  if (prompt.length === 0) throw new Error(`${VIDEO_GENERATE_TOOL_NAME}: prompt must be a non-empty string`)
  if (args.duration !== undefined
    && (!Number.isInteger(args.duration) || args.duration < DURATION_RANGE.min || args.duration > DURATION_RANGE.max)) {
    throw new Error(`${VIDEO_GENERATE_TOOL_NAME}: duration must be an integer between ${String(DURATION_RANGE.min)} and ${String(DURATION_RANGE.max)} seconds`)
  }
  const imageUrl = args.image_url?.trim()
  return {
    prompt,
    model: VIDEO_GENERATE_MODEL,
    ...args.duration === undefined ? {} : { duration: args.duration },
    ...args.aspect_ratio === undefined ? {} : { aspect_ratio: args.aspect_ratio },
    ...args.resolution === undefined ? {} : { resolution: args.resolution },
    ...imageUrl === undefined || imageUrl.length === 0 ? {} : { image: { url: imageUrl } },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extract the request id from the submit response.
 * @throws when the payload carries none.
 */
export function parseVideoStartResponse(payload: unknown): string {
  const body = isRecord(payload) ? payload : {}
  if (typeof body.request_id !== 'string' || body.request_id.length === 0) {
    throw new Error(`${VIDEO_GENERATE_TOOL_NAME}: the response carried no request_id`)
  }
  return body.request_id
}

/** One decoded poll response. */
export type VideoStatus =
  | { status: 'pending' }
  | { status: 'done'; url: string; duration?: number }
  | { status: 'failed' | 'expired'; detail?: string }

/**
 * Decode one poll response.
 * @throws on a `done` payload without a video URL and on an unknown status.
 */
export function parseVideoStatusResponse(payload: unknown): VideoStatus {
  const body = isRecord(payload) ? payload : {}
  switch (body.status) {
    case 'pending':
      return { status: 'pending' }
    case 'done': {
      const video = isRecord(body.video) ? body.video : {}
      if (typeof video.url !== 'string' || video.url.length === 0) {
        throw new Error(`${VIDEO_GENERATE_TOOL_NAME}: the completed response carried no video URL`)
      }
      return { status: 'done', url: video.url, ...typeof video.duration === 'number' ? { duration: video.duration } : {} }
    }
    case 'failed':
    case 'expired': {
      const error = isRecord(body.error) ? body.error : {}
      const detail = typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : typeof body.error === 'string' && body.error.length > 0 ? body.error : undefined
      return { status: body.status, ...detail === undefined ? {} : { detail } }
    }
    default:
      throw new Error(`${VIDEO_GENERATE_TOOL_NAME}: unexpected status ${JSON.stringify(body.status)}`)
  }
}

/** Directory the downloaded MP4 files are written to. */
export function videosDirectory(): string {
  return dshHomePath('plugins', 'subscriptions', 'videos')
}

/** Timestamped, collision-safe file name for one generated video. */
function videoFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `video-${stamp}-${Math.random().toString(36).slice(2, 8)}.mp4`
}

/** Bound a call-card title's prompt. */
function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Abort-aware sleep between two polls. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error(`${VIDEO_GENERATE_TOOL_NAME}: aborted`))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** The output value of one successful generation. */
export interface VideoGenerateValue {
  path: string
  url: string
  duration?: number
}

/**
 * Build the `grok_video_generate` tool definition.
 * @param options - Grok session source, fetch implementation, video directory and policy.
 * @returns the tool to register on `ctx.tools`.
 */
export function createVideoGenerateTool(options: VideoGenerateToolOptions): ToolDefinition {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  return defineTool({
    name: VIDEO_GENERATE_TOOL_NAME,
    description: `Generate a short video (1-15 seconds) with the Grok subscription (${VIDEO_GENERATE_MODEL}) `
      + 'and save it as an MP4 file. Generation is asynchronous and may take a minute or more; '
      + 'the tool waits for completion and returns the saved file path. '
      + 'Optionally animate a still image by passing image_url (image-to-video).',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the video should show.' },
      duration: { type: 'integer', description: 'Clip length in seconds (1-15); omit for the provider default.' },
      aspect_ratio: {
        type: 'string',
        enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
        description: 'Output aspect ratio; omit for the provider default (16:9).',
      },
      resolution: {
        type: 'string',
        enum: ['480p', '720p', '1080p'],
        description: 'Output resolution; omit for the provider default (480p). Higher is slower.',
      },
      image_url: {
        type: 'string',
        description: 'Optional public URL or base64 data URL of a JPEG/PNG/WebP image to animate (image-to-video); the image becomes the starting frame.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          url: { type: 'string', required: true },
          duration: { type: 'number' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved video to ${value.path}`
          + (value.duration === undefined ? '' : ` (${String(value.duration)}s)`)
          + `\nTemporary provider URL (expires soon): ${value.url}`,
      }],
      // The client toolview loads the bytes by bare file name through the `video` RPC endpoint.
      presentationMeta: (_args, value) => ({
        fileName: basename(value.path),
        ...value.duration === undefined ? {} : { duration: value.duration },
      }),
    },
    presentCall: args => ({ card: 'generic', title: `${VIDEO_GENERATE_TOOL_NAME}: ${truncate(args.prompt)}` }),
    timeoutMs: maxWaitMs + 60_000,
    async execute(args, exec) {
      if (options.enabled?.(exec.agent?.session.header?.createdAt) === false) {
        throw new Error(`${VIDEO_GENERATE_TOOL_NAME}: disabled for this session`)
      }
      const body = buildVideoGenerateBody(args)
      const session = await options.tokens.session()
      const fetchFn = options.fetchFn ?? proxiedFetch
      const headers = { 'authorization': `Bearer ${session.accessToken}`, 'accept': 'application/json' }
      const submit = await fetchFn(VIDEO_GENERATE_URL, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: exec.signal,
      })
      if (!submit.ok) throw await httpLlmError(submit, VIDEO_GENERATE_TOOL_NAME)
      const requestId = parseVideoStartResponse(await submit.json())

      const deadline = Date.now() + maxWaitMs
      let done: { url: string; duration?: number }
      for (;;) {
        await sleep(pollIntervalMs, exec.signal)
        const poll = await fetchFn(videoStatusUrl(requestId), { method: 'GET', headers, signal: exec.signal })
        if (!poll.ok) throw await httpLlmError(poll, VIDEO_GENERATE_TOOL_NAME)
        const status = parseVideoStatusResponse(await poll.json())
        if (status.status === 'done') { done = status; break }
        if (status.status === 'failed' || status.status === 'expired') {
          throw new Error(`${VIDEO_GENERATE_TOOL_NAME}: generation ${status.status} (request ${requestId})`
            + (status.detail === undefined ? '' : `: ${status.detail}`))
        }
        if (Date.now() >= deadline) {
          throw new Error(`${VIDEO_GENERATE_TOOL_NAME}: timed out after ${String(maxWaitMs)}ms waiting for request ${requestId}`)
        }
      }

      // The MP4 lives on a separate signed host; no auth header.
      const download = await fetchFn(done.url, { method: 'GET', signal: exec.signal })
      if (!download.ok) throw await httpLlmError(download, `${VIDEO_GENERATE_TOOL_NAME} download`)
      const data = Buffer.from(await download.arrayBuffer())
      const directory = options.videosDir ?? videosDirectory()
      await mkdir(directory, { recursive: true })
      const path = join(directory, videoFileName())
      await writeFile(path, data)
      const value: VideoGenerateValue = { path, url: done.url, ...done.duration === undefined ? {} : { duration: done.duration } }
      return value
    },
  })
}
