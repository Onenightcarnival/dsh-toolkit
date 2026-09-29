import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: { contents: `export * from './providers/antigravity.ts'; export * from './translate/antigravity.ts'; export * from './auth/antigravity-client.ts';`, resolveDir: fileURLToPath(new URL('../src/backend', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^(@deepseek-ai\/|@cortexkit\/|undici$)/ }, args => ({ path: args.path.startsWith('@cortexkit/') ? import.meta.resolve(args.path) : pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const { parseAntigravityResponse, antigravityHeaders, requestAntigravityContent, discoverAntigravityAccount, antigravityFlow, exchangeAntigravityCode, refreshAntigravity, fetchAntigravityModels, fetchAntigravityUsage, AntigravityAdapter, toAntigravityRequest, streamAntigravity, resolveAntigravityOAuthConfig, preserveAntigravityClient } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const oauth = { clientId: 'fixture-client', clientSecret: 'fixture-secret' }
const session = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, projectId: 'fixture-project', account: 'fixture@example.test' }

test('Antigravity client identity survives DSH attribution headers', () => {
  const headers = antigravityHeaders('fixture')
  assert.match(headers['user-agent'], /^antigravity\/1\.15\.8 (windows|darwin|linux)\//)
  assert.equal(headers.authorization, 'Bearer fixture')
  assert.equal(headers.accept, 'application/json')
  assert.equal(antigravityHeaders('fixture', 'antigravity/custom')['user-agent'], 'antigravity/custom')
})

test('models and quota fall back from production 403 to the available Google endpoint', async () => {
  const visited = []
  const fetchFn = async (url, init) => {
    const host = new URL(url).hostname
    const method = url.split(':').at(-1)
    visited.push([host, method])
    assert.match(init.headers['user-agent'], /^antigravity\//)
    if (host === 'cloudcode-pa.googleapis.com') return Response.json({ error: { message: 'PERMISSION_DENIED' } }, { status: 403 })
    if (method === 'fetchAvailableModels') return Response.json({ models: { 'gemini-fixture': { quotaInfo: { remainingFraction: 0.8 } } } })
    if (method === 'loadCodeAssist') return Response.json({ paidTier: { name: 'Google AI Pro' } })
    if (method === 'retrieveUserQuotaSummary') return Response.json({ groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'weekly', remainingFraction: 0.6 }] }] })
    throw Error('Unexpected endpoint')
  }
  assert.deepEqual((await fetchAntigravityModels(session, {}, fetchFn)).map(model => model.id), ['gemini-fixture'])
  const usage = await fetchAntigravityUsage(session, {}, fetchFn)
  assert.equal(usage.plan, 'Google AI Pro')
  assert.equal(usage.windows[0].usedPercent, 40)
  for (const method of ['fetchAvailableModels', 'loadCodeAssist', 'retrieveUserQuotaSummary']) {
    assert.ok(visited.some(([host, entry]) => host === 'daily-cloudcode-pa.sandbox.googleapis.com' && entry === method))
  }
})

test('model discovery merges catalogs, honors endpoint overrides and rejects total failure', async () => {
  const catalog = async url => Response.json({ models: new URL(url).hostname === 'cloudcode-pa.googleapis.com'
    ? { 'gemini-prod': {}, 'gemini-shared': { inputTokenLimit: 1000 } }
    : { 'claude-daily': {}, 'gemini-shared': { inputTokenLimit: 2000 } } })
  const models = await fetchAntigravityModels(session, {}, catalog)
  assert.deepEqual(models.map(model => model.id), ['gemini-prod', 'gemini-shared', 'claude-daily'])
  assert.equal(models[1].contextWindow, 2000)
  const visits = []
  await assert.rejects(fetchAntigravityModels(session, { baseURL: 'https://cloudcode-pa.googleapis.com' }, async url => {
    visits.push(url); return new Response('', { status: 403 })
  }), /HTTP 403/)
  assert.equal(visits.length, 1)
  await assert.rejects(fetchAntigravityModels(session, {}, async () => new Response('', { status: 403 })), /HTTP 403/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(fetchAntigravityModels(session, {}, async () => { throw Error('must not request') }, abort.signal), { name: 'AbortError' })
})

test('quota windows remain available when optional catalog or tier lookup fails', async () => {
  const usage = await fetchAntigravityUsage({ ...session, plan: 'Google AI Pro' }, {}, async url => url.endsWith('retrieveUserQuotaSummary')
    ? Response.json({ groups: [{ buckets: [{ bucketId: 'weekly', remainingFraction: 0.25 }] }] })
    : new Response('', { status: 403 }))
  assert.equal(usage.plan, 'Google AI Pro')
  assert.equal(usage.windows[0].usedPercent, 75)
  await assert.rejects(fetchAntigravityUsage(session, {}, async () => new Response('', { status: 403 })), /HTTP 403/)
})

test('generation retries endpoint permission failures while preserving individual quota limits', async () => {
  const visits = []
  const result = await requestAntigravityContent(session, { model: 'gemini-fixture' }, true, {}, async (url, init) => {
    visits.push(url)
    assert.match(init.headers['user-agent'], /^antigravity\//)
    return visits.length === 1 ? new Response('', { status: 403 }) : new Response('data: {}\n\n')
  })
  assert.equal(result.status, 200)
  await result.body.cancel()
  assert.equal(visits.length, 2)
  let requests = 0
  const limited = await requestAntigravityContent(session, { model: 'gemini-fixture' }, true, {}, async () => {
    requests++; return new Response('Individual quota reached', { status: 429 })
  })
  assert.equal(requests, 1)
  assert.equal(limited.status, 429)
  assert.equal(await limited.text(), 'Individual quota reached')
})

test('project discovery accepts legacy response shapes and optional project-list 404', async () => {
  for (const field of ['antigravityProjectId', 'projectId', 'backendProjectId', 'userDefinedCloudaicompanionProject', 'cloudaicompanionProject', 'project']) {
    const account = await discoverAntigravityAccount('fixture', {}, async url => {
      if (url.endsWith('loadCodeAssist')) return Response.json({ [field]: { id: 'discovered' } })
      if (url.endsWith('/userinfo')) return Response.json({ email: 'fixture@example.test' })
      throw Error('Unexpected project-list lookup')
    })
    assert.equal(account.projectId, 'discovered')
  }
  const nested = await discoverAntigravityAccount('fixture', {}, async url => url.endsWith('loadCodeAssist')
    ? Response.json({}) : url.endsWith('listCloudAICompanionProjects')
      ? Response.json({ projects: [{ projectId: 'nested-project' }] }) : Response.json({ email: 'fixture@example.test' }))
  assert.equal(nested.projectId, 'nested-project')
  const requests = []
  const discover = email => discoverAntigravityAccount('fixture', {}, async url => {
    requests.push(url)
    if (url.endsWith('loadCodeAssist')) return Response.json({ paidTier: { name: 'Google AI Pro' } })
    if (url.endsWith('listCloudAICompanionProjects')) return new Response('<!DOCTYPE html><html>Not Found</html>', { status: 404 })
    return Response.json({ email })
  })
  const first = await discover('first@example.test')
  assert.equal(first.plan, 'Google AI Pro')
  assert.match(first.projectId, /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  assert.equal((await discover('first@example.test')).projectId, first.projectId)
  assert.notEqual((await discover('second@example.test')).projectId, first.projectId)
  assert.ok(requests.some(url => url.startsWith('https://daily-cloudcode-pa.sandbox.googleapis.com/')))
})

test('project-list 404 permits explicit onboarding; permission errors remain failures without HTML', async () => {
  const account = await discoverAntigravityAccount('fixture', { onboard: true }, async url => {
    if (url.endsWith('loadCodeAssist')) return Response.json({ allowedTiers: [{ id: 'free', isDefault: true }] })
    if (url.endsWith('listCloudAICompanionProjects')) return new Response('', { status: 404 })
    if (url.endsWith('onboardUser')) return Response.json({ done: true, response: { cloudaicompanionProject: 'onboarded' } })
    return Response.json({ email: 'fixture@example.test' })
  })
  assert.equal(account.projectId, 'onboarded')
  const fixed = await discoverAntigravityAccount('fixture', { projectId: 'configured' }, async url => {
    if (url.endsWith('loadCodeAssist')) return Response.json({ projectId: 'discovered' })
    if (url.endsWith('/userinfo')) return Response.json({})
    throw Error('Unexpected project-list lookup')
  })
  assert.equal(fixed.projectId, 'configured')
  for (const status of [401, 403, 429, 503]) {
    await assert.rejects(discoverAntigravityAccount('fixture', {}, async url => url.endsWith('loadCodeAssist')
      ? Response.json({}) : new Response('<!DOCTYPE html><html><style>body{color:red}</style>Error</html>', { status })), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`))
      assert.doesNotMatch(error.message, /<html|<!DOCTYPE|<style|color:red/)
      return true
    })
  }
})

test('Google OAuth uses PKCE, discovers project and preserves refresh credentials', async () => {
  const flow = antigravityFlow(oauth)
  const url = new URL(flow.buildAuthorizeUrl({ redirectUri: flow.manualRedirectUri, state: 'fixture-state', pkce: { challenge: 'fixture-challenge', verifier: 'fixture-verifier' } }))
  assert.equal(url.origin, 'https://accounts.google.com')
  assert.equal(url.searchParams.get('state'), 'fixture-state')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.match(url.searchParams.get('scope'), /auth\/aicode/)
  const bodies = []
  const fetchFn = async (url, init) => {
    if (url.includes('/token')) {
      bodies.push(new URLSearchParams(init.body))
      return Response.json({ access_token: 'fresh-access', refresh_token: bodies.length === 1 ? 'fresh-refresh' : undefined, expires_in: 3600 })
    }
    if (url.endsWith('loadCodeAssist')) return Response.json({ cloudaicompanionProject: { id: 'actual-project' }, paidTier: { name: 'Google AI Pro' } })
    if (url.endsWith('/userinfo')) return Response.json({ email: 'fixture@example.test' })
    throw new Error(`Unexpected endpoint ${url}`)
  }
  const connected = await exchangeAntigravityCode('fixture-code', 'fixture-verifier', flow.manualRedirectUri, oauth, {}, fetchFn)
  assert.equal(connected.projectId, 'actual-project')
  assert.equal(connected.account, 'fixture@example.test')
  assert.equal(connected.plan, 'Google AI Pro')
  assert.equal(bodies[0].get('code_verifier'), 'fixture-verifier')
  assert.equal(bodies[0].get('client_secret'), 'fixture-secret')
  const refreshed = await refreshAntigravity(connected, oauth, fetchFn)
  assert.equal(refreshed.refreshToken, 'fresh-refresh')
  assert.equal(refreshed.projectId, 'actual-project')
  assert.equal(bodies[1].get('grant_type'), 'refresh_token')
})

test('live Antigravity catalog includes image models and excludes internal models; quotas preserve unknown values', async () => {
  const fetchFn = async url => {
    if (url.endsWith('fetchAvailableModels')) return Response.json({ models: {
      'gemini-3.7-flash-tiered': { displayName: 'Gemini Flash', inputTokenLimit: 1048576, maxOutputTokens: 65535 },
      'claude-sonnet-fixture': { displayName: 'Claude Sonnet' },
      'gpt-oss-fixture': {}, 'chat_internal': {}, 'hidden': { isInternal: true }, 'gemini-3.1-flash-image': {},
    } })
    if (url.endsWith('loadCodeAssist')) return Response.json({ paidTier: { name: 'Google AI Pro' } })
    if (url.endsWith('retrieveUserQuotaSummary')) return Response.json({ groups: [{ displayName: 'Gemini', buckets: [
      { bucketId: 'weekly', remainingFraction: 0.75, resetTime: '2026-10-01T00:00:00Z' },
      { bucketId: '5h', remainingFraction: 0.5 }, { bucketId: 'unknown' },
    ] }] })
    throw new Error('Unexpected endpoint')
  }
  const models = await fetchAntigravityModels(session, {}, fetchFn)
  assert.deepEqual(models.map(model => model.id), ['gemini-3.7-flash-tiered', 'claude-sonnet-fixture', 'gpt-oss-fixture', 'gemini-3.1-flash-image'])
  assert.equal(models[1].contextWindow, 200000)
  assert.deepEqual(models[2].inputModalities, ['text'])
  assert.equal(models[3].contextWindow, 131072)
  const usage = await fetchAntigravityUsage(session, {}, fetchFn)
  assert.equal(usage.plan, 'Google AI Pro')
  assert.deepEqual(usage.windows.map(window => [window.kind, window.usedPercent]), [['weekly', 25], ['session', 50]])
  assert.equal(usage.windows[0].resetsAt, Date.parse('2026-10-01T00:00:00Z'))
})

test('Antigravity request preserves tool pairing, images, caller system and signed reasoning', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', mediaType: 'image/png', dataBase64: 'AQID' }] },
    { role: 'assistant', source: { kind: 'model', provider: 'antigravity', model: 'gemini-3.7-flash-tiered', replayState: { response: { kind: 'antigravity', version: 1 }, blocks: [{ thoughtSignature: 'signed-thought' }, { thoughtSignature: 'signed-call' }] } }, content: [
      { type: 'reasoning', text: 'Thinking' }, { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' },
    ] },
    { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: '[1,2]' }] },
  ]
  const body = toAntigravityRequest({ model: 'gemini-3.7-flash-tiered', system: 'Caller instructions', reasoningEffort: 'high', tools: [{ name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] }, messages, 'fixture-project', true)
  assert.equal(body.request.systemInstruction.parts[0].text, 'Caller instructions')
  assert.deepEqual(body.request.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' })
  assert.equal(body.request.contents[0].parts[1].inlineData.data, 'AQID')
  assert.equal(body.request.contents[1].parts[0].thoughtSignature, 'signed-thought')
  assert.equal(body.request.contents[1].parts[1].thoughtSignature, 'signed-call')
  assert.deepEqual(body.request.contents[2].parts[0].functionResponse, { id: 'call-1', name: 'lookup', response: { output: [1, 2] } })
})

const sse = frames => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')).body
test('Flash Image advertises Minimal/High and sends thinkingLevel without a token budget', async () => {
  const model = 'gemini-3.1-flash-image'
  const adapter = new AntigravityAdapter({ models: [{ id: model }], discovery: false, tokens: {}, streamIdleTimeoutMs: 1000 })
  const info = await adapter.resolveModel('antigravity', model)
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['minimal', 'high'])
  assert.equal(toAntigravityRequest({ model }, [], 'project').request.generationConfig.thinkingConfig, undefined)
  for (const effort of ['minimal', 'high']) {
    const config = toAntigravityRequest({ model, reasoningEffort: effort }, [], 'project').request.generationConfig
    assert.deepEqual(config.thinkingConfig, { thinkingLevel: effort.toUpperCase(), includeThoughts: true })
    assert.deepEqual(config.responseModalities, ['TEXT', 'IMAGE'])
  }
  for (const effort of ['off', 'low', 'medium']) {
    assert.throws(() => toAntigravityRequest({ model, reasoningEffort: effort }, [], 'project'), /does not support reasoning effort/)
  }
})
test('image models request image output without functions and store streamed image blocks with replay signatures', async () => {
  const body = toAntigravityRequest({ model: 'gemini-3.1-flash-image', tools: [{ name: 'unused', parameters: {} }] }, [], 'project')
  assert.deepEqual(body.request.generationConfig.responseModalities, ['TEXT', 'IMAGE'])
  assert.equal(body.request.tools, undefined)
  const ref = { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const saved = []
  const store = { imageLimits: { maxImageBytes: 100, maxMessageImageBytes: 200, maxImagesPerMessage: 2 }, saveImage: async input => { saved.push(input); return ref } }
  const event = { response: { candidates: [{ content: { parts: [{ text: 'Before' }, { inlineData: { mimeType: 'image/png', data: 'AQID' }, thoughtSignature: 'image-signature' }, { text: 'After' }] }, finishReason: 'STOP' }] } }
  const chunks = await Array.fromAsync(streamAntigravity(sse([event]), undefined, store))
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.type), ['text', 'image', 'text'])
  assert.equal(chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'image').block.attachment, ref)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(chunks.at(-1).replayState.blocks[1].thoughtSignature, 'image-signature')
  assert.deepEqual([...saved[0].data], [1, 2, 3])
  const replay = toAntigravityRequest({ model: 'gemini-3.1-flash-image' }, [{ role: 'assistant', source: { kind: 'model', provider: 'antigravity', model: 'gemini-3.1-flash-image', replayState: chunks.at(-1).replayState }, content: [{ type: 'text', text: 'Before' }, { type: 'image', mediaType: 'image/png', dataBase64: 'AQID' }] }], 'project')
  assert.equal(replay.request.contents[0].parts[1].thoughtSignature, 'image-signature')
  const imageOnly = { response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }] }, finishReason: 'STOP' }] } }
  assert.equal((await parseAntigravityResponse(imageOnly, store)).at(-1).reason.kind, 'stop')
  await assert.rejects(parseAntigravityResponse(imageOnly), /attachment service/)
  await assert.rejects(parseAntigravityResponse(imageOnly, { ...store, imageLimits: { ...store.imageLimits, maxMessageImageBytes: 2 } }), /attachment limits/)
})
test('Antigravity SSE exposes tool results, usage, replay signatures and transport failures', async () => {
  const chunks = await Array.fromAsync(streamAntigravity(sse([
    { response: { candidates: [{ content: { parts: [{ text: 'Reason', thought: true }, { thoughtSignature: 'signed', thought: true }] } }] } },
    { candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'call-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, cachedContentTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2 } },
  ])))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.equal(chunks.at(-1).replayState.blocks[0].thoughtSignature, 'signed')
  assert.equal(chunks.at(-1).replayState.blocks[1].thoughtSignature, 'call-signature')
  assert.equal(chunks.find(chunk => chunk.type === 'usage').usage.inputTokens, 15)
  await assert.rejects(Array.fromAsync(streamAntigravity(sse([{ error: { message: 'Quota exceeded', code: 429 } }]))), error => error.code === 'RATE_LIMIT')
  await assert.rejects(Array.fromAsync(streamAntigravity(sse([{ response: { candidates: [{ content: { parts: [{ text: 'unfinished' }] } }] } }]))), /ended before a finish/)
})

test('Antigravity refreshes once on 401 and retries the same account request', async () => {
  const refreshes = []
  const requests = []
  const adapter = new AntigravityAdapter({
    models: [], discovery: false, streamIdleTimeoutMs: 1000,
    tokens: { session: async (account, force) => { refreshes.push([account, force]); return { ...session, accessToken: force ? 'refreshed' : session.accessToken } } },
    fetchFn: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      return requests.length === 1 ? new Response('', { status: 401 }) : new Response(sse([{ response: { candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] } }]))
    },
  })
  const chunks = await Array.fromAsync(adapter.streamAccount({ provider: 'antigravity', model: 'gemini-fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }, 'account-a'))
  assert.deepEqual(refreshes, [['account-a', undefined], ['account-a', true]])
  assert.equal(requests[1].headers.authorization, 'Bearer refreshed')
  assert.equal(requests[1].body.project, 'fixture-project')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('OAuth client defaults work offline and preserve local and explicit configurations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-antigravity-client-'))
  const envKeys = ['DSH_HOME', 'ANTIGRAVITY_CLIENT_ID', 'ANTIGRAVITY_CLIENT_SECRET', 'NOAGY_CLIENT_ID', 'NOAGY_CLIENT_SECRET']
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  process.env.DSH_HOME = home
  const path = join(home, 'plugins', 'subscriptions', 'antigravity-oauth-client.json')
  try {
    const defaults = resolveAntigravityOAuthConfig()
    assert.ok(defaults.clientId && defaults.clientSecret)
    await assert.rejects(readFile(path), { code: 'ENOENT' })
    await preserveAntigravityClient(oauth)
    assert.deepEqual(resolveAntigravityOAuthConfig(), oauth)
    assert.deepEqual(resolveAntigravityOAuthConfig({ clientId: 'configured' }), { clientId: 'configured' })
    assert.throws(() => resolveAntigravityOAuthConfig({ clientSecret: 'orphan' }), /requires clientId/)
    process.env.ANTIGRAVITY_CLIENT_ID = 'environment'
    assert.deepEqual(resolveAntigravityOAuthConfig(), { clientId: 'environment' })
    delete process.env.ANTIGRAVITY_CLIENT_ID
    await writeFile(path, '{broken')
    assert.throws(() => resolveAntigravityOAuthConfig(), /Invalid local/)
  } finally {
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
    await rm(home, { recursive: true, force: true })
  }
})
