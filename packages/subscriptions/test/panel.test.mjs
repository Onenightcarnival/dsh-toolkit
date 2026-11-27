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
const click = async (element) => { assert.ok(element, 'missing UI element'); await act(async () => element.click()) }

test('model toggles stay interactive, serialize saves and restore the last saved selection on failure', async () => {
  const pending = []
  let catalogCalls = 0
  const models = ['m1', 'm2'].map(id => ({ id, name: id, efforts: [], contextWindow: 128000 }))
  const api = {
    status: async () => ({ busy: false, accounts: [{ key: 'a', isDefault: true }] }),
    catalog: async () => { catalogCalls++; return { settings: {}, models, accounts: [] } },
    save: next => new Promise((resolve, reject) => pending.push({ next, resolve, reject })),
  }
  const root = createRoot(document.getElementById('root'))
  const checkbox = id => document.querySelector(`input[aria-label="${id}"]`)
  try {
    await act(async () => root.render(React.createElement(SubscriptionsPanel, { api, close() {} })))
    const table = document.querySelector('table')
    await click(checkbox('m1'))
    assert.equal(checkbox('m1').checked, false, 'selection updates before the response')
    assert.equal(checkbox('m2').disabled, false)
    assert.equal(document.querySelector('input[aria-label="m1 Context"]').disabled, false)
    await click(checkbox('m2'))
    assert.equal(checkbox('m2').checked, false)
    assert.equal(pending.length, 1, 'only one write runs at a time')
    await act(async () => pending[0].resolve())
    assert.equal(pending.length, 2)
    assert.deepEqual(pending[1].next.visibleModels, [], 'rapid toggles retain both changes')
    await act(async () => pending[1].resolve())
    assert.equal(catalogCalls, 1, 'saving does not reload the catalog')
    assert.equal(document.querySelector('table'), table)
    assert.equal(document.querySelector('.dsh-sub-header [role=status]').textContent, 'Settings saved')
    assert.equal(document.querySelector('.dsh-sub-banner[role=status]'), null)
    await click(checkbox('m1'))
    await act(async () => pending[2].reject(new Error('Save failed')))
    assert.equal(checkbox('m1').checked, false, 'failed write restores confirmed preferences')
    assert.match(document.querySelector('[role=alert]').textContent, /Save failed/)
    await click(button('Retry'))
    assert.equal(checkbox('m1').checked, true)
    await act(async () => pending[3].resolve())
    assert.deepEqual(pending[3].next.visibleModels, ['m1'])
  } finally { await act(async () => root.unmount()) }
})

test('login failure is displayed and Retry repeats login', async () => {
  let attempts = 0
  const api = {
    status: async () => ({ busy: false, accounts: [] }),
    login: async () => { attempts++; throw Error('ChatGPT authorization unavailable') },
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(SubscriptionsPanel, { api, close() {} })))
    await click(button('Continue with ChatGPT'))
    assert.match(document.querySelector('[role=alert]').textContent, /ChatGPT authorization unavailable/)
    await click(button('Retry'))
    assert.equal(attempts, 2)
  } finally { await act(async () => root.unmount()) }
})

test('context editor saves shorthand, preserves preferences, validates limits and restores defaults', async () => {
  let prefs = { contextWindows: { other: 128000 }, accounts: { a: { alias: 'Work account' } }, defaultEfforts: { m1: 'high' } }
  let saves = 0
  let fail = false
  const api = {
    status: async () => ({ busy: false, accounts: [{ key: 'a', account: 'a@example.test', isDefault: true }] }),
    catalog: async () => ({ settings: prefs, models: [{ id: 'm1', name: 'Model One', efforts: [], defaultContextWindow: 272000, contextWindow: prefs.contextWindows.m1 ?? 272000, maxContextWindow: 1000000 }], accounts: [] }),
    save: async (next) => { if (fail) throw new Error('Save failed'); saves++; prefs = next },
  }
  const input = () => document.querySelector('input[aria-label="Model One Context"]')
  const change = async (value) => { await act(async () => Simulate.change(input(), { target: { value } })) }
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
    assert.equal(prefs.accounts.a.alias, 'Work account')
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

test('panel hides models, keeps them editable and lists each account by its own catalog', async () => {
  let prefs = { contextWindows: { m1: 128000 }, accounts: { a: { alias: 'Work account' } } }
  const accounts = [{ key: 'a', account: 'a@example.test', isDefault: true }, { key: 'b', account: 'b@example.test', isDefault: false }]
  const api = {
    status: async () => ({ busy: false, accounts }),
    catalog: async () => ({ settings: prefs, models: [{ id: 'm1', name: 'Model One', efforts: [], contextWindow: 128000 }], accounts: accounts.map(a => ({ key: a.key, models: a.key === 'a' ? [{ id: 'm1' }] : [] })) }),
    save: async (next) => { prefs = next },
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(SubscriptionsPanel, { api, close() {} })))
    assert.match(document.body.textContent, /Work account/)
    assert.match(document.body.textContent, /Model One/)
    await click(document.querySelector('input[aria-label="Model One"]'))
    assert.deepEqual(prefs.visibleModels, [])
    assert.deepEqual(prefs.contextWindows, { m1: 128000 }, 'visibility edits preserve model settings')
    assert.equal(prefs.accounts.a.alias, 'Work account', 'visibility edits preserve account settings')
    assert.match(document.body.textContent, /Model One/, 'hidden model remains in editor')
    await click(button('b@example.test'))
    assert.doesNotMatch(document.querySelector('.dsh-sub-main').textContent, /Model One/)
    assert.match(document.body.textContent, /No models available/)
  } finally { await act(async () => root.unmount()) }
})

test('panel keeps browser authorization link available and cancels login', async () => {
  let status = { busy: false, accounts: [] }
  let cancelled = 0
  let opened
  window.open = (url) => { opened = url; return null }
  const api = {
    status: async () => status,
    login: async () => { status = { ...status, busy: true, manualOnly: true }; return { authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=fixture', manualOnly: true } },
    cancel: async () => { cancelled++; status = { ...status, busy: false } },
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(SubscriptionsPanel, { api, close() {} })))
    await click(button('Continue with ChatGPT'))
    assert.match(opened, /^https:\/\/auth.openai.com/)
    assert.equal(document.querySelector('a[target="_blank"]').href, opened, 'popup-blocked fallback stays visible')
    assert.match(document.body.textContent, /local callback ports are unavailable/)
    assert.equal(document.querySelector('details').open, true, 'blocked ports automatically expand manual callback input')
    await click(button('Cancel'))
    assert.equal(cancelled, 1)
    assert.equal(document.querySelector('a[target="_blank"]'), null)
  } finally { await act(async () => root.unmount()) }
})

test('ChatGPT shows plan usage guidance and reconnects saved registrations', async () => {
  const calls = []
  let connected = true
  const api = { provider: 'chatgpt',
    status: async () => ({ busy: false, accounts: [{ key: 'oaiapp_saved', account: 'chat@example.test', isDefault: connected, connected }] }),
    catalog: async () => ({ provider: 'chatgpt', models: [], settings: {}, accounts: [] }),
    logout: async (key) => { calls.push(['logout', key]); connected = false },
    login: async (key) => { calls.push(['login', key]); throw new Error('Fixture login stopped') },
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(React.createElement(SubscriptionsPanel, { api, close() {} })))
    assert.deepEqual([...document.querySelectorAll('.dsh-sub-provider strong')].map(el => el.textContent), ['ChatGPT'])
    assert.deepEqual([...document.querySelectorAll('[role=tab]')].map(el => el.textContent), ['Models 0', 'Usage'])
    await click(button('Usage'))
    assert.match(document.body.textContent, /Shares plan usage/)
    assert.equal(document.querySelector('a[href="https://chatgpt.com/settings/usage"]').textContent, 'Manage usage')
    assert.match(document.body.textContent, /View remaining app usage in ChatGPT/)
    await click(button('Sign in again'))
    assert.deepEqual(calls.at(-1), ['login', 'oaiapp_saved'])
    await click(button('Disconnect'))
    await click([...document.querySelectorAll('dialog button')].find(el => el.textContent === 'Disconnect account'))
    assert.equal(connected, false)
    assert.match(document.body.textContent, /Not connected/)
    await click(button('Continue with ChatGPT'))
    assert.deepEqual(calls.at(-1), ['login', 'oaiapp_saved'])
    await click(button('Add account'))
    assert.deepEqual(calls.at(-1), ['login', undefined])
  } finally { await act(async () => root.unmount()) }
})
