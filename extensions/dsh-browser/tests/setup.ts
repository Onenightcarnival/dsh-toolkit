/**
 * jsdom test setup: getBoundingClientRect returns a fixed non-empty rect and
 * CSS.escape is implemented.
 */

const FAKE_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 200,
  bottom: 40,
  width: 200,
  height: 40,
  toJSON: () => ({}),
}

Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: function getBoundingClientRect(this: Element): DOMRect {
    return FAKE_RECT
  },
})

Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {
    escape(value: string): string {
      return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
    },
  },
})
