import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/backend/tools/image-generate.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^(@deepseek-ai\/|undici$)/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const { createImageGenerateTool } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

test('image generation and edits use only ChatGPT with account credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-images-test-'))
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: data.length, width: 1, height: 1 }
  const requests = []
  const session = { accessToken: 'fixture-token', refreshToken: 'fixture-refresh', accountId: 'fixture-account', expiresAt: Date.now() + 3600000 }
  let enabled = true
  const tool = createImageGenerateTool({
    codexTokens: { list: async () => [{ key: 'fixture', session }], session: async () => session },
    imagesDir: directory,
    providerEnabled: () => enabled,
    resolveAttachments: () => ({ imageLimits: { maxImagesPerMessage: 5, maxImageBytes: 100, maxMessageImageBytes: 500 }, readImage: async () => ({ ref, data }) }),
    fetchFn: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      return Response.json({ data: [{ b64_json: data.toString('base64') }] })
    },
  })
  const exec = { signal: new AbortController().signal }
  try {
    assert.equal(tool.name, 'codex_image_generate')
    assert.match(tool.description, /codex_image_generate.images/)
    assert.equal(Object.hasOwn(tool.parameters.properties, 'provider'), false)
    const generated = await tool.execute({ prompt: 'Draw a square' }, exec)
    assert.deepEqual(await readFile(generated.paths[0]), data)
    await tool.execute({ prompt: 'Make it blue', referenceImages: [ref] }, exec)
    assert.deepEqual(requests.map(request => request.url), [
      'https://chatgpt.com/backend-api/codex/images/generations',
      'https://chatgpt.com/backend-api/codex/images/edits',
    ])
    for (const request of requests) {
      assert.equal(request.headers.authorization, 'Bearer fixture-token')
      assert.equal(request.headers['chatgpt-account-id'], 'fixture-account')
      assert.equal(request.body.model, 'gpt-image-2')
    }
    assert.equal(requests[1].body.images[0].image_url, `data:image/png;base64,${data.toString('base64')}`)
    enabled = false
    await assert.rejects(tool.execute({ prompt: 'Disabled' }, exec), /disabled for this session/)
    assert.equal(requests.length, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
