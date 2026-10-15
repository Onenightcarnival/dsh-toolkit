import { useEffect, useState } from 'react'
import type { SubscriptionsApi } from './api.ts'
import { tt } from './locales.ts'

export interface Props {
  api: SubscriptionsApi
  block?: {
    kind?: string
    argsRaw?: string
    call?: { argsRaw?: string }
    isError?: boolean
    content?: { type: string; text?: string }[]
    error?: { name: string; code: string }
    meta?: unknown
  }
}

/** The generated video's bare file name: presentation meta first, then the "Saved video to …" text line. */
function fileNameOf(block: NonNullable<Props['block']>, text: string): string | undefined {
  const meta = block.meta
  if (typeof meta === 'object' && meta !== null) {
    const fileName = (meta as Record<string, unknown>).fileName
    if (typeof fileName === 'string' && fileName.length > 0) return fileName
  }
  const match = /^Saved video to (.+\.mp4)/m.exec(text)
  if (match === null) return undefined
  return match[1].slice(match[1].lastIndexOf('/') + 1)
}

function Video({ api, name }: { api: SubscriptionsApi; name: string }): JSX.Element {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    let objectUrl = ''
    setUrl(''); setError('')
    void api.call<{ mediaType: string; dataBase64: string }>('video', { name }).then(result => {
      if (cancelled) return
      const binary = atob(result.dataBase64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mediaType }))
      setUrl(objectUrl)
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [api, name])
  return url ? <video src={url} controls preload="metadata" aria-label={tt('videoPreview')}/> : <p role={error ? 'alert' : 'status'}>{error || tt('videoLoading')}</p>
}

export function VideoToolview({ api, block }: Props): JSX.Element | null {
  if (!block) return null
  const settled = block.kind !== undefined
  const raw = block.call?.argsRaw ?? block.argsRaw ?? ''
  let prompt = raw
  try { prompt = (JSON.parse(raw) as { prompt?: string }).prompt ?? raw } catch { /* streaming */ }
  const text = block.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? ''
  const name = settled && !block.isError ? fileNameOf(block, text) : undefined
  return <div className="dsh-sub-imageResult">
    <strong>{tt('grokVideoTitle')}</strong><p>{prompt}</p>
    {!settled && <p role="status">{tt('generatingVideo')}</p>}
    {block.isError ? <p role="alert">{text || block.error?.code}</p> : <>
      {name && <div className="dsh-sub-images"><Video api={api} name={name}/></div>}
      {text && <details><summary>grok_video_generate</summary><pre>{text}</pre></details>}
    </>}
  </div>
}
