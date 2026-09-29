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
const { createImageGenerateTool, buildImageGenerateBody } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

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

test('native image defaults and transparent backgrounds match Codex requests', () => {
  assert.deepEqual(buildImageGenerateBody({ prompt: '  A cutout  ' }), {
    prompt: 'A cutout', model: 'gpt-image-2', size: 'auto', quality: 'auto', background: 'opaque',
  })
  assert.deepEqual(buildImageGenerateBody({ prompt: 'A cutout', transparent_background: true, size: '1024x1024', quality: 'high' }), {
    prompt: 'A cutout', model: 'gpt-image-2', size: '1024x1024', quality: 'high', background: 'transparent',
  })
})

test('native image paths use scoped tool policy; recent images use only the current conversation surface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-images-test-'))
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const refs = ['a', 'b', 'c'].map(char => ({ attachmentId: `sha256:${char.repeat(64)}`, mediaType: 'image/png', bytes: data.length, width: 1, height: 1 }))
  const requests = [], reads = [], imageReads = [], queriedSessions = []
  const session = { accessToken: 'fixture-token', accountId: 'fixture-account', expiresAt: Date.now() + 3600000 }
  let denied = false, enabled = true
  const tool = createImageGenerateTool({
    codexTokens: { list: async () => [{ key: 'fixture', session }], session: async () => session },
    imagesDir: directory, providerEnabled: () => enabled,
    resolveAttachments: () => ({ imageLimits: { maxImagesPerMessage: 5, maxImageBytes: 100, maxMessageImageBytes: 500 }, readImage: async ref => {
      imageReads.push(ref.attachmentId)
      return { ref, data }
    } }),
    fetchFn: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return Response.json({ data: [{ b64_json: data.toString('base64') }] })
    },
  })
  const exec = {
    signal: new AbortController().signal, callId: 'image-call', token: Symbol('image-call'), rootCallId: 'root-call',
    agent: { session: { id: 'chat-a', header: {}, requestHeader: () => undefined }, options: {}, ctx: {
      tools: { execute: async call => {
        reads.push(call)
        if (denied) return { isError: true, content: [{ type: 'text', text: 'permission denied' }] }
        return { isError: false, content: [{ type: 'image', attachment: refs[0] }] }
      } },
      get: name => name === 'sessionQuery' ? { readSurface: async id => {
        queriedSessions.push(id)
        return { events: [
          { type: 'user/message', data: { content: [{ type: 'image', attachment: refs[0] }] } },
          { type: 'tool/result', data: { message: { content: [{ type: 'image', attachment: refs[1] }] } } },
          { type: 'user/message', data: { content: [{ type: 'image', attachment: refs[1] }] } },
          { type: 'tool/result', data: { message: { isError: true, content: [{ type: 'image', attachment: refs[2] }] } } },
          { type: 'system/message', data: { content: [{ type: 'image', attachment: refs[2] }] } },
        ] }
      } } : undefined,
    } },
  }
  const path = join(directory, 'source.png')
  try {
    await tool.execute({ prompt: 'Remove background', referenced_image_paths: [path], transparent_background: true }, exec)
    assert.equal(reads[0].name, 'read_image')
    assert.equal(reads[0].agent, exec.agent)
    assert.equal(reads[0].parent, exec.token)
    assert.equal(reads[0].rootCallId, exec.rootCallId)
    assert.equal(reads[0].signal, exec.signal)
    assert.deepEqual(reads[0].arguments, { file_path: path })
    assert.match(requests[0].url, /\/edits$/)
    assert.equal(requests[0].body.background, 'transparent')
    imageReads.length = 0
    await tool.execute({ prompt: 'Combine', num_last_images_to_include: 2 }, exec)
    assert.deepEqual(imageReads, refs.slice(0, 2).map(ref => ref.attachmentId))
    assert.deepEqual(queriedSessions, ['chat-a'])
    assert.equal(requests[1].body.images.length, 2)
    for (const args of [
      { referenced_image_paths: [], },
      { referenced_image_paths: ['relative.png'] },
      { referenced_image_paths: [path], num_last_images_to_include: 1 },
      { referenced_image_paths: [path], referenceImages: [refs[0]] },
      { num_last_images_to_include: 1, referenceImages: [refs[0]] },
      { num_last_images_to_include: 0 }, { num_last_images_to_include: 6 },
      { num_last_images_to_include: 1.5 }, { num_last_images_to_include: 3 },
    ]) await assert.rejects(tool.execute({ prompt: 'Edit', ...args }, exec))
    assert.equal(requests.length, 2)
    denied = true
    await assert.rejects(tool.execute({ prompt: 'Edit', referenced_image_paths: [path] }, exec), /permission denied/)
    assert.equal(requests.length, 2)
    enabled = false
    const readsBefore = reads.length
    await assert.rejects(tool.execute({ prompt: 'Edit', referenced_image_paths: [path] }, exec), /disabled/)
    assert.equal(reads.length, readsBefore)
    enabled = true
    await assert.rejects(tool.execute({ prompt: 'Edit', num_last_images_to_include: 1 }, { signal: exec.signal }), /session query/)
    await tool.execute({ prompt: 'New image', referenced_image_paths: null, num_last_images_to_include: null }, { signal: exec.signal })
    assert.match(requests.at(-1).url, /\/generations$/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
