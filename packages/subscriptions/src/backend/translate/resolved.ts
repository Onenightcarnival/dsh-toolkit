/**
 * Resolved-image plumbing for the wire translators. Adapters resolve image
 * attachment references to inline base64 before translation; translators
 * receive {@link ResolvedImagePart}s.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '../compat.js'

/** Legacy nested results are retained only inside the wire translation layer. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: readonly (ContentBlock | ToolResultBlock)[]
  isError?: boolean
}

export interface UnresolvedMessage extends Omit<TranslatableMessage, 'content'> {
  content: readonly (ContentBlock | ToolResultBlock)[]
}

/** Project the harness's first-class tool messages onto user messages carrying one tool-result block. */
export function projectToolMessages(messages: readonly RequestMessage[]): UnresolvedMessage[] {
  return messages.map((message) => {
    if (String(message.role) !== 'tool') return message
    const current = message as Message & { toolCallId?: string; isError?: boolean }
    const callId = current.toolCallId
      ?? (current.source.kind === 'tool' ? String(current.source.callId) : undefined)
    if (callId === undefined) throw new LlmError('tool result has no call id', 'INVALID_REQUEST')
    return {
      role: 'user',
      source: { kind: 'tool', callId: ToolCallId(callId) },
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(callId),
        content: [...message.content],
        ...current.isError === undefined ? {} : { isError: current.isError },
      }],
    }
  })
}

/** An image block with its bytes resolved to inline base64 for the wire. */
export interface ResolvedImagePart {
  type: 'image'
  /** MIME type verified by the attachment service (e.g. `image/png`). */
  mediaType: string
  /** Base64-encoded image bytes. */
  dataBase64: string
}

/** Translator input block: a harness block, with images pre-resolved. */
export type TranslatableBlock = Exclude<ContentBlock, ToolResultBlock> | ResolvedImagePart | ResolvedToolResultBlock

/** Tool results may themselves carry attachment-backed images. */
export interface ResolvedToolResultBlock extends Omit<ToolResultBlock, 'content'> {
  content: readonly TranslatableBlock[]
}

/**
 * Wires with text-only tool outputs receive tool-result images in a following
 * user turn, emitted after the run of consecutive tool and user messages and
 * before the next assistant message.
 */
export function withToolResultImages(messages: readonly TranslatableMessage[]): TranslatableMessage[] {
  const out: TranslatableMessage[] = []
  let images: TranslatableBlock[] = []
  const flush = (): void => {
    if (images.length > 0) out.push({ role: 'user', content: images })
    images = []
  }
  for (const message of messages) {
    if (message.role === 'assistant') flush()
    out.push(message)
    if (message.role === 'tool') {
      const parts = message.content.filter((part): part is ResolvedImagePart => part.type === 'image' && 'dataBase64' in part)
      if (parts.length > 0) {
        images.push({ type: 'text', text: `Images from tool result ${String(message.toolCallId)}:` }, ...parts)
      }
    }
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      const parts = block.content.filter((part): part is ResolvedImagePart => part.type === 'image' && 'dataBase64' in part)
      if (parts.length > 0) {
        images.push({ type: 'text', text: `Images from tool result ${String(block.toolCallId)}:` }, ...parts)
      }
    }
  }
  flush()
  return out
}

/** Translator input message: role plus resolved blocks. */
export interface TranslatableMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: readonly TranslatableBlock[]
  /** First-class tool result correlation in current harness messages. */
  toolCallId?: string
  /** Chat Completions correlation in imported histories. */
  tool_call_id?: string
  isError?: boolean
  /** Preserved for adapters whose provider-private replay metadata is required. */
  source?: Message['source']
}

/**
 * Resolve image attachment references to inline base64 bytes.
 * Messages without images pass through unchanged; image requests require an
 * attachment service and fail when it is unavailable.
 * @param messages - the request's conversation messages.
 * @param attachments - the deployment's attachment service, when mounted.
 * @param signal - cancellation for the storage reads.
 * @returns the same messages with image blocks resolved for the translators.
 */
export async function resolveImages(
  messages: readonly UnresolvedMessage[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly TranslatableMessage[]> {
  const hasImage = (block: ContentBlock | ToolResultBlock): boolean => block.type === 'image'
    || (block.type === 'tool-result' && block.content.some(hasImage))
  if (!messages.some(message => message.content.some(hasImage))) {
    return messages
  }
  if (attachments === undefined) {
    throw new LlmError(
      'dsh-plugin-subscriptions: the request carries an image but no attachments service is mounted; '
      + 'image input requires the harness attachment store',
      'UNSUPPORTED_CONTENT',
    )
  }
  const resolveBlock = async (block: ContentBlock | ToolResultBlock): Promise<TranslatableBlock[]> => {
    if (block.type === 'tool-result') {
      return [{ ...block, content: (await Promise.all(block.content.map(resolveBlock))).flat() }]
    }
    if (block.type !== 'image') return [block]
    const stored = await attachments.readImage(block.attachment, signal)
    return [{
      type: 'image',
      mediaType: stored.ref.mediaType,
      dataBase64: Buffer.from(stored.data).toString('base64'),
    }]
  }
  return Promise.all(messages.map(async (message): Promise<TranslatableMessage> => ({
    ...message,
    content: (await Promise.all(message.content.map(resolveBlock))).flat(),
  })))
}
