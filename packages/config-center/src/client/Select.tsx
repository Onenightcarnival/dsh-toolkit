import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'

/** 宿主菜单样式；弹层跟随触发器宽度与位置。 */
export function Select({ value, options, onChange, label, style }: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  label: string
  style: CSSProperties
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [width, setWidth] = useState(0)
  const popupClass = `dsh-config-select-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const getAnchorRect = useCallback(() => trigger.current?.getBoundingClientRect() ?? null, [])
  useLayoutEffect(() => {
    const button = trigger.current
    if (!button) return
    const measure = () => setWidth(button.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(button)
    return () => observer.disconnect()
  }, [])
  return <span style={{ display: 'grid', width: style.width, maxWidth: '100%', minWidth: 0 }}>
    <style>{`.${popupClass}[role="menu"] { width:${width}px; min-width:0; max-width:calc(100vw - 24px); box-sizing:border-box; border-radius:10px; font-family:var(--dsw-font-family, sans-serif); font-size:13px; }
      .${popupClass} button[role="menuitem"] { min-height:34px; font:inherit; }`}</style>
    <Menu open={open} portal autoFocus dense selectedId={value} getAnchorRect={getAnchorRect} listClassName={popupClass}
      items={options.map(option => ({ id: option.value, label: option.label }))}
      onClose={() => setOpen(false)}
      onSelect={next => { onChange(next); setOpen(false) }}
      anchor={<button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
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
