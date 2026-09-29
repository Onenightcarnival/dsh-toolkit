import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: {
    contents: `export { createCodexWebSearchTool } from './tools/web-search.ts'; export { CodexWebSearchProvider } from './providers/codex-search.ts'; export { registerWithAlias } from './tools/registration.ts';`,
    resolveDir: fileURLToPath(new URL('../src/backend', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const { createCodexWebSearchTool, CodexWebSearchProvider, registerWithAlias } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

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

test('Codex search bounds sources and reports truncation', async () => {
  const tool = createCodexWebSearchTool({
    available: () => true,
    search: async () => ({ sources: Array.from({ length: 10 }, (_, i) => ({ url: `https://example.test/${i}` })), truncated: false }),
  })
  const args = { query: 'fixture' }
  const value = await tool.execute(args, { signal: new AbortController().signal })
  assert.equal(value.sources.length, 8)
  assert.equal(value.truncated, true)
  assert.match(tool.output.render(args, value)[0].text, /Results truncated/)
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
