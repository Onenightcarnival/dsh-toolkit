import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'

const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', { url: 'http://localhost' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/client/Panel.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { SubscriptionsPanel } = module.exports
const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.includes(text))
const click = async element => { assert.ok(element, 'missing UI element'); await act(async () => element.click()) }

test('context editor saves shorthand, preserves preferences, validates limits and restores defaults', async () => {
  let prefs = { contextWindows: { other: 128000 }, tools: { web_search: false }, defaultEfforts: { m1: 'high' } }
  let saves = 0
  let fail = false
  const api = {
    status: async () => ({ busy: false, accounts: [{ key: 'a', account: 'a@example.test', isDefault: true }] }),
    catalog: async () => ({ settings: prefs, models: [{ id: 'm1', name: 'Model One', efforts: [], defaultContextWindow: 272000, contextWindow: prefs.contextWindows.m1 ?? 272000, maxContextWindow: 1000000 }], accounts: [] }),
    save: async next => { if (fail) throw new Error('Save failed'); saves++; prefs = next },
  }
  const input = () => document.querySelector('input[aria-label="Model One Context"]')
  const change = async value => { await act(async () => Simulate.change(input(), { target: { value } })) }
  const submit = async () => { await act(async () => input().closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))) }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(SubscriptionsPanel, { api, close() {} })))
    assert.equal(input().placeholder, '272K')
    await change('1M'); await submit()
    assert.equal(prefs.contextWindows.m1, 1000000)
    assert.equal(input().value, '1M')
    await change('256k'); await submit()
    assert.equal(prefs.contextWindows.m1, 256000)
    assert.equal(input().value, '256K')
    assert.equal(prefs.contextWindows.other, 128000)
    assert.equal(prefs.tools.web_search, false)
    assert.equal(prefs.defaultEfforts.m1, 'high')
    for (const invalid of ['wat', '0', '-1', '1.1', '9007199254740992', '2M']) {
      await change(invalid); await submit()
      assert.equal(saves, 2, `invalid input must not save: ${invalid}`)
      assert.equal(input().getAttribute('aria-invalid'), 'true')
    }
    await change('512K'); fail = true; await submit()
    assert.equal(input().value, '512K', 'failed save preserves draft')
    assert.equal(prefs.contextWindows.m1, 256000)
    fail = false
    await change(''); await submit()
    assert.equal(prefs.contextWindows.m1, undefined)
    assert.equal(input().value, '')
    assert.equal(input().placeholder, '272K')
    await change('1M'); await submit()
    await click(document.querySelector('button[aria-label="Model One Reset to default"]'))
    assert.deepEqual(prefs.contextWindows, { other: 128000 })
    assert.equal(input().value, '')
  } finally { await act(async () => root.unmount()) }
})

test('panel saves tool preferences, filters models, switches accounts and handles quota errors', async () => {
  let prefs = { contextWindows: { m1: 128000 }, accounts: { a: { alias: 'Work account' } } }
  const accounts = [{ key: 'a', account: 'a@example.test', isDefault: true, plan: 'plus' }, { key: 'b', account: 'b@example.test', isDefault: false }]
  const api = {
    status: async () => ({ busy: false, accounts }),
    catalog: async () => ({ settings: prefs, models: [{ id: 'm1', name: 'Model One', efforts: [], contextWindow: 128000 }], accounts: accounts.map(a => ({ key: a.key, models: [{ id: 'm1' }] })) }),
    save: async next => { prefs = next },
    usage: async key => { if (key === 'b') throw new Error('Usage unavailable'); return { supported: true, windows: [{ kind: 'session', usedPercent: 38, resetsAt: 1800000000000 }] } },
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(SubscriptionsPanel, { api, close() {} })))
    assert.match(document.body.textContent, /Model One/)
    await click(button('Tools'))
    assert.match(document.body.textContent, /codex_web_search/)
    assert.match(document.body.textContent, /codex_image_generate/)
    await click(document.querySelector('input[aria-label="Codex Web Search"]'))
    assert.equal(prefs.tools.web_search, false)
    assert.deepEqual(prefs.contextWindows, { m1: 128000 }, 'tool edits preserve model settings')
    assert.equal(prefs.accounts.a.alias, 'Work account', 'tool edits preserve account settings')
    await click(button('Models'))
    await click(document.querySelector('input[aria-label="Model One"]'))
    assert.deepEqual(prefs.visibleModels, [])
    assert.match(document.body.textContent, /Model One/, 'hidden model remains in editor')
    await click(button('Usage'))
    assert.match(document.body.textContent, /38% Used/)
    await click(button('b@example.test'))
    assert.doesNotMatch(document.body.textContent, /38% Used/, 'account switch clears previous usage')
    assert.match(document.querySelector('[role=alert]').textContent, /Usage unavailable/)
    assert.match(document.body.textContent, /No usage data yet/)
  } finally { await act(async () => root.unmount()) }
})

test('panel keeps browser authorization link available and cancels login', async () => {
  let status = { busy: false, accounts: [] }
  let cancelled = 0
  let opened
  window.open = url => { opened = url; return null }
  const api = {
    status: async () => status,
    login: async () => { status = { ...status, busy: true, manualOnly: true }; return { authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=fixture', manualOnly: true } },
    cancel: async () => { cancelled++; status = { ...status, busy: false } },
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(SubscriptionsPanel, { api, close() {} })))
    await click(button('Connect ChatGPT'))
    assert.match(opened, /^https:\/\/auth.openai.com/)
    assert.equal(document.querySelector('a[target="_blank"]').href, opened, 'popup-blocked fallback stays visible')
    assert.match(document.body.textContent, /local callback ports are unavailable/)
    assert.equal(document.querySelector('details').open, true, 'blocked ports automatically expand manual callback input')
    await click(button('Cancel'))
    assert.equal(cancelled, 1)
    assert.equal(document.querySelector('a[target="_blank"]'), null)
  } finally { await act(async () => root.unmount()) }
})
