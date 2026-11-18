/**
 * Syntax-highlighted code of the panel: a read-only view and a text editor.
 * Both use the web app's highlighter (`useCodeHighlighter`): a language whose
 * grammar is unknown or still loading renders as plain text.
 */
import { Fragment, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import { useCodeHighlighter } from '@deepseek-ai/dsh-client-ui-primitives'

/** Text above this size renders without highlighting. */
export const HIGHLIGHT_MAX_CHARS = 200_000

/** Grammar for a body: by media type, then JSON by shape. Undefined renders plain. */
export function languageOf(contentType: string, text = ''): string | undefined {
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (/json/.test(type)) return 'json'
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (/xml/.test(type)) return 'xml'
  if (/javascript|ecmascript/.test(type)) return 'javascript'
  if (type === 'text/css') return 'css'
  if (/yaml/.test(type)) return 'yaml'
  const trimmed = text.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : undefined
}

/** Highlighted lines of a text, or the text itself when it renders plain. */
function useHighlighted(text: string, language: string | undefined): ReactNode {
  const highlight = useCodeHighlighter(language)
  return useMemo(() => {
    if (language === undefined || text === '' || text.length > HIGHLIGHT_MAX_CHARS) return text
    let lines: ReturnType<typeof highlight>
    try {
      lines = highlight(text)
    } catch {
      return text
    }
    if (lines === undefined) return text
    return lines.map((line, index) => (
      <Fragment key={index}>
        {index > 0 && '\n'}
        {line.map((span, position) => <span key={position} style={span.style}>{span.text}</span>)}
      </Fragment>
    ))
  }, [text, language, highlight])
}

/** Read-only code block. */
export function CodeView(props: { text: string; language?: string; className?: string }): JSX.Element {
  const content = useHighlighted(props.text, props.language)
  return <pre className={props.className ?? 'dsh-http-code'}>{content}</pre>
}

export interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  language?: string
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/**
 * Text editor with highlighting: a transparent textarea over the highlighted
 * text, both in one grid cell of the scrolling box, so they share width, line
 * wrapping and scroll position.
 */
export function CodeEditor(props: CodeEditorProps): JSX.Element {
  const content = useHighlighted(props.value, props.language)
  return (
    <div className="dsh-http-editor dsh-http-codeEditor" {...(props.disabled ? { 'data-disabled': '' } : {})}>
      {/* The trailing zero-width space keeps the line a final line feed opens. */}
      <pre className="dsh-http-editorLayer" aria-hidden="true">{content}{'​'}</pre>
      <textarea className="dsh-http-editorInput" value={props.value} placeholder={props.placeholder} disabled={props.disabled} spellCheck={false} autoCapitalize="off" aria-label={props.ariaLabel} onChange={(event) => { props.onChange(event.target.value) }} onKeyDown={props.onKeyDown} />
    </div>
  )
}
