import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: { contents: `export { projectCodexMessages } from './providers/codex.ts'; export { resolveImages } from './translate/resolved.ts'; export { toResponsesInput } from './translate/responses.ts';`, resolveDir: fileURLToPath(new URL('../src/backend', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^(@deepseek-ai\/|undici$)/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const { projectCodexMessages, resolveImages, toResponsesInput } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

test('current DSH user input and tool messages keep Responses call/output pairing', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Search and describe this image' }] },
    { role: 'assistant', id: 'm1', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call-1', name: 'web_search', arguments: '{}' }] },
    { role: 'tool', id: 'm2', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'Search result' }] },
  ]
  const wire = toResponsesInput(await resolveImages(projectCodexMessages(messages)))
  assert.deepEqual(wire.input.map(item => item.type), ['message', 'function_call', 'function_call_output'])
  assert.equal(wire.input[1].call_id, wire.input[2].call_id)
  assert.equal(wire.input[2].output, 'Search result')
})

test('tool result images resolve attachments and follow consecutive tool outputs', async () => {
  const ref = { attachmentId: 'img-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const messages = ['call-1', 'call-2'].map(callId => ({
    role: 'tool', id: callId, source: { kind: 'tool', callId }, toolCallId: callId,
    content: [{ type: 'text', text: callId }, { type: 'image', attachment: ref }],
  }))
  let reads = 0
  const attachments = { async readImage(actual) { assert.equal(actual, ref); reads++; return { ref, data: Uint8Array.from([1, 2, 3]) } } }
  const wire = toResponsesInput(await resolveImages(projectCodexMessages(messages), attachments))
  assert.equal(reads, 2)
  assert.deepEqual(wire.input.map(item => item.type), ['function_call_output', 'function_call_output', 'message'])
  assert.deepEqual(wire.input.slice(0, 2).map(item => item.call_id), ['call-1', 'call-2'])
  const images = wire.input[2].content.filter(item => item.type === 'input_image')
  assert.equal(images.length, 2)
  assert.equal(images[0].image_url, 'data:image/png;base64,AQID')
  await assert.rejects(resolveImages(projectCodexMessages(messages)), /no attachments service/)
})
