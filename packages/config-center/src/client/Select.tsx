import { useState, type CSSProperties } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'

/** Use the host menu so the popup follows the app theme on Windows and macOS. */
export function Select({ value, options, onChange, label, style }: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  label: string
  style: CSSProperties
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return <span style={{ display: 'grid', width: style.width, maxWidth: '100%', minWidth: 0 }}>
    <Menu open={open} portal autoFocus selectedId={value}
      items={options.map(option => ({ id: option.value, label: option.label }))}
      onClose={() => setOpen(false)}
      onSelect={next => { onChange(next); setOpen(false) }}
      anchor={<button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(previous => !previous)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        style={{ ...style, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
        <span>{options.find(option => option.value === value)?.label ?? value}</span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flex: 'none' }}>
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>} />
  </span>
}
