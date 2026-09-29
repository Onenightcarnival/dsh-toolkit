/**
 * `codex_image_generate` tool: generate images through a subscription image
 * endpoint, save them under the harness home, and — when the deployment
 * mounts an attachment store and the calling route declares image input —
 * also commit the bytes as durable attachments so the images render inline
 * and enter model context (the same path `read_image` uses).
 *
 * Uses the ChatGPT/Codex image endpoint with subscription account credentials.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { CodexSession } from '../auth/store.js'
import { AccountTokenManager } from '../providers/accounts.js'
import { ImageAccountPool } from '../providers/image-pool.js'
import { codexRateLimitReset } from '../providers/codex.js'
import type { FetchFn } from '../providers/common.js'
import { proxiedFetch } from '../http.js'

/** Endpoint the codex generation request is posted to. */
export const IMAGE_GENERATE_URL = 'https://chatgpt.com/backend-api/codex/images/generations'
export const IMAGE_EDIT_URL = 'https://chatgpt.com/backend-api/codex/images/edits'
/** The image model the codex subscription endpoint serves. */
export const IMAGE_GENERATE_MODEL = 'gpt-image-2'
/** Dependencies of the `codex_image_generate` tool. */
export interface ImageGenerateToolOptions {
  antigravity?: { generate: (args: ImageGenerateArgs, references: string[] | undefined, signal: AbortSignal) => Promise<GeneratedImage[]> }
  /** Shared generation/edit account scheduling; standalone tools get a private pool. */
  imagePool?: ImageAccountPool
  /** Creation-time provider policy; existing sessions retain their original tools. */
  providerEnabled?: (provider: 'codex' | 'antigravity', createdAt: number | undefined) => boolean
  /** Codex session source; used for generation and editing. */
  codexTokens?: AccountTokenManager<CodexSession>
  /** Fetch implementation (injectable for tests). */
  fetchFn?: FetchFn
  /** Directory override for saved images (defaults under the harness home). */
  imagesDir?: string
  /** Lazy attachment-store lookup; absent or unmounted store keeps the text-only result. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Lazy llm-service lookup for the image-capability route check. */
  resolveLlm?: () => LlmRuntime | undefined
}

/** The wire request body for one generation call. */
export interface ImageGenerateRequestBody {
  prompt: string
  model: string
  size?: string
  quality?: string
}

/** The tool's own argument shape, used by the ChatGPT request builder. */
export interface ImageGenerateArgs {
  reasoningEffort?: 'minimal' | 'high'
  prompt: string
  size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto'
  quality?: 'low' | 'medium' | 'high' | 'auto'
  /** Ordered durable references; omission generates, presence edits. */
  referenceImages?: ImageGenerateImageValue[]
}

/** Resolve references before any upstream request; never silently generate on invalid edits. */
async function resolveReferenceImages(
  refs: ImageGenerateImageValue[] | undefined,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
  toolName = 'codex_image_generate',
): Promise<string[] | undefined> {
  if (refs === undefined) return undefined
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 5) {
    throw new Error(`${toolName}: referenceImages must contain 1–5 complete image references; omit only for a new image`)
  }
  if (attachments === undefined) throw new Error(`${toolName}: editing requires the DSH attachment service`)
  const seen = new Set<string>()
  let totalBytes = 0
  const urls: string[] = []
  for (const ref of refs) {
    signal.throwIfAborted()
    if (ref === null || typeof ref !== 'object'
      || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
      || ![ref.bytes, ref.width, ref.height].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error(`${toolName}: invalid referenceImages entry; copy a complete image reference or call read_image for a local file. Do not omit references to retry an edit.`)
    }
    if (seen.has(ref.attachmentId)) throw new Error(`${toolName}: referenceImages contains duplicate images`)
    seen.add(ref.attachmentId)
    if (refs.length > attachments.imageLimits.maxImagesPerMessage
      || ref.bytes > attachments.imageLimits.maxImageBytes
      || totalBytes + ref.bytes > attachments.imageLimits.maxMessageImageBytes) {
      throw new Error(`${toolName}: referenceImages exceed DSH image limits`)
    }
    const stored = await attachments.readImage(imageRefFromValue(ref), signal)
    totalBytes += stored.data.byteLength
    if (totalBytes > attachments.imageLimits.maxMessageImageBytes) {
      throw new Error(`${toolName}: referenceImages exceed DSH image limits`)
    }
    urls.push(`data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`)
  }
  return urls
}

/**
 * Assemble the codex request body from tool arguments (hand-checks the
 * non-empty prompt the schema DSL cannot express).
 */
export function buildImageGenerateBody(args: ImageGenerateArgs): ImageGenerateRequestBody {
  const prompt = args.prompt.trim()
  if (prompt.length === 0) throw new Error('codex_image_generate: prompt must be a non-empty string')
  return {
    prompt,
    model: IMAGE_GENERATE_MODEL,
    ...args.size === undefined ? {} : { size: args.size },
    ...args.quality === undefined ? {} : { quality: args.quality },
  }
}

/** One generated image decoded from the response. */
export interface GeneratedImage {
  /** PNG bytes. */
  data: Buffer
  /** Provider-revised prompt, when the response carries one. */
  revisedPrompt?: string
}

/**
 * Parse the generations response into decodable images. Throws when the
 * payload carries no usable `b64_json` entries.
 */
export function parseImageGenerateResponse(payload: unknown): GeneratedImage[] {
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const entries = Array.isArray(body.data) ? body.data : []
  const images: GeneratedImage[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.b64_json !== 'string' || record.b64_json.length === 0) continue
    images.push({
      data: Buffer.from(record.b64_json, 'base64'),
      ...typeof record.revised_prompt === 'string' && record.revised_prompt.length > 0
        ? { revisedPrompt: record.revised_prompt }
        : {},
    })
  }
  if (images.length === 0) throw new Error('codex_image_generate: the response carried no image data')
  return images
}

/** Directory the generated image files are written to. */
export function imagesDirectory(): string {
  return dshHomePath('plugins', 'subscriptions', 'images')
}

/** Media types the attachment store accepts and this tool can produce. */
export type GeneratedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

/**
 * Sniff a generated image's media type from its magic bytes (codex serves
 * PNG; verify the returned bytes). Unrecognized data
 * defaults to PNG, matching the historical behavior.
 */
export function sniffImageMediaType(data: Buffer): GeneratedImageMediaType {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return 'image/png'
}

/** File extension for one sniffed media type. */
const MEDIA_TYPE_EXTENSIONS: Record<GeneratedImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Timestamped, collision-safe file name for one generated image. */
function imageFileName(index: number, mediaType: GeneratedImageMediaType): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `image-${stamp}-${Math.random().toString(36).slice(2, 8)}-${index}.${MEDIA_TYPE_EXTENSIONS[mediaType]}`
}

/** Bound a call-card title's prompt. */
function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Non-throwing image-capability check for the calling route (read_image's
 * gate, softened: a generated image that cannot enter history degrades to the
 * text-only result instead of failing the call). Resolves the session's
 * latest routed provider/model and answers whether the exact route declares
 * image input; any resolution failure means "no".
 */
async function routeDeclaresImageInput(
  resolveLlm: (() => LlmRuntime | undefined) | undefined,
  exec: ToolExecution,
): Promise<boolean> {
  const llm = resolveLlm?.()
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (llm === undefined || provider === undefined || model === undefined) return false
  try {
    const active = await llm.resolveModelInfo(provider, model, exec.signal)
    return active.inputModalities?.includes('image') === true
  } catch {
    // An unresolvable route cannot be proven image-capable: degrade to text.
    return false
  }
}

/** Canonical image metadata as the output schema declares it. */
interface ImageGenerateImageValue {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

/** The canonical output value of one successful generation. */
interface ImageGenerateValue {
  paths: string[]
  images?: ImageGenerateImageValue[]
  revisedPrompt?: string
}

/** Re-brand one canonical image entry into the attachment reference an ImageBlock carries. */
function imageRefFromValue(image: ImageGenerateImageValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : { originalDimensions: image.originalDimensions },
  }
}

/** Project the canonical value into the model-facing text + image blocks. */
function imageGenerateContent(value: ImageGenerateValue, toolName = 'codex_image_generate'): ContentBlock[] {
  return [
    imageGenerateText(value, toolName),
    ...(value.images ?? []).map(image => ({ type: 'image' as const, attachment: imageRefFromValue(image) })),
  ]
}

/** The text summary of one generation, shared by the model content and the UI card. */
function imageGenerateText(value: ImageGenerateValue, toolName: string): ContentBlock {
  const text = `Saved ${value.paths.length} image(s):\n${value.paths.map(path => `- ${path}`).join('\n')}`
    + (value.images?.length ? `\n\nImage references (for ${toolName}.referenceImages): ${JSON.stringify(value.images)}` : '')
    + (value.revisedPrompt === undefined ? '' : `\n\nRevised prompt: ${value.revisedPrompt}`)
  return { type: 'text', text }
}

export function createImageGenerateTool(options: ImageGenerateToolOptions): ToolDefinition {
  const provider = options.antigravity ? 'antigravity' : 'codex'
  const toolName = `${provider}_image_generate`
  const imagePool = options.imagePool ?? new ImageAccountPool()
  return defineTool({
    name: toolName,
    description: options.antigravity
      ? 'Generate or edit images through the Google Antigravity subscription using Gemini 3.1 Flash Image. Returns local paths and image attachments. For edits, pass complete referenceImages from read_image or prior image tool results. Never omit failed references to substitute a new image.'
      : 'Generate or edit images with the ChatGPT subscription (gpt-image-2) and save them locally. '
      + 'Image requests use available ChatGPT accounts; quota or authentication rejection can switch accounts. '
      + 'Returns the saved file paths; on image-capable models the image itself is attached. '
      + 'To edit or use existing images as references, pass referenceImages copied from the image reference text '
      + 'or structured tool results (read_image.image or codex_image_generate.images). Select only the images the user '
      + 'intends, in prompt order. For local files, call read_image first. Omit referenceImages only for a new image. '
      + 'If an edit reference fails, fix it and retry; never omit it to substitute text-to-image generation.',
    parameters: {
      referenceImages: {
        type: 'array',
        description: 'Optional 1–5 ordered complete DSH image references to edit or use as source images. Not file paths or URLs. Omit only for new images.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            attachmentId: { type: 'string', required: true },
            mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
            bytes: { type: 'integer', required: true },
            width: { type: 'integer', required: true },
            height: { type: 'integer', required: true },
            name: { type: 'string' },
            originalDimensions: {
              type: 'object',
              additionalProperties: false,
              properties: {
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      prompt: { type: 'string', required: true, description: 'What the image should show.' },
      ...(options.antigravity ? {
        reasoningEffort: { type: 'string' as const, enum: ['minimal', 'high'], description: 'Image reasoning effort; omit to use the configured model default.' },
      } : {
        size: {
          type: 'string',
          enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
          description: 'Image dimensions; omit for the provider default.',
        },
        quality: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'auto'],
          description: 'Rendering quality; omit for the provider default.',
        },
      }),
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, required: true },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                name: { type: 'string' },
              },
            },
          },
          revisedPrompt: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => imageGenerateContent(value, toolName),
    },
    presentCall: args => ({
      card: 'generic',
      title: `${toolName}${args.referenceImages === undefined ? '' : ` (edit, ${args.referenceImages.length} images)`}: ${truncate(args.prompt)}`,
    }),
    presentResult: (_args, result) => ({
      card: 'generic' as const,
      content: result.content.filter(block => block.type === 'text'),
    }),
    timeoutMs: options.antigravity ? 180_000 : undefined,
    async execute(args, exec) {
      const fetchFn = options.fetchFn ?? proxiedFetch
      // Validate the prompt even when references cannot be resolved.
      if (!args.prompt.trim()) throw new Error(`${toolName}: prompt must not be empty`)
      const references = await resolveReferenceImages(args.referenceImages, options.resolveAttachments?.(), exec.signal, toolName)
      const createdAt = exec.agent?.session.header?.createdAt
      if (options.providerEnabled?.(provider, createdAt) === false) throw new Error(`${toolName}: disabled for this session`)
      let images: GeneratedImage[]
      if (options.antigravity) {
        images = await options.antigravity.generate(args as ImageGenerateArgs, references, exec.signal)
      } else {
        if (options.codexTokens === undefined) throw new Error('codex_image_generate: ChatGPT is not configured')
        const response = await imagePool.request({
          provider: 'codex', tokens: options.codexTokens, signal: exec.signal,
          owner: exec.agent?.session, rateLimitReset: codexRateLimitReset,
          send: session => fetchFn(references === undefined ? IMAGE_GENERATE_URL : IMAGE_EDIT_URL, {
            method: 'POST',
            headers: {
              'authorization': `Bearer ${session.accessToken}`,
              'chatgpt-account-id': session.accountId,
              'originator': 'codex_cli_rs',
              'content-type': 'application/json',
              'accept': 'application/json',
            },
            body: JSON.stringify({
              ...buildImageGenerateBody(args),
              ...references === undefined ? {} : { images: references.map(image_url => ({ image_url })) },
            }),
            signal: exec.signal,
          }),
        })
        images = parseImageGenerateResponse(await response.json())
      }
      const directory = options.imagesDir ?? imagesDirectory()
      await mkdir(directory, { recursive: true })
      const paths: string[] = []
      const mediaTypes: GeneratedImageMediaType[] = []
      for (const [index, image] of images.entries()) {
        const mediaType = sniffImageMediaType(image.data)
        const path = join(directory, imageFileName(index, mediaType))
        await writeFile(path, image.data)
        paths.push(path)
        mediaTypes.push(mediaType)
      }

      // Inline display requires durable attachment references, and those may
      // only enter session history on a route that declares image input.
      // Either condition failing degrades to the text-only result.
      const attachments = options.resolveAttachments?.()
      const imageCapable = attachments !== undefined
        && await routeDeclaresImageInput(options.resolveLlm, exec)
      const refs: ImageGenerateImageValue[] = []
      if (attachments !== undefined && imageCapable) {
        for (const [index, image] of images.entries()) {
          const ref = await attachments.saveImage({
            data: image.data,
            mediaType: mediaTypes[index],
            name: basename(paths[index]),
          })
          refs.push({
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...ref.name === undefined ? {} : { name: ref.name },
          })
        }
      }

      const revisedPrompt = images.find(image => image.revisedPrompt !== undefined)?.revisedPrompt
      const value: ImageGenerateValue = {
        paths,
        ...refs.length > 0 ? { images: refs } : {},
        ...revisedPrompt === undefined ? {} : { revisedPrompt },
      }
      // Nested (Code Mode) dispatches need no defer here: the harness's code
      // mode already defers any image-bearing sub-result as a user message, so
      // deferring again would inject the same attachment twice.
      return value
    },
  })
}
