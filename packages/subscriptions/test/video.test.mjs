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
  entryPoints: [fileURLToPath(new URL('../src/backend/tools/video-generate.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^(@deepseek-ai\/|undici$)/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const session = { accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, tokenEndpoint: 'https://auth.x.ai/oauth2/token' }
const exec = () => ({ signal: new AbortController().signal })

test('video request bodies and poll responses follow the xAI contract', () => {
  assert.throws(() => mod.buildVideoGenerateBody({ prompt: ' ' }), /non-empty/)
  assert.throws(() => mod.buildVideoGenerateBody({ prompt: 'p', duration: 16 }), /between 1 and 15/)
  assert.throws(() => mod.buildVideoGenerateBody({ prompt: 'p', duration: 1.5 }), /between 1 and 15/)
  assert.deepEqual(mod.buildVideoGenerateBody({ prompt: ' a cat ', duration: 5, aspect_ratio: '9:16', resolution: '720p', image_url: ' https://img.test/a.png ' }),
    { prompt: 'a cat', model: mod.VIDEO_GENERATE_MODEL, duration: 5, aspect_ratio: '9:16', resolution: '720p', image: { url: 'https://img.test/a.png' } })
  assert.deepEqual(mod.buildVideoGenerateBody({ prompt: 'a cat', image_url: '' }), { prompt: 'a cat', model: mod.VIDEO_GENERATE_MODEL })
  assert.equal(mod.parseVideoStartResponse({ request_id: 'req-1' }), 'req-1')
  assert.throws(() => mod.parseVideoStartResponse({}), /request_id/)
  assert.deepEqual(mod.parseVideoStatusResponse({ status: 'pending' }), { status: 'pending' })
  assert.deepEqual(mod.parseVideoStatusResponse({ status: 'done', video: { url: 'https://v.test/c.mp4', duration: 5 } }), { status: 'done', url: 'https://v.test/c.mp4', duration: 5 })
  assert.deepEqual(mod.parseVideoStatusResponse({ status: 'failed', error: { message: 'moderated' } }), { status: 'failed', detail: 'moderated' })
  assert.throws(() => mod.parseVideoStatusResponse({ status: 'done', video: {} }), /no video URL/)
  assert.throws(() => mod.parseVideoStatusResponse({ status: 'weird' }), /unexpected status/)
  assert.equal(mod.videoStatusUrl('a/b'), 'https://api.x.ai/v1/videos/a%2Fb')
})

test('grok_video_generate submits, polls until done, downloads the MP4 and honors the session policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-videos-test-'))
  const clip = Buffer.from('fixture-mp4-bytes')
  const calls = []
  let polls = 0
  let enabled = true
  const tool = mod.createVideoGenerateTool({
    tokens: { session: async () => session }, videosDir: directory, pollIntervalMs: 0,
    enabled: () => enabled,
    fetchFn: async (url, init) => {
      calls.push({ url, method: init.method, authorization: init.headers?.authorization })
      if (url === mod.VIDEO_GENERATE_URL) {
        assert.deepEqual(JSON.parse(init.body), { prompt: 'a cat', model: mod.VIDEO_GENERATE_MODEL, duration: 3 })
        return Response.json({ request_id: 'req-1' })
      }
      if (url === mod.videoStatusUrl('req-1')) {
        polls++
        return Response.json(polls < 2 ? { status: 'pending' } : { status: 'done', video: { url: 'https://videos.test/clip.mp4', duration: 3 } })
      }
      assert.equal(url, 'https://videos.test/clip.mp4')
      return new Response(clip)
    },
  })
  try {
    assert.equal(tool.name, 'grok_video_generate')
    const value = await tool.execute({ prompt: 'a cat', duration: 3 }, exec())
    assert.equal(value.url, 'https://videos.test/clip.mp4')
    assert.equal(value.duration, 3)
    assert.match(value.path, /\.mp4$/)
    assert.deepEqual(await readFile(value.path), clip)
    assert.equal(polls, 2)
    assert.equal(calls[0].authorization, 'Bearer fixture-token')
    assert.equal(calls.at(-1).authorization, undefined, 'the signed download URL carries no bearer token')
    assert.deepEqual(tool.output.presentationMeta({}, value), { fileName: value.path.slice(value.path.lastIndexOf('/') + 1), duration: 3 })
    assert.match(tool.output.render({}, value)[0].text, /^Saved video to /)
    enabled = false
    await assert.rejects(tool.execute({ prompt: 'a cat' }, exec()), /disabled for this session/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('grok_video_generate reports failed generations and polling deadlines', async () => {
  const failing = mod.createVideoGenerateTool({
    tokens: { session: async () => session }, pollIntervalMs: 0,
    fetchFn: async url => url === mod.VIDEO_GENERATE_URL ? Response.json({ request_id: 'req-2' }) : Response.json({ status: 'failed', error: { message: 'moderated' } }),
  })
  await assert.rejects(failing.execute({ prompt: 'a cat' }, exec()), /generation failed \(request req-2\): moderated/)
  const stuck = mod.createVideoGenerateTool({
    tokens: { session: async () => session }, pollIntervalMs: 0, maxWaitMs: 0,
    fetchFn: async url => url === mod.VIDEO_GENERATE_URL ? Response.json({ request_id: 'req-3' }) : Response.json({ status: 'pending' }),
  })
  await assert.rejects(stuck.execute({ prompt: 'a cat' }, exec()), /timed out/)
  const denied = mod.createVideoGenerateTool({ tokens: { session: async () => session }, fetchFn: async () => new Response('{"error":"no entitlement"}', { status: 403 }) })
  await assert.rejects(denied.execute({ prompt: 'a cat' }, exec()))
})
