/**
 * Image results for browser tools: decode the extension's base64 payload,
 * admit it against the current model route (image input must be declared),
 * store it through the attachment service, and build the content blocks the
 * tool's `finalizeContent` hands to the model. Mirrors the MCP client's image
 * projection so screenshots behave exactly like chrome-devtools-mcp images:
 * a refusal degrades to a text diagnostic, never to a failed tool call.
 *
 * @module @onenightcarnival/dsh-bridge-browser/src/tool-images
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Wire shape the extension attaches to a tool result. */
export interface ImagePayload {
  mediaType: string
  /** Base64 without a data-URL prefix. */
  data: string
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/**
 * Decode one payload into the attachment service's input shape.
 * @param payload - extension-provided media type and base64.
 * @returns bytes and validated media type.
 * @throws Error naming the first problem with the payload.
 */
export function decodeImagePayload(payload: ImagePayload): SaveImageAttachment {
  if (!IMAGE_MEDIA_TYPES.has(payload.mediaType)) {
    throw new Error(`unsupported image media type "${payload.mediaType}"`)
  }
  if (!CANONICAL_BASE64.test(payload.data)) throw new Error('image data is not canonical base64')
  const data = Buffer.from(payload.data, 'base64')
  if (data.byteLength === 0) throw new Error('image data is empty')
  return { data, mediaType: payload.mediaType as ImageMediaType, name: 'screenshot.png' }
}

interface ModelInfoLike {
  inputModalities?: readonly string[]
}

interface LlmLike {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfoLike>
}

interface AttachmentsLike {
  saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
}

/**
 * Resolve the attachment store after proving the calling Agent's current
 * model accepts image input.
 * @param ctx - plugin context.
 * @param exec - tool execution whose Agent supplies the model route.
 * @returns the attachment store.
 * @throws Error explaining why images cannot be delivered.
 */
export async function resolveImageAdmission(ctx: Context, exec: Pick<ToolRunContext, 'agent' | 'signal'>): Promise<AttachmentsLike> {
  const attachments = ctx.get('attachments') as AttachmentsLike | undefined
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  const agent = exec.agent as { session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }; options?: { provider?: string; model?: string } } | undefined
  const routed = agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? agent?.options?.provider
  const model = routed?.model ?? agent?.options?.model
  const llm = ctx.get('llm') as LlmLike | undefined
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  let info: ModelInfoLike
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    throw new Error('the current model route could not be verified')
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  if (exec.signal.aborted) throw new Error('the tool call was canceled before image storage')
  return attachments
}

/**
 * Build the model-facing content for a text + image tool result. When the
 * image cannot be admitted or stored, the reason is appended as text so the
 * model knows a picture existed and why it is missing.
 * @param ctx - plugin context.
 * @param exec - tool execution.
 * @param text - the tool's text result, always delivered.
 * @param payload - the image to attach.
 * @returns content blocks: text, then the image (or a diagnostic).
 */
export async function prepareImageProjection(
  ctx: Context,
  exec: Pick<ToolRunContext, 'agent' | 'signal'>,
  text: string,
  payload: ImagePayload,
): Promise<ContentBlock[]> {
  let decoded: SaveImageAttachment
  try {
    decoded = decodeImagePayload(payload)
  } catch (error: unknown) {
    return [{ type: 'text', text: `${text}\n[image unavailable: ${(error as Error).message}]` }]
  }
  let attachments: AttachmentsLike
  try {
    attachments = await resolveImageAdmission(ctx, exec)
  } catch (error: unknown) {
    return [{ type: 'text', text: `${text}\n[image unavailable: ${(error as Error).message}]` }]
  }
  try {
    const [ref] = await attachments.saveImages([decoded])
    if (ref === undefined) throw new Error('the attachment store returned no reference')
    return [{ type: 'text', text }, { type: 'image', attachment: ref }]
  } catch (error: unknown) {
    return [{ type: 'text', text: `${text}\n[image unavailable: durable image storage rejected it: ${(error as Error).message}]` }]
  }
}
