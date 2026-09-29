import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: { contents: `export * from './providers/antigravity-tools.ts'; export * from './tools/image-generate.ts'; export * from './tools/web-search.ts'`, resolveDir: fileURLToPath(new URL('../src/backend', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^(@deepseek-ai\/|@cortexkit\/|undici$)/ }, args => ({ path: args.path.startsWith('@cortexkit/') ? import.meta.resolve(args.path) : pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const { AntigravityToolClient, parseAntigravitySearch, parseAntigravityImages, createImageGenerateTool, createWebSearchTool } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const session = { accessToken: 'fixture-access', projectId: 'fixture-project' }
const tokens = { defaultAccount: async () => 'fixture', session: async () => session }
const signal = new AbortController().signal
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')
const imagePayload = { response: { candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] } }
const searchPayload = { response: { candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }, { text: 'Grounded answer' }] }, groundingMetadata: { groundingChunks: [
  { web: { uri: 'https://example.com/source', title: 'Source' } },
  { web: { uri: 'https://example.com/source' } },
  { web: { uri: 'javascript:alert(1)' } },
] } }] } }

test('Google search uses subscription grounding and preserves citation cards', async () => {
  const client = new AntigravityToolClient({ tokens, fetchFn: async (url, init) => {
    assert.match(url, /v1internal:generateContent$/)
    assert.equal(init.headers.authorization, 'Bearer fixture-access')
    assert.match(init.headers['user-agent'], /^antigravity\//)
    const body = JSON.parse(init.body)
    assert.equal(body.project, 'fixture-project')
    assert.equal(body.model, 'gemini-3-flash')
    assert.deepEqual(body.request.tools, [{ googleSearch: {} }])
    assert.equal(body.request.contents[0].parts[0].text, 'fixture query')
    return Response.json(searchPayload)
  } })
  const tool = createWebSearchTool(client, { name: 'antigravity_web_search', label: 'Antigravity', subscription: 'Google Antigravity' })
  assert.equal(tool.name, 'antigravity_web_search')
  const result = await tool.execute({ query: 'fixture query' }, { signal })
  assert.deepEqual(result, { content: 'Grounded answer', sources: [{ url: 'https://example.com/source', title: 'Source' }], truncated: false })
  assert.equal(tool.presentResult({ query: 'fixture' }, { meta: { sources: result.sources, truncated: false, answer: result.content } }).card, 'web')
  assert.throws(() => parseAntigravitySearch({ candidates: [{ content: { parts: [{ text: 'Ungrounded answer' }] } }] }), /no grounded web sources/)
})

test('Google tool requests refresh one account once and only fail over endpoint rejection', async () => {
  const calls = [], refreshes = []
  const client = new AntigravityToolClient({ tokens: { ...tokens, session: async (account, force) => { refreshes.push([account, force]); return { ...session, accessToken: force ? 'fresh' : 'old' } } }, fetchFn: async (url, init) => {
    calls.push([url, init.headers.authorization])
    if (calls.length === 1) return new Response('', { status: 401 })
    if (calls.length === 2) return new Response('', { status: 403 })
    return Response.json(searchPayload)
  } })
  await client.search({ query: 'fixture' }, signal)
  assert.deepEqual(refreshes, [['fixture', undefined], ['fixture', true]])
  assert.equal(calls[2][1], 'Bearer fresh')
  assert.match(calls[2][0], /daily-cloudcode-pa/)
  for (const status of [429, 500, 503]) {
    let count = 0
    const failed = new AntigravityToolClient({ tokens, fetchFn: async () => { count++; return new Response('', { status }) } })
    await assert.rejects(failed.images({ prompt: 'fixture' }, undefined, signal), new RegExp(`HTTP ${status}`))
    assert.equal(count, 1)
  }
  let sent = false
  const disabled = new AntigravityToolClient({ tokens, enabled: () => false, fetchFn: async () => { sent = true } })
  await assert.rejects(disabled.search({ query: 'fixture' }, signal), /disabled/)
  assert.equal(sent, false)
})

test('Google image tool saves and attaches images, validates references and respects session policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-google-images-'))
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }
  const requests = []
  const client = new AntigravityToolClient({ tokens, defaultEffort: () => 'high', fetchFn: async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json(imagePayload)
  } })
  let enabled = true
  const tool = createImageGenerateTool({
    antigravity: { generate: (args, refs, signal) => client.images(args, refs, signal) }, imagesDir: directory,
    providerEnabled: provider => { assert.equal(provider, 'antigravity'); return enabled },
    resolveAttachments: () => ({ imageLimits: { maxImagesPerMessage: 5, maxImageBytes: 1000, maxMessageImageBytes: 5000 }, readImage: async () => ({ ref, data: png }), saveImage: async () => ref }),
    resolveLlm: () => ({ resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }),
  })
  const exec = { signal, agent: { options: { provider: 'antigravity', model: 'claude-fixture' }, session: { header: { createdAt: 1 }, requestHeader: () => undefined } } }
  try {
    assert.equal(tool.name, 'antigravity_image_generate')
    assert.equal(tool.parameters.properties.size, undefined)
    assert.deepEqual(tool.parameters.properties.reasoningEffort.enum, ['minimal', 'high'])
    const result = await tool.execute({ prompt: 'Generate fixture' }, exec)
    assert.deepEqual(await readFile(result.paths[0]), png)
    assert.deepEqual(result.images, [ref])
    assert.match(tool.output.render({}, result)[0].text, /antigravity_image_generate.referenceImages/)
    assert.equal(tool.output.render({}, result)[1].type, 'image')
    await tool.execute({ prompt: 'Edit fixture', referenceImages: [ref], reasoningEffort: 'minimal' }, exec)
    assert.equal(requests[0].model, 'gemini-3.1-flash-image')
    assert.deepEqual(requests[0].request.generationConfig.responseModalities, ['TEXT', 'IMAGE'])
    assert.equal(requests[0].request.generationConfig.thinkingConfig.thinkingLevel, 'HIGH')
    assert.equal(requests[1].request.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL')
    assert.equal(requests[1].request.contents[0].parts[1].inlineData.data, png.toString('base64'))
    await assert.rejects(tool.execute({ prompt: 'Edit', referenceImages: [] }, exec), /1–5/)
    enabled = false
    await assert.rejects(tool.execute({ prompt: 'Disabled' }, exec), /disabled for this session/)
    assert.equal(requests.length, 2)
    assert.throws(() => parseAntigravityImages({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('not image').toString('base64') } }] } }] }), /unsupported image/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
