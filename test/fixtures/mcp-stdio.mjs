// Minimal deterministic MCP stdio peer for the real transport smoke test.
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result;
  switch (message.method) {
    case 'initialize': result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }; break;
    case 'tools/list': result = { tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }; break;
    case 'tools/call':
      if (message.params.arguments.text === 'hang') continue; // Never reply: simulates a stuck MCP request.
      result = { content: [{ type: 'text', text: message.params.arguments.text }] }; break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } }) + '\n'); continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
