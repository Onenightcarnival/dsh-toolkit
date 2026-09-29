// Minimal stdio MCP server: answers initialize and tools/list with one tool.
import { createInterface } from 'node:readline'

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } })
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools: [{ name: 'echo', description: 'Echo the input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] })
  } else if (message.method === 'tools/call') {
    reply(message.id, { content: [{ type: 'text', text: String(message.params?.arguments?.text ?? '') }] })
  } else if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
  }
})
