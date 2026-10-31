// Минимальная локальная JSON-RPC граница для теста, без внешней сети и credentials.
import { createInterface } from 'node:readline'

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  let result
  switch (message.method) {
    case 'initialize': result = { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }; break
    case 'tools/list': result = { tools: [{ name: 'echo', description: 'Local fixture echo', inputSchema: { type: 'object', properties: {} } }] }; break
    case 'tools/call': result = { content: [{ type: 'text', text: 'fixture' }] }; break
    case 'resources/list': result = { resources: [] }; break
    case 'resources/templates/list': result = { resourceTemplates: [] }; break
    case 'ping': result = {}; break
    default:
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown fixture method' } })}\n`)
      continue
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
}
