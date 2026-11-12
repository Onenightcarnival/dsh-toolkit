import test from 'node:test'
import assert from 'node:assert/strict'
import { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { HTTP_GUIDANCE, HTTP_SECTION } from '../src/index.ts'

test('the guidance section renders as literal text', () => {
  assert.match(HTTP_GUIDANCE, /\{\{/)
  const assembly = { sections: [{ ...HTTP_SECTION }], contexts: [], variables: {} } as unknown as PromptAssembly
  assert.equal(renderPrompt(assembly), HTTP_GUIDANCE)
})
