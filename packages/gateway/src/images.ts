/** Image inputs of requests: data URLs and remote URLs become host image attachments. */
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { GatewayError, invalid, type ImageResolver, type PendingImage } from './translate/common.ts'

/** The attachment store surface the resolver needs. */
export interface AttachmentsLike {
  saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
}

export const MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 15_000

function normalizeMediaType(value: string | undefined): ImageMediaType | undefined {
  const type = value?.split(';')[0].trim().toLowerCase()
  if (type === 'image/jpg') return 'image/jpeg'
  return MEDIA_TYPES.find(known => known === type)
}

/** Media type from the leading bytes, for responses without a usable content type. */
export function sniffMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

export interface ImageResolverOptions {
  attachments: () => AttachmentsLike | undefined
  fetchImpl?: typeof fetch
  maxBytes?: number
}

/** Build the resolver the request materializer calls once per image. */
export function createImageResolver(options: ImageResolverOptions): ImageResolver {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  const fetchImpl = options.fetchImpl ?? fetch
  return async (image: PendingImage): Promise<ImageAttachmentRef> => {
    const attachments = options.attachments()
    if (attachments === undefined) throw invalid('image input is unavailable: the host has no attachment store')
    let data: Uint8Array
    let mediaType: ImageMediaType | undefined
    if (image.source.kind === 'base64') {
      mediaType = normalizeMediaType(image.source.mediaType)
      if (mediaType === undefined) throw invalid(`unsupported image media type "${image.source.mediaType}"`)
      data = Buffer.from(image.source.data.replace(/\s+/g, ''), 'base64')
    } else {
      let url: URL
      try {
        url = new URL(image.source.url)
      } catch {
        throw invalid('image URL is not valid')
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('image URLs must use http or https')
      let response: Response
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' })
      } catch (error) {
        throw new GatewayError(400, 'invalid_request_error', `image URL could not be fetched: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) throw invalid(`image URL returned HTTP ${response.status}`)
      const length = Number(response.headers.get('content-length') ?? '0')
      if (length > maxBytes) throw invalid(`image exceeds ${maxBytes} bytes`)
      data = new Uint8Array(await response.arrayBuffer())
      mediaType = normalizeMediaType(response.headers.get('content-type') ?? undefined) ?? sniffMediaType(data)
      if (mediaType === undefined) throw invalid('image URL did not return a PNG, JPEG, WebP or GIF image')
    }
    if (data.byteLength === 0) throw invalid('image data is empty')
    if (data.byteLength > maxBytes) throw invalid(`image exceeds ${maxBytes} bytes`)
    try {
      const [ref] = await attachments.saveImages([{ data, mediaType }])
      if (ref === undefined) throw new Error('the attachment store returned no reference')
      return ref
    } catch (error) {
      throw invalid(`image rejected: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
