/**
 * Viewport screenshots with optional set-of-marks annotation.
 *
 * `chrome.tabs.captureVisibleTab` photographs whatever the window currently
 * shows, so it is only meaningful when the controlled tab is the active tab
 * of a visible window; the caller checks that before calling here. The
 * annotation pass draws each inventoried element's index next to its box so
 * a multimodal model can name a target from the picture alone. Drawing runs
 * on an OffscreenCanvas because a service worker has no DOM.
 *
 * @module
 */

/** One element box in CSS pixels of the viewport, with its inventory index. */
export interface AnnotationRect {
  index: number
  x: number
  y: number
  width: number
  height: number
}

/** Viewport geometry reported by the content script alongside the rects. */
export interface AnnotationViewport {
  width: number
  height: number
  dpr: number
}

/** Longest edge of the delivered image; larger captures are downscaled. */
export const MAX_SCREENSHOT_EDGE = 1600

/** Cap on labels drawn; a page with more inventoried boxes keeps the first N by index order. */
export const MAX_ANNOTATIONS = 200

export interface ScreenshotImage {
  mediaType: 'image/png' | 'image/jpeg'
  /** Canonical base64 without a data-URL prefix. */
  data: string
  width: number
  height: number
}

/** Decode a `data:image/...;base64,` URL into its media type and payload. */
export function splitDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (match === null) throw new Error('captureVisibleTab returned an unexpected data URL')
  return { mediaType: match[1] as string, base64: match[2] as string }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** Label color per index so adjacent labels stay distinguishable. */
function labelColor(index: number): string {
  const palette = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f']
  return palette[index % palette.length] as string
}

/**
 * Draw index labels on a captured viewport and re-encode it, downscaling to
 * {@link MAX_SCREENSHOT_EDGE}. Without rects the capture is only rescaled.
 * @param dataUrl - `captureVisibleTab` output (device pixels).
 * @param rects - element boxes in CSS pixels, or an empty list.
 * @param viewport - CSS viewport size and device pixel ratio.
 * @returns the PNG to deliver and the count of labels drawn.
 */
export async function annotateScreenshot(
  dataUrl: string,
  rects: readonly AnnotationRect[],
  viewport: AnnotationViewport,
): Promise<{ image: ScreenshotImage; labels: number }> {
  const { base64, mediaType } = splitDataUrl(dataUrl)
  const source = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([source], { type: mediaType }))
  try {
    const scale = Math.min(1, MAX_SCREENSHOT_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    if (rects.length === 0 && scale === 1) {
      return { image: { mediaType: mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png', data: base64, width, height }, labels: 0 }
    }
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('OffscreenCanvas 2d context unavailable')
    ctx.drawImage(bitmap, 0, 0, width, height)
    // Capture pixels are CSS pixels × dpr; the canvas is that × scale.
    const factor = viewport.dpr * scale
    const fontSize = Math.max(11, Math.round(13 * scale * viewport.dpr))
    ctx.font = `bold ${fontSize}px system-ui, sans-serif`
    ctx.textBaseline = 'top'
    ctx.lineWidth = Math.max(1, Math.round(1.5 * factor))
    let labels = 0
    for (const rect of [...rects].sort((a, b) => a.index - b.index).slice(0, MAX_ANNOTATIONS)) {
      const x = rect.x * factor
      const y = rect.y * factor
      const w = rect.width * factor
      const h = rect.height * factor
      if (x > width || y > height || x + w < 0 || y + h < 0) continue
      const color = labelColor(rect.index)
      ctx.strokeStyle = color
      ctx.strokeRect(x, y, w, h)
      const text = String(rect.index)
      const padding = Math.round(2 * factor)
      const textWidth = ctx.measureText(text).width
      const boxWidth = textWidth + padding * 2
      const boxHeight = fontSize + padding * 2
      // Put the label just above the box when there is room, else inside its top-left corner.
      const labelX = Math.min(Math.max(0, x), width - boxWidth)
      const labelY = y - boxHeight >= 0 ? y - boxHeight : Math.max(0, y)
      ctx.fillStyle = color
      ctx.fillRect(labelX, labelY, boxWidth, boxHeight)
      ctx.fillStyle = '#ffffff'
      ctx.fillText(text, labelX + padding, labelY + padding)
      labels += 1
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return { image: { mediaType: 'image/png', data: bytesToBase64(bytes), width, height }, labels }
  } finally {
    bitmap.close()
  }
}

/** Parse the content script's `browser_element_rects` payload defensively. */
export function parseAnnotationPayload(text: string): { rects: AnnotationRect[]; viewport: AnnotationViewport; url: string; title: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const value = parsed as { rects?: unknown; viewport?: unknown; url?: unknown; title?: unknown }
  const viewport = value.viewport as Partial<AnnotationViewport> | undefined
  if (typeof viewport?.width !== 'number' || typeof viewport.height !== 'number') return null
  const rects: AnnotationRect[] = []
  if (Array.isArray(value.rects)) {
    for (const rect of value.rects) {
      const candidate = rect as Partial<AnnotationRect>
      if (typeof candidate.index !== 'number' || typeof candidate.x !== 'number' || typeof candidate.y !== 'number'
        || typeof candidate.width !== 'number' || typeof candidate.height !== 'number') continue
      rects.push({ index: candidate.index, x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height })
    }
  }
  return {
    rects,
    viewport: { width: viewport.width, height: viewport.height, dpr: typeof viewport.dpr === 'number' && viewport.dpr > 0 ? viewport.dpr : 1 },
    url: typeof value.url === 'string' ? value.url : '',
    title: typeof value.title === 'string' ? value.title : '',
  }
}
