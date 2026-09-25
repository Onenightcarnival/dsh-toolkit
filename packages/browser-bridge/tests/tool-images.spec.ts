import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { decodeImagePayload, prepareImageProjection } from '../src/tool-images.ts'

// 1×1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function contextWith(services: Record<string, unknown>): Context {
  return { get: (key: string) => services[key] } as unknown as Context
}

const exec = {
  agent: { options: { provider: 'deepseek-official', model: 'deepseek-v4' } },
  signal: new AbortController().signal,
}

describe('decodeImagePayload', () => {
  it('accepts canonical PNG base64 and rejects other shapes', () => {
    expect(decodeImagePayload({ mediaType: 'image/png', data: PNG }).mediaType).toBe('image/png')
    expect(() => decodeImagePayload({ mediaType: 'image/svg+xml', data: PNG })).toThrow(/media type/)
    expect(() => decodeImagePayload({ mediaType: 'image/png', data: 'not base64!' })).toThrow(/base64/)
    expect(() => decodeImagePayload({ mediaType: 'image/png', data: '' })).toThrow()
  })
})

describe('prepareImageProjection', () => {
  it('stores the image and returns text + image blocks when the model accepts images', async () => {
    const saveImages = vi.fn(async () => [{ id: 'att-1' }])
    const ctx = contextWith({
      attachments: { saveImages },
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    })
    const content = await prepareImageProjection(ctx, exec, 'Screenshot of x', { mediaType: 'image/png', data: PNG })
    expect(content).toEqual([{ type: 'text', text: 'Screenshot of x' }, { type: 'image', attachment: { id: 'att-1' } }])
    expect(saveImages).toHaveBeenCalledTimes(1)
    expect(saveImages.mock.calls[0]?.[0]?.[0]).toMatchObject({ mediaType: 'image/png', name: 'screenshot.png' })
  })

  it('degrades to a text diagnostic when the route has no image input or storage fails', async () => {
    const textOnly = contextWith({
      attachments: { saveImages: vi.fn() },
      llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
    })
    const refused = await prepareImageProjection(textOnly, exec, 'Shot', { mediaType: 'image/png', data: PNG })
    expect(refused).toEqual([{ type: 'text', text: expect.stringContaining('does not declare image input') }])

    const noStore = contextWith({ llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) } })
    const missing = await prepareImageProjection(noStore, exec, 'Shot', { mediaType: 'image/png', data: PNG })
    expect(missing[0]).toMatchObject({ type: 'text', text: expect.stringContaining('no attachment store') })

    const failing = contextWith({
      attachments: { saveImages: async () => { throw new Error('disk full') } },
      llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
    })
    const broken = await prepareImageProjection(failing, exec, 'Shot', { mediaType: 'image/png', data: PNG })
    expect(broken[0]).toMatchObject({ type: 'text', text: expect.stringContaining('disk full') })
  })
})
