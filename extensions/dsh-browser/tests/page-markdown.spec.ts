// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { toMarkdown } from '../src/content/markdown.ts'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('toMarkdown', () => {
  it('renders headings, emphasis, links, images, lists, and code', () => {
    document.body.innerHTML = `
      <h1>Orders</h1>
      <p>Hello <strong>world</strong>, see <a href="/docs/a">the docs</a> and <img src="/pic.png" alt="a picture">.</p>
      <ul><li>one</li><li>two <em>soft</em></li></ul>
      <ol start="3"><li>three</li><li>four</li></ol>
      <pre><code class="language-ts">const x = 1\n</code></pre>
      <p>Inline <code>call()</code> here.</p>
      <blockquote>quoted</blockquote>
      <script>alert(1)</script>
    `
    const md = toMarkdown(document.body, 'https://example.test/base/')
    expect(md).toContain('# Orders')
    expect(md).toContain('Hello **world**, see [the docs](https://example.test/docs/a) and ![a picture](https://example.test/pic.png).')
    expect(md).toContain('- one\n- two *soft*')
    expect(md).toContain('3. three\n4. four')
    expect(md).toContain('```ts\nconst x = 1\n```')
    expect(md).toContain('Inline `call()` here.')
    expect(md).toContain('> quoted')
    expect(md).not.toContain('alert(1)')
  })

  it('renders tables with a header row and escapes pipes', () => {
    document.body.innerHTML = `
      <table><caption>Totals</caption>
        <tr><th>Item</th><th>Qty</th></tr>
        <tr><td>Widget | small</td><td>2</td></tr>
        <tr><td>Gadget</td></tr>
      </table>
    `
    const md = toMarkdown(document.body)
    expect(md).toContain('**Totals**')
    expect(md).toContain('| Item | Qty |\n| --- | --- |\n| Widget \\| small | 2 |\n| Gadget |  |')
  })

  it('skips hidden nodes, reads form values (never passwords), and walks shadow roots', () => {
    document.body.innerHTML = `
      <div hidden>secret hidden</div>
      <div aria-hidden="true">aria hidden</div>
      <input value="typed">
      <input type="password" value="hunter2">
      <input type="checkbox" checked>
      <select><option>Red</option><option selected>Blue</option></select>
      <textarea>notes here</textarea>
      <div id="host"></div>
    `
    const host = document.getElementById('host') as HTMLElement
    host.attachShadow({ mode: 'open' }).innerHTML = '<h2>Shadow title</h2><p>shadow body</p>'
    const md = toMarkdown(document.body)
    expect(md).not.toContain('secret hidden')
    expect(md).not.toContain('aria hidden')
    expect(md).toContain('[typed]')
    expect(md).not.toContain('hunter2')
    expect(md).toContain('[x]')
    expect(md).toContain('[Blue]')
    expect(md).toContain('notes here')
    expect(md).toContain('## Shadow title')
    expect(md).toContain('shadow body')
  })

  it('collapses runs of blank lines and returns an empty string for no root', () => {
    document.body.innerHTML = '<div><p>a</p><div></div><div></div><p>b</p></div>'
    expect(toMarkdown(document.body)).toBe('a\n\nb')
    expect(toMarkdown(null)).toBe(toMarkdown(document.body))
  })
})
