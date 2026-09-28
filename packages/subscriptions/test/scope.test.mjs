import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('subscription sources and bundle exclude unrelated providers and OAuth registrations', async () => {
  const root = fileURLToPath(new URL('../src/backend', import.meta.url))
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.ts'))
  const forbiddenProvider = /\b(?:claude|grok|copilot|antigravity|x_search|video_generate)\b/i
  const oauthRegistration = /GOCSPX-[\w-]+|\d+-[\w-]+\.apps\.googleusercontent\.com/
  for (const file of files) {
    const source = await readFile(join(root, file), 'utf8')
    // Boolean assertions deliberately avoid printing a matched credential.
    assert.equal(forbiddenProvider.test(file + '\n' + source), false, `Unrelated provider in ${file}`)
    assert.equal(oauthRegistration.test(source), false, `Unrelated OAuth registration in ${file}`)
  }
  const bundle = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(forbiddenProvider.test(bundle), false, 'Bundle contains an unrelated provider')
  assert.equal(oauthRegistration.test(bundle), false, 'Bundle contains an unrelated OAuth registration')
})
