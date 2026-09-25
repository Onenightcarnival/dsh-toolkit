/**
 * Panel text-scale preference.
 *
 * Chrome's side panel inherits no per-site zoom control, so a user who finds
 * the default type too small has nothing to reach for. The panel therefore
 * owns the preference: every `font-size` in `styles.css` is a multiple of the
 * `--ui-scale` custom property, and this module is the only place that decides
 * which multiples are legal, how to move between them, and where the choice is
 * stored.
 *
 * The value is deliberately panel-local (its own storage key rather than
 * `dshSettings`) because it is pure presentation: the service worker and the
 * bridge never need to know about it.
 *
 * @module
 */

/** `chrome.storage.local` key holding the persisted scale. */
export const UI_SCALE_STORAGE_KEY = 'dshPanelUiScale'

/** CSS custom property consumed by every `font-size` in the panel stylesheet. */
export const UI_SCALE_PROPERTY = '--ui-scale'

/**
 * Selectable scales, ascending. Discrete steps keep the stepper predictable and
 * guarantee the stored value always round-trips through `normalizeUiScale`.
 */
export const UI_SCALE_STEPS = [0.9, 1, 1.15, 1.3, 1.5, 1.75] as const

/** The scale the panel was designed at. */
export const DEFAULT_UI_SCALE = 1

/** Snap any stored or user-supplied value onto the nearest legal step. */
export function normalizeUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_UI_SCALE
  let closest: number = UI_SCALE_STEPS[0]
  for (const step of UI_SCALE_STEPS) {
    if (Math.abs(step - value) < Math.abs(closest - value)) closest = step
  }
  return closest
}

/** Move one step up (`1`) or down (`-1`), clamping at the ends of the range. */
export function stepUiScale(current: number, direction: 1 | -1): number {
  const snapped = normalizeUiScale(current)
  const index = (UI_SCALE_STEPS as readonly number[]).indexOf(snapped)
  const next = index + direction
  if (next < 0 || next >= UI_SCALE_STEPS.length) return snapped
  return UI_SCALE_STEPS[next]!
}

/** True when the scale is already at the far end of the range in `direction`. */
export function uiScaleAtLimit(current: number, direction: 1 | -1): boolean {
  return stepUiScale(current, direction) === normalizeUiScale(current)
}

/** Percentage label shown between the stepper buttons, e.g. `115%`. */
export function formatUiScale(scale: number): string {
  return `${Math.round(normalizeUiScale(scale) * 100)}%`
}

/** Write the scale onto the document so the stylesheet picks it up. */
export function applyUiScale(scale: number, root: HTMLElement = document.documentElement): void {
  root.style.setProperty(UI_SCALE_PROPERTY, String(normalizeUiScale(scale)))
}

/** Read the persisted scale; falls back to the default when storage is empty. */
export async function loadUiScale(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(UI_SCALE_STORAGE_KEY)
    return normalizeUiScale(stored[UI_SCALE_STORAGE_KEY])
  } catch {
    return DEFAULT_UI_SCALE
  }
}

/** Persist the scale so every side panel window opens at the chosen size. */
export function saveUiScale(scale: number): void {
  void chrome.storage.local.set({ [UI_SCALE_STORAGE_KEY]: normalizeUiScale(scale) }).catch(() => {})
}
