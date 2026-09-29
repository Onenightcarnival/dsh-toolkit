import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: {
    contents: `export { createWebSearchTool, createCodexWebSearchTool } from './tools/web-search.ts'; export { CodexWebSearchProvider } from './providers/codex-search.ts'; export { registerWithAlias } from './tools/registration.ts';`,
    resolveDir: fileURLToPath(new URL('../src/backend', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const { createWebSearchTool, createCodexWebSearchTool, CodexWebSearchProvider, registerWithAlias } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

test('independent Codex search uses subscription credentials and preserves source cards', async () => {
  let enabled = true
  const requests = []
  const provider = new CodexWebSearchProvider({
    tokens: { session: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
    enabled: () => enabled,
    fetchFn: async (url, init) => {
      requests.push({ url, ...init, body: JSON.parse(init.body) })
      return Response.json({ output: 'Search summary', results: [
        { url: 'https://example.test/source', title: 'Source', snippet: 'Source text' },
        { url: 'https://example.test/source', title: 'Duplicate' },
        { url: 'javascript:alert(1)', title: 'Invalid URL' },
      ] })
    },
  })
  const tool = createCodexWebSearchTool(provider)
  const signal = new AbortController().signal
  const args = { query: '  fixture query  ' }
  const value = await tool.execute(args, { signal })
  assert.equal(tool.name, 'codex_web_search')
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/alpha/search')
  assert.equal(requests[0].headers.authorization, 'Bearer fixture-token')
  assert.equal(requests[0].headers['chatgpt-account-id'], 'fixture-account')
  assert.equal(requests[0].body.input, 'fixture query')
  assert.equal(requests[0].signal, signal)
  assert.deepEqual(value.sources, [{ url: 'https://example.test/source', title: 'Source', snippet: 'Source text' }])
  const content = tool.output.render(args, value)
  const meta = tool.output.presentationMeta(args, value)
  const card = tool.presentResult(args, { content, meta })
  assert.equal(card.card, 'web')
  assert.equal(card.kind, 'search')
  assert.deepEqual(card.sources, value.sources)
  assert.equal(card.answer, 'Search summary')
  assert.match(content[0].text, /https:\/\/example.test\/source/)
  assert.match(content[0].text, /untrusted data/)
  assert.equal(tool.presentResult(args, { isError: true, meta }), undefined)
  assert.equal(tool.presentResult(args, { meta: { sources: [null] } }), undefined)
  enabled = false
  await assert.rejects(tool.execute(args, { signal }), /codex_web_search: disabled/)
  enabled = true
  await assert.rejects(tool.execute({ query: ' ' }, { signal }), /query must not be empty/)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(tool.execute(args, { signal: cancelled.signal }), /cancelled/)
  assert.equal(requests.length, 1)
})

test('summary search bounds sources and reports truncation', async () => {
  const tool = createWebSearchTool({
    available: () => true,
    search: async () => ({ sources: Array.from({ length: 10 }, (_, i) => ({ url: `https://example.test/${i}` })), truncated: false }),
  })
  const args = { query: 'fixture' }
  const value = await tool.execute(args, { signal: new AbortController().signal })
  assert.equal(value.sources.length, 8)
  assert.equal(value.truncated, true)
  assert.match(tool.output.render(args, value)[0].text, /Results truncated/)
})

test('native Codex commands preserve references, complete sources and conversation isolation', async () => {
  const requests = []
  const results = Array.from({ length: 12 }, (_, i) => ({ type: 'text_result', ref_id: `turn0search${i}`, url: `https://example.test/${i}`, future_field: { preserved: true } }))
  const provider = new CodexWebSearchProvider({
    tokens: { session: async () => ({ accessToken: 'fixture', accountId: 'fixture' }) },
    fetchFn: async (_url, init) => {
      requests.push(JSON.parse(init.body))
      return Response.json({ output: 'turn0search0\nL12: A page with link 3', encrypted_output: 'private-state', results })
    },
  })
  const tool = createCodexWebSearchTool(provider)
  const signal = new AbortController().signal
  const exec = { signal, agent: { session: { id: 'chat-a' } } }
  const args = { search_query: [{ q: 'native', domains: ['example.test'], recency: 7 }], response_length: 'long' }
  const value = await tool.execute(args, exec)
  assert.equal(value.sources.length, 12)
  assert.equal(value.truncated, false)
  assert.deepEqual(value.results, results)
  assert.equal('encrypted_output' in value, false)
  assert.match(tool.output.render(args, value)[0].text, /L12: A page with link 3/)
  await tool.execute({ open: [{ ref_id: 'turn0search0', lineno: 12 }], click: [{ ref_id: 'turn0view0', id: 3 }], find: [{ ref_id: 'turn0view0', pattern: 'A page' }] }, exec)
  await tool.execute({ time: [{ utc_offset: '+08:00' }] }, { signal, agent: { session: { id: 'chat-b' } } })
  assert.equal(requests[0].id, requests[1].id)
  assert.notEqual(requests[0].id, requests[2].id)
  assert.deepEqual(requests[0].commands, args)
  assert.equal(requests[0].max_output_tokens, 8192)
  assert.deepEqual(requests[1].commands.open, [{ ref_id: 'turn0search0', lineno: 12 }])
  const other = {
    image_query: [{ q: 'forest', recency: 3, domains: ['example.test'] }],
    screenshot: [{ ref_id: 'turn0view0', pageno: 0 }],
    finance: [{ ticker: 'BTC', type: 'crypto', market: '' }],
    weather: [{ location: 'Shanghai', start: '2026-09-29', duration: 3 }],
    sports: [{ fn: 'schedule', league: 'nba', team: 'GSW', opponent: 'LAL', num_games: 2, date_from: '2026-09-29', date_to: '2026-10-29', locale: 'en-US', tool: 'sports' }],
    response_length: 'medium',
  }
  await tool.execute(other, exec)
  assert.deepEqual(requests[3].commands, other)
})

test('native Codex validation rejects ambiguous, empty and out-of-range commands before dispatch', async () => {
  let calls = 0
  const tool = createCodexWebSearchTool(new CodexWebSearchProvider({
    tokens: { session: async () => { calls++; throw new Error('unexpected authentication') } },
  }))
  const exec = { signal: new AbortController().signal }
  for (const args of [
    {}, { response_length: 'long' }, { search_query: [] }, { search_query: [{ q: ' ' }] },
    { query: 'legacy', open: [{ ref_id: 'https://example.test' }] },
    { search_query: Array.from({ length: 5 }, () => ({ q: 'test' })) },
    { search_query: Array.from({ length: 4 }, () => ({ q: 'test' })), response_length: 'short' },
    { open: [{ ref_id: 'turn0view0', lineno: -1 }] },
    { screenshot: [{ ref_id: 'turn0view0', pageno: 0.5 }] },
    { search_query: [{ q: 'test', recency: -1 }] },
    { search_query: [{ q: 'test', domains: [' '] }] },
  ]) await assert.rejects(tool.execute(args, exec))
  assert.equal(calls, 0)
})

test('Codex tools have distinct fallback names', () => {
  for (const name of ['codex_web_search', 'codex_image_generate']) {
    let registered
    const result = registerWithAlias({ register(tool) {
      if (tool.name === name) throw new Error('duplicate')
      registered = tool
      return () => {}
    } }, { name })
    assert.equal(result.name, `dsh_subscriptions_${name}`)
    assert.equal(registered.name, result.name)
  }
})
