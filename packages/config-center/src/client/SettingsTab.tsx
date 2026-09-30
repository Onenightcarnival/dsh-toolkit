/**
 * Settings → Plugins → Common settings: one card per composition entry, one
 * field per registry option. A blank field keeps the upstream default.
 */
import { useCallback, useEffect, useState } from 'react'
import type { SettingGroupView, SettingOptionView, SettingValue } from '../protocol.ts'
import type { ConfigCenterApi } from './api.ts'
import { tt, ttOr } from './locales.ts'
import { noticeStyle, styles, type Notice } from './styles.ts'
import { Select } from './Select.tsx'

/** Field text by option key: '' keeps the default; bool fields hold 'true' / 'false'. */
type Draft = Record<string, string>

function draftOf(groups: readonly SettingGroupView[]): Draft {
  return Object.fromEntries(groups.flatMap(group => group.options.map(option => [option.key, option.value === undefined ? '' : String(option.value)])))
}

function label(option: SettingOptionView): string {
  return ttOr(`setting.${option.key}`, option.key)
}

/** The value a field submits: `null` for a blank field, undefined when the text is invalid. */
function parse(option: SettingOptionView, text: string): SettingValue | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (option.type === 'bool') return trimmed === 'true'
  const value = Number(trimmed)
  if (option.type === 'posInt') return Number.isSafeInteger(value) && value >= 1 ? value : undefined
  return Number.isFinite(value) && value > 0 && value < 1 ? value : undefined
}

export function SettingsTab({ api }: { api: ConfigCenterApi }): JSX.Element {
  const [groups, setGroups] = useState<SettingGroupView[]>()
  const [draft, setDraft] = useState<Draft>({})
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>()

  const show = useCallback((next: SettingGroupView[]) => {
    setGroups(next)
    setDraft(draftOf(next))
  }, [])

  useEffect(() => {
    api.settings().then(response => show(response.groups), (error: unknown) => {
      setGroups([])
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    })
  }, [api, show])

  const save = async (): Promise<void> => {
    const values: Record<string, SettingValue | null> = {}
    for (const option of (groups ?? []).flatMap(group => group.options)) {
      const value = parse(option, draft[option.key] ?? '')
      if (value === undefined) {
        setNotice({ kind: 'error', text: tt(option.type === 'posInt' ? 'settings.issue.posInt' : 'settings.issue.ratio', { label: label(option) }) })
        return
      }
      values[option.key] = value
    }
    setSaving(true)
    setNotice(undefined)
    try {
      const saved = await api.saveSettings(values)
      show(saved.groups)
      setNotice({ kind: 'ok', text: tt(saved.application === 'applied' ? 'common.saved' : 'common.savedRestart') })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }

  const field = (option: SettingOptionView): JSX.Element => {
    const value = draft[option.key] ?? ''
    const change = (text: string): void => setDraft(previous => ({ ...previous, [option.key]: text }))
    if (option.type === 'bool') {
      return (
        <Select style={styles.selectNarrow} label={label(option)} value={value} onChange={change}
          options={[
            { value: '', label: tt('settings.bool.default', { value: tt(option.def === true ? 'settings.bool.on' : 'settings.bool.off') }) },
            { value: 'true', label: tt('settings.bool.on') },
            { value: 'false', label: tt('settings.bool.off') },
          ]} />
      )
    }
    return <input style={styles.inputNarrow} value={value} placeholder={tt('settings.default', { value: String(option.def) })} inputMode={option.type === 'posInt' ? 'numeric' : 'decimal'} spellCheck={false} onChange={event => change(event.target.value)} />
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.heading}>{tt('settings.title')}</h3>
          <p style={styles.description}>{tt('settings.intro')}</p>
        </div>
      </div>
      {groups === undefined ? <p style={styles.meta}>{tt('common.loading')}</p> : (
        <div style={styles.stack}>
          {groups.map(group => (
            <div key={group.entryId} style={styles.card}>
              <div>
                <h4 style={styles.cardTitle}>{ttOr(`group.${group.entryId}`, group.entryId)}</h4>
                <p style={styles.meta}>{ttOr(`group.${group.entryId}.hint`, '')}</p>
              </div>
              {group.available ? null : <div style={styles.info}>{tt('settings.unavailable')}</div>}
              {group.options.map(option => (
                <label key={option.key} style={styles.field}>
                  <span>{label(option)} <span style={styles.hint}>{ttOr(`setting.${option.key}.hint`, '')}</span></span>
                  {field(option)}
                </label>
              ))}
            </div>
          ))}
          {groups.length === 0 ? null : (
            <div style={styles.actions}>
              <span style={styles.spacer} />
              <button type="button" style={styles.primary} disabled={saving} onClick={() => { void save() }}>{saving ? tt('common.saving') : tt('common.save')}</button>
            </div>
          )}
        </div>
      )}
      {notice === undefined ? null : <div style={{ ...noticeStyle(notice), marginTop: 12 }} role="status">{notice.text}</div>}
    </div>
  )
}
