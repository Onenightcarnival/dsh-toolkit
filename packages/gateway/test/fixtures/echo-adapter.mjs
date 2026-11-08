// Loaded only by host-smoke.mjs: a provider route `smoke` with one model `echo`.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'gateway-smoke-echo'
export const inject = ['llm']

class EchoAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'Smoke echo' } }
  async listModels(provider) { return [{ provider, id: 'echo', name: 'Echo', inputModalities: ['text'] }] }
  async *stream(options) {
    const last = options.messages[options.messages.length - 1]
    const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: `echo:${text}` }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `echo:${text}` } }
    yield { type: 'usage', usage: { inputTokens: text.length, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['smoke'], new EchoAdapter()), 'gateway smoke: echo adapter')
}
