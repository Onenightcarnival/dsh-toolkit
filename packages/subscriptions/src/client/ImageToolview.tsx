import { useEffect, useState } from 'react'
import type { SubscriptionsApi } from './api.ts'
import { tt } from './locales.ts'

export interface Props {
  provider?: 'codex' | 'antigravity'
  api: SubscriptionsApi
  block?: {
    kind?: string
    argsRaw?: string
    call?: { argsRaw?: string }
    isError?: boolean
    content?: { type: string; text?: string; attachment?: Record<string, unknown> }[]
    error?: { name: string; code: string }
  }
}

function Image({ api, attachment }: { api: SubscriptionsApi; attachment: Record<string, unknown> }): JSX.Element {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const key = JSON.stringify(attachment)
  useEffect(() => {
    let cancelled = false
    setUrl(''); setError('')
    void api.call<{ mediaType: string; dataBase64: string }>('image', JSON.parse(key)).then(result => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(result.mediaType)) throw new Error('Unsupported image type')
      if (!cancelled) setUrl(`data:${result.mediaType};base64,${result.dataBase64}`)
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [api, key])
  return url ? <a href={url} download="subscription-image" title={tt('imagePreview')}><img src={url} alt={tt('imagePreview')} /></a> : <p role={error ? 'alert' : 'status'}>{error || tt('imageLoading')}</p>
}

export function ImageToolview({ api, block, provider }: Props): JSX.Element | null {
  if (!block) return null
  const settled = block.kind !== undefined
  const raw = block.call?.argsRaw ?? block.argsRaw ?? ''
  let prompt = raw
  try { prompt = (JSON.parse(raw) as { prompt?: string }).prompt ?? raw } catch { /* streaming */ }
  const text = block.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? ''
  const images = block.content?.filter(p => p.type === 'image' && p.attachment) ?? []
  return <div className="dsh-sub-imageResult">
    <strong>{tt(provider === 'antigravity' ? 'googleImageTitle' : 'imageTitle')}</strong><p>{prompt}</p>
    {!settled && <p role="status">{tt('generating')}</p>}
    {block.isError ? <p role="alert">{text || block.error?.code}</p> : <>
      <div className="dsh-sub-images">{images.map((image, i) => <Image key={i} api={api} attachment={image.attachment!}/>)}</div>
      {text && <details><summary>{provider === 'antigravity' ? 'antigravity_image_generate' : 'codex_image_generate'}</summary><pre>{text}</pre></details>}
    </>}
  </div>
}
