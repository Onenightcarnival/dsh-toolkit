/**
 * Settings nav icons of toolkit sections, served through the shell's
 * `settings.section.icon` slot: one registration per section id, rendered
 * at the size the shell passes. Sections without a registration keep the
 * shell's default glyph.
 */
import type { ComponentType } from 'react'

/** Owner props the settings shell passes to a section icon. */
export interface SectionIconProps {
  size: number
  active: boolean
}

/** Outline Medium artworks from @deepseek-ai/dsh-client-ui-primitives (MIT), 16×16, stroke 1.3. */
export const GLYPHS = {
  gauge: '<path d="M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096"/><path d="M8 8.49994L11.6114 4.88855"/><path d="M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z" fill="currentColor" stroke="none"/>',
  terminal: '<path d="M3 4L7 8L3 12"/><path d="M9 12H13"/>',
  lines: '<path d="M6 3.5h7.5M6 8h7.5M6 12.5h7.5" stroke-linecap="round"/><path d="M2.6 3.5h.01M2.6 8h.01M2.6 12.5h.01" stroke-linecap="round"/>',
} as const

/**
 * Build the icon component for one glyph.
 * @param paths - SVG path markup in a 16×16 viewBox, stroked with the text color.
 */
export function sectionIcon(paths: string): ComponentType<SectionIconProps> {
  return function SectionIcon({ size }: SectionIconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: paths }}
      />
    )
  }
}

/** Section id → icon for every toolkit settings section. */
export const SECTION_ICONS: Record<'otel' | 'configCenter', ReadonlyArray<{ id: string; icon: ComponentType<SectionIconProps> }>> = {
  otel: [{ id: 'dsh-otel-settings', icon: sectionIcon(GLYPHS.gauge) }],
  configCenter: [
    { id: 'dsh-config-center-environment', icon: sectionIcon(GLYPHS.terminal) },
    { id: 'dsh-config-center-logs', icon: sectionIcon(GLYPHS.lines) },
  ],
}
