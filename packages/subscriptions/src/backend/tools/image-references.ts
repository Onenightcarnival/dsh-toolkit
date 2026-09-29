import { isAbsolute } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-query'

export interface NativeImageReferences {
  referenced_image_paths?: string[] | null
  num_last_images_to_include?: number | null
  referenceImages?: ImageAttachmentRef[]
}

/** One reference mode per edit; failed references never become a generation request. */
export async function resolveNativeImageReferences(args: NativeImageReferences, exec: ToolExecution): Promise<ImageAttachmentRef[] | undefined> {
  const paths = args.referenced_image_paths ?? undefined
  const count = args.num_last_images_to_include ?? undefined
  if ([paths, count, args.referenceImages].filter(value => value !== undefined).length > 1) {
    throw new Error('codex_image_generate: provide only one of referenced_image_paths, num_last_images_to_include or referenceImages')
  }
  if (paths !== undefined) {
    if (paths.length < 1 || paths.length > 5 || paths.some(path => !path.trim() || !isAbsolute(path))) {
      throw new Error('codex_image_generate: referenced_image_paths must contain 1–5 absolute file paths')
    }
    const agent = exec.agent
    if (!agent) throw new Error('codex_image_generate: file references require an agent filesystem context')
    const refs: ImageAttachmentRef[] = []
    for (const [index, path] of paths.entries()) {
      exec.signal.throwIfAborted()
      const result = await agent.ctx.tools.execute({
        name: 'read_image', arguments: { file_path: path }, agent, signal: exec.signal,
        callId: ToolCallId(`${exec.callId}:reference:${index}`),
        parent: exec.token, rootCallId: exec.rootCallId,
      })
      if (result.isError) throw new Error(`codex_image_generate: cannot read reference ${path}: ${result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')}`)
      const image = result.content.find(block => block.type === 'image')
      if (!image || image.type !== 'image') throw new Error(`codex_image_generate: read_image returned no image for ${path}`)
      refs.push(image.attachment)
    }
    return refs
  }
  if (count !== undefined) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 5) throw new Error('codex_image_generate: num_last_images_to_include must be between 1 and 5')
    const agent = exec.agent
    const query = agent?.ctx.get('sessionQuery')
    if (!agent || !query) throw new Error('codex_image_generate: recent images require the session query service')
    exec.signal.throwIfAborted()
    const surface = await query.readSurface(agent.session.id)
    exec.signal.throwIfAborted()
    const refs: ImageAttachmentRef[] = []
    for (const event of surface.events) {
      const content = event.type === 'user/message' ? event.data.content
        : event.type === 'assistant/message' ? event.data.message.content
        : event.type === 'tool/result' && !event.data.message.isError ? event.data.message.content : []
      for (const block of content) if (block.type === 'image') {
        const previous = refs.findIndex(ref => ref.attachmentId === block.attachment.attachmentId)
        if (previous !== -1) refs.splice(previous, 1)
        refs.push(block.attachment)
        if (refs.length > 5) refs.shift()
      }
    }
    if (refs.length < count) throw new Error(`codex_image_generate: requested ${count} recent images, but only ${refs.length} are available`)
    return refs.slice(-count)
  }
  return args.referenceImages
}
