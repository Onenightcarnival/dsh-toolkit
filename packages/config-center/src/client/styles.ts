/** Inline styles; colors inherit from Settings in both appearances. */
import type { CSSProperties } from 'react'

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const BORDER = '1px solid rgba(127,127,127,.4)'
const FIELD_BORDER = '1px solid rgba(127,127,127,.55)'

export const styles = {
  page: { padding: '20px 2px', color: 'inherit', maxWidth: 860 },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18, marginBottom: 16 },
  heading: { margin: 0, fontSize: 18 },
  description: { margin: '6px 0 0', fontSize: 13, opacity: 0.76, lineHeight: 1.5 },
  split: { display: 'flex', gap: 16, alignItems: 'flex-start' },
  list: { width: 200, flex: 'none', display: 'flex', flexDirection: 'column', gap: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid transparent', borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13, textAlign: 'left' },
  rowSelected: { border: BORDER, background: 'rgba(127,127,127,.14)' },
  rowName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO },
  rowTag: { flex: 'none', fontSize: 11, opacity: 0.7 },
  dot: { flex: 'none', width: 8, height: 8, borderRadius: 99, background: 'rgba(127,127,127,.55)' },
  dotOk: { background: '#32c56c' },
  dotError: { background: '#f07171' },
  empty: { fontSize: 12, opacity: 0.7, padding: '10px 4px', lineHeight: 1.5 },
  card: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: 16, border: BORDER, borderRadius: 10 },
  cardTitle: { margin: 0, fontSize: 15 },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 },
  hint: { opacity: 0.7, fontWeight: 400, fontSize: 12 },
  input: { width: '100%', boxSizing: 'border-box', border: FIELD_BORDER, borderRadius: 7, padding: '7px 9px', background: 'transparent', color: 'inherit', fontSize: 13, fontFamily: MONO },
  inputNarrow: { width: 200, boxSizing: 'border-box', border: FIELD_BORDER, borderRadius: 7, padding: '6px 9px', background: 'transparent', color: 'inherit', fontSize: 13, fontFamily: MONO },
  textarea: { width: '100%', boxSizing: 'border-box', border: FIELD_BORDER, borderRadius: 7, padding: '7px 9px', background: 'transparent', color: 'inherit', fontSize: 13, fontFamily: MONO, resize: 'vertical' },
  select: { width: '100%', boxSizing: 'border-box', border: FIELD_BORDER, borderRadius: 7, padding: '7px 9px', background: 'transparent', color: 'inherit', fontSize: 13 },
  selectNarrow: { width: 200, boxSizing: 'border-box', border: FIELD_BORDER, borderRadius: 7, padding: '6px 9px', background: 'transparent', color: 'inherit', fontSize: 13 },
  pair: { display: 'flex', gap: 6, marginBottom: 6 },
  pairKey: { flex: '0 0 34%' },
  switch: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, cursor: 'pointer' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
  spacer: { flex: 1 },
  primary: { border: 0, borderRadius: 7, padding: '7px 14px', background: 'var(--dsw-alias-button-primary-fill, #2d6cdf)', color: 'var(--dsw-alias-label-primary-foreground, #fff)', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' },
  secondary: { border: FIELD_BORDER, borderRadius: 7, padding: '6px 12px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' },
  danger: { border: '1px solid rgba(240,113,113,.6)', borderRadius: 7, padding: '6px 12px', background: 'transparent', color: '#f07171', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' },
  ghost: { border: 0, background: 'transparent', color: 'inherit', opacity: 0.72, cursor: 'pointer', fontSize: 12, padding: '2px 0', textDecoration: 'underline', textUnderlineOffset: 3, alignSelf: 'flex-start' },
  icon: { flex: 'none', border: FIELD_BORDER, borderRadius: 7, padding: '0 9px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 14 },
  error: { padding: '8px 10px', borderRadius: 7, background: 'rgba(240,113,113,.15)', color: '#ff8a8a', fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
  ok: { padding: '8px 10px', borderRadius: 7, background: 'rgba(50,197,108,.14)', color: '#32c56c', fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
  info: { padding: '8px 10px', borderRadius: 7, background: 'rgba(127,127,127,.14)', fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
  meta: { margin: 0, fontSize: 12, opacity: 0.76, lineHeight: 1.5 },
  stack: { display: 'flex', flexDirection: 'column', gap: 14 },
} satisfies Record<string, CSSProperties>

export type Notice = { kind: 'ok' | 'error' | 'info'; text: string; details?: string }

/** MCP panel: toolbar, server list, scrollable editor and fixed actions. */
export const mcpStyles = {
  ...styles,
  page: { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', flex: 1, height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', padding: '14px 16px 16px', gap: 10, containerType: 'inline-size', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', fontFamily: 'var(--dsw-font-family, sans-serif)', fontSize: 13 },
  header: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' },
  heading: { margin: 0, flex: 1, fontSize: 16, fontWeight: 700 },
  settings: { flex: 'none', maxHeight: '40%', overflow: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  settingsBody: { display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', padding: '8px 0' },
  split: { display: 'flex', gap: 12, flex: 1, minHeight: 0, minWidth: 0 },
  sidebar: { display: 'flex', flexDirection: 'column', gap: 6, width: 'clamp(180px, 22%, 280px)', flex: 'none', minHeight: 0, borderRight: '1px solid var(--dsw-alias-border-l1)', paddingRight: 12 },
  listHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', padding: '2px 4px' },
  list: { display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', minHeight: 0 },
  row: { ...styles.row, minHeight: 36, padding: '7px 8px', borderRadius: 8, fontFamily: 'inherit' },
  rowSelected: { background: 'var(--dsw-alias-interactive-bg-active)', borderColor: 'var(--dsw-alias-border-l1)' },
  rowName: { ...styles.rowName, fontFamily: 'inherit', fontWeight: 600 },
  card: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 },
  editorScroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 12px 12px 4px' },
  form: { display: 'flex', flexDirection: 'column', gap: 14, width: '100%' },
  feedback: { flex: '0 1 auto', minHeight: 0, maxHeight: '30%', overflowY: 'auto', margin: '0 12px 10px 4px' },
  cardTitle: { margin: 0, fontSize: 14, overflowWrap: 'anywhere' },
  field: { ...styles.field, gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', minWidth: 0 },
  textarea: { ...styles.textarea, fontFamily: 'inherit', fontWeight: 400, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.5, padding: '8px 12px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', border: '0.5px solid var(--dsw-alias-border-l4)' },
  select: { ...styles.select, fontFamily: 'inherit', fontWeight: 400, color: 'var(--dsw-alias-label-primary)', minHeight: 36, borderRadius: 10, padding: '6px 12px', background: 'var(--dsw-alias-interactive-bg-hover)', border: 0 },
  danger: { color: 'var(--dsw-alias-state-error-primary, #e55)' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 'none', margin: '0 12px 0 4px', paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)' },
} satisfies Record<string, CSSProperties>

export function noticeStyle(notice: Notice): CSSProperties {
  return notice.kind === 'ok' ? styles.ok : notice.kind === 'error' ? styles.error : styles.info
}
