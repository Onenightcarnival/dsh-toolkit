// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyUiScale,
  DEFAULT_UI_SCALE,
  formatUiScale,
  normalizeUiScale,
  stepUiScale,
  UI_SCALE_PROPERTY,
  UI_SCALE_STEPS,
  uiScaleAtLimit,
} from '../src/panel/ui-scale.ts'

describe('panel text scale', () => {
  it('snaps stored or malformed values onto a legal step', () => {
    expect(normalizeUiScale(undefined)).toBe(DEFAULT_UI_SCALE)
    expect(normalizeUiScale('1.5')).toBe(DEFAULT_UI_SCALE)
    expect(normalizeUiScale(Number.NaN)).toBe(DEFAULT_UI_SCALE)
    expect(normalizeUiScale(1.14)).toBe(1.15)
    expect(normalizeUiScale(0.1)).toBe(UI_SCALE_STEPS[0])
    expect(normalizeUiScale(9)).toBe(UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1])
  })

  it('steps within the range and clamps at both ends', () => {
    expect(stepUiScale(1, 1)).toBe(1.15)
    expect(stepUiScale(1, -1)).toBe(0.9)

    const smallest = UI_SCALE_STEPS[0]
    const largest = UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1]
    expect(stepUiScale(smallest, -1)).toBe(smallest)
    expect(stepUiScale(largest, 1)).toBe(largest)
    expect(uiScaleAtLimit(smallest, -1)).toBe(true)
    expect(uiScaleAtLimit(smallest, 1)).toBe(false)
    expect(uiScaleAtLimit(largest, 1)).toBe(true)
  })

  it('labels the scale as a whole percentage', () => {
    expect(formatUiScale(1)).toBe('100%')
    expect(formatUiScale(1.15)).toBe('115%')
    expect(formatUiScale(1.75)).toBe('175%')
  })

  it('writes the scale onto the document element', () => {
    const root = document.createElement('div')
    applyUiScale(1.3, root)
    expect(root.style.getPropertyValue(UI_SCALE_PROPERTY)).toBe('1.3')
    applyUiScale(42, root)
    expect(root.style.getPropertyValue(UI_SCALE_PROPERTY)).toBe('1.75')
  })

  it('routes every stylesheet font-size through the scale token', () => {
    const styles = readFileSync(`${process.cwd()}/src/panel/styles.css`, 'utf8')
    const declarations = styles.match(/font-size:[^;]+;/g) ?? []

    expect(declarations.length).toBeGreaterThan(0)
    const unscaled = declarations.filter((declaration) => (
      /[0-9]px/.test(declaration) && !declaration.includes(`var(${UI_SCALE_PROPERTY})`)
    ))
    expect(unscaled).toEqual([])
    expect(styles).toMatch(new RegExp(`${UI_SCALE_PROPERTY}:\\s*1;`))
  })
})
