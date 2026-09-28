import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMcpExpressApp } from '../extensions/pione/node_modules/@modelcontextprotocol/sdk/dist/esm/server/express.js';
import { McpServer } from '../extensions/pione/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StreamableHTTPServerTransport } from '../extensions/pione/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js';
import { z } from '../extensions/pione/node_modules/zod/index.js';
import { registerMcp } from '../extensions/pione/mcp.ts';
import { connectServer, validateConfig } from '../extensions/pione/mcp-client.ts';
import { visibleWidth } from '../extensions/pione/node_modules/@earendil-works/pi-tui/dist/index.js';

function simulation(defaultServers = [], remoteNames = { alpha: 'search', beta: 'lookup' }, connectionHook = () => {}) {
  const handlers = new Map(), commands = new Map(), tools = new Map();
  const branch = [], messages = [], calls = [], closed = [];
  let active = ['bash'], footer, renderCount = 0;
  const connections = [];
  const names = remoteNames;
  const config = { servers: { alpha: { command: 'fake' }, beta: { command: 'fake' } }, defaultServers };
  const pi = {
    on: (name, fn) => { handlers.set(name, fn); },
    registerTool: tool => { tools.set(tool.name, tool); },
    registerCommand: (name, cmd) => commands.set(name, cmd),
    getActiveTools: () => [...active], getAllTools: () => [...tools.values()],
    setActiveTools: names => { active = [...names]; },
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
    sendMessage: (message, options) => { messages.push({ message, options }); branch.push({ type: 'message', message: { role: 'custom', ...message } }); },
  };
  const ctx = { mode: 'tui', model: { id: 'test-model', contextWindow: 10000 },
    getContextUsage: () => ({ percent: 25, contextWindow: 10000 }),
    sessionManager: { getBranch: () => branch, getEntries: () => branch, getCwd: () => process.cwd(), getSessionName: () => undefined },
    ui: { notify: (text, level) => messages.push({ text, level }),
      setFooter: factory => { footer?.dispose(); footer = factory({ requestRender: () => renderCount++ },
        { fg: (_color, text) => text }, { getGitBranch: () => undefined, getExtensionStatuses: () => new Map(),
          onBranchChange: () => () => {} }); } },
    waitForIdle: async () => {} };
  registerMcp(pi, { config: async () => config, connect: async spec => {
    const server = Object.entries(config.servers).find(([, s]) => s === spec)[0];
    const conn = { tools: (Array.isArray(names[server]) ? names[server] : [names[server]]).map(name => ({ name, description: `tool for ${server}`,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } })), 
    call: async (name, args) => { calls.push({ server, name, args }); return { content: [{ type: 'text', text: `${server}:${args.query}` }] }; },
    isHealthy: () => true,
    close: async () => closed.push(server) };
    connectionHook(conn, server, connections.length);
    connections.push(conn);
    return conn;
  } });
  const fire = (name, event = {}) => handlers.get(name)(event, ctx);
  const run = (arg) => commands.get('mcp').handler(arg, ctx);
  return { fire, run, pi, ctx, branch, messages, calls, closed, tools, connections,
    get footer() { return footer; }, get renderCount() { return renderCount; }, get active() { return active; } };
}

const user = text => ({ type: 'message', message: { role: 'user', content: text } });

test('compact footer omits costs and tracks selected MCP servers across commands, branches and resumes', async () => {
  const s = simulation(['alpha']);
  await s.fire('session_start');
  s.branch.push({ type: 'message', message: { role: 'assistant', usage: { input: 120, output: 30,
    cost: { total: 99 } } } });
  assert.match(s.footer.render(100)[1], /MCP:1 ↑120 ↓30/);
  assert(!s.footer.render(100).join(' ').includes('$'));
  assert.equal(s.footer.render(8).every(line => visibleWidth(line) <= 8), true);
  assert.match(s.footer.render(8)[1], /MCP:1/);
  s.branch.push(user('work'));
  const before = s.renderCount;
  await s.run('on beta');
  assert(s.renderCount > before);
  assert.match(s.footer.render(100)[1], /MCP:2/);
  s.branch.splice(0, s.branch.length, user('other branch'));
  await s.fire('session_tree');
  assert.match(s.footer.render(100)[1], /MCP:0/);
  await s.fire('session_start');
  assert.match(s.footer.render(100)[1], /MCP:0/);
});

test('initial selection is a real tool; late selection is described once at the tail, promoted only after successful compaction', async () => {
  const s = simulation(['alpha']);
  await s.fire('session_start');
  assert(s.active.includes('pione_mcp_alpha_search'));
  assert(!s.active.includes('pione_mcp_beta_lookup'));
  assert.equal(s.messages.filter(x => x.message).length, 0);
  s.branch.push(user('work'));
  await s.run('on beta');
  assert(s.active.includes('pione_mcp_call'));
  assert(!s.active.includes('pione_mcp_beta_lookup'));
  assert.equal(s.messages.filter(x => x.message).length, 1);
  assert.match(s.messages.find(x => x.message).message.content, /"required":\["query"\]/);
  assert.equal(s.messages.find(x => x.message).options.triggerTurn, false);
  await s.run('on beta');
  assert.equal(s.messages.filter(x => x.message).length, 1);
  const bridge = s.tools.get('pione_mcp_call');
  const args = { tool: 'pione_mcp_beta_lookup', arguments: { query: 'hi' } };
  assert.equal((await bridge.execute('id', args)).content[0].text, 'beta:hi');
  await assert.rejects(bridge.execute('id', { ...args, tool: 'pione_mcp_alpha_search' }), /not enabled/);
  assert.equal(s.calls.length, 1);
  // A failed or cancelled compaction emits no session_compact.
  assert(!s.active.includes('pione_mcp_beta_lookup'));
  await s.fire('session_compact');
  assert(s.active.includes('pione_mcp_beta_lookup'));
  assert.deepEqual(s.tools.get('pione_mcp_beta_lookup').parameters.required, ['query']);
  assert.equal((await s.tools.get('pione_mcp_beta_lookup').execute('id', { query: 'x' })).content[0].text, 'beta:x');
  await assert.rejects(bridge.execute('id', args), /not enabled/);
  const transcript = s.branch.filter(e => e.type === 'message').map(e => e.message);
  assert.equal(s.fire('context', { messages: transcript }).messages.some(m => m.customType === 'pione:mcp-tools'), false);
  assert.equal(s.branch.filter(e => e.type === 'custom' && e.data.server === 'beta').length, 2);
  await s.fire('session_shutdown');
  assert.deepEqual(s.closed.sort(), ['alpha', 'beta']);
});

test('after compaction, request-only Chrome tools move into the prompt head, not earlier turns', async () => {
  const s = simulation(['alpha']);
  await s.fire('session_start');
  s.branch.push(user('already working'));
  await s.run('on beta');
  const base = { role: 'system', content: '', sections: { preamble: 'keep me' },
    toolsAdded: [{ name: 'bash', description: 'base' }, { name: 'pione_mcp_call', description: 'bridge' }] };
  const announcement = s.branch.find(e => e.message?.customType === 'pione:mcp-tools').message;
  const before = [base, { role: 'assistant', content: [{ type: 'text', text: 'previous turn' }] }, announcement, { role: 'user', content: 'next turn' }];
  assert.equal(s.fire('context_with_system', { messages: before }), undefined);
  assert.deepEqual(base.toolsAdded.map(t => t.name), ['bash', 'pione_mcp_call']);
  // Pi appends its compaction entry before emitting session_compact.
  s.branch.push({ type: 'compaction' });
  await s.fire('session_compact');
  const promoted = { name: 'pione_mcp_beta_lookup', description: 'MCP tool',
    parameters: s.tools.get('pione_mcp_beta_lookup').parameters };
  const other = { name: 'another_extension_tool', description: 'not ours' };
  const update = { role: 'system', content: '', sections: { docs: 'keep other extension changes' },
    toolsAdded: [promoted, other] };
  const after = [base, { role: 'compactionSummary', summary: 'history' }, { role: 'assistant', content: [] }, update,
    { role: 'user', content: 'new task' }];
  const original = JSON.stringify(after);
  const { messages: rebased } = s.fire('context_with_system', { messages: after });
  assert.deepEqual(rebased[0].toolsAdded.map(t => t.name), ['bash', 'pione_mcp_call', promoted.name]);
  assert.deepEqual(rebased[3].toolsAdded, [other]);
  assert.deepEqual(rebased[3].sections, update.sections);
  assert.deepEqual(rebased.slice(1).filter(m => m.role !== 'system'), after.slice(1).filter(m => m.role !== 'system'));
  assert.equal(JSON.stringify(after), original, 'persisted transcript must not be mutated');
  assert.equal(s.fire('context_with_system', { messages: rebased }), undefined, 'idempotent request transform');
  await s.fire('session_shutdown');
  await s.fire('session_start');
  assert(s.fire('context_with_system', { messages: after }).messages[0].toolsAdded.some(t => t.name === promoted.name),
    'resumed sessions still rebase the system delta');
  await s.fire('session_shutdown');
});

test('pre-first-turn selection, resumed session, and branch switching restore only branch-local selections', async () => {
  const s = simulation();
  await s.fire('session_start');
  await s.run('on beta');
  assert(s.active.includes('pione_mcp_beta_lookup'));
  assert.equal(s.messages.filter(x => x.message).length, 0);
  const original = [...s.branch];
  s.branch.splice(0, s.branch.length, user('other branch'));
  await s.fire('session_tree');
  assert(!s.active.includes('pione_mcp_beta_lookup'));
  await assert.rejects(s.tools.get('pione_mcp_beta_lookup').execute('id', { query: 'no' }), /not active/);
  s.branch.splice(0, s.branch.length, ...original);
  await s.fire('session_tree');
  assert(s.active.includes('pione_mcp_beta_lookup'));
  await s.fire('session_shutdown');
  await s.fire('session_start'); // same persisted branch, new session runtime
  assert(s.active.includes('pione_mcp_beta_lookup'));
});

test('a removed server in an old session cannot be reactivated or leak its announcement', async () => {
  const s = simulation();
  s.branch.push({ type: 'custom', customType: 'pione:mcp-selection', data: {
    server: 'obsolete', stage: 'late', fingerprint: '[]',
  } });
  const message = { role: 'custom', customType: 'pione:mcp-tools', details: { server: 'obsolete' }, content: 'old tools' };
  s.branch.push({ type: 'message', message });
  await s.fire('session_start');
  assert.equal(s.connections.length, 0);
  assert.equal(s.fire('context', { messages: [message] }).messages.length, 0);
  assert(!s.messages.some(m => m.level === 'error'));
});

test('changed remote schemas on resume fail closed rather than exposing stale descriptors', async () => {
  const remoteNames = { alpha: 'search', beta: 'lookup' };
  const s = simulation([], remoteNames);
  await s.fire('session_start');
  s.branch.push(user('started'));
  await s.run('on beta');
  remoteNames.beta = 'new_tool';
  await s.fire('session_shutdown');
  await s.fire('session_start');
  assert(!s.active.includes('pione_mcp_beta_lookup'));
  assert(s.messages.some(m => m.level === 'error' && m.text.includes('schemas changed')));
  const transcript = s.branch.filter(e => e.type === 'message').map(e => e.message);
  assert.equal(s.fire('context', { messages: transcript }).messages.some(m => m.customType === 'pione:mcp-tools'), false);
});

test('real stdio MCP initialize/list/call/close against a simulated server', async () => {
  const conn = await connectServer({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-stdio.mjs', import.meta.url))] });
  try {
    assert.equal(conn.tools[0].name, 'echo');
    assert.equal((await conn.call('echo', { text: 'ping' })).content[0].text, 'ping');
  } finally { await conn.close(); }
});

test('timed-out server is closed, queued calls fail, and a new connection works', async () => {
  const spec = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-stdio.mjs', import.meta.url))], callTimeoutMs: 100 };
  const conn = await connectServer(spec);
  const pending = conn.call('echo', { text: 'hang' });
  const queued = conn.call('echo', { text: 'queued' });
  await assert.rejects(pending, /connection was reset/);
  await assert.rejects(queued, /connection was reset/);
  assert.equal(conn.isHealthy(), false);
  await conn.close();
  const fresh = await connectServer(spec);
  try { assert.equal((await fresh.call('echo', { text: 'ready' })).content[0].text, 'ready'); }
  finally { await fresh.close(); }
});

test('bridge transparently reconnects after a timeout without serving stale tools', async () => {
  let healthy = true;
  const s = simulation([], undefined, (conn, server, index) => {
    if (server !== 'beta' || index !== 0) return;
    conn.isHealthy = () => healthy;
    conn.call = async () => { healthy = false; throw new Error('connection was reset'); };
  });
  await s.fire('session_start');
  s.branch.push(user('work'));
  await s.run('on beta');
  const bridge = s.tools.get('pione_mcp_call');
  const args = { tool: 'pione_mcp_beta_lookup', arguments: { query: 'ok' } };
  await assert.rejects(bridge.execute('id', args), /connection was reset/);
  assert.equal((await bridge.execute('id', args)).content[0].text, 'beta:ok');
  assert.equal(s.connections.length, 2);
  assert(s.closed.includes('beta'));
});

test('Streamable HTTP MCP: auth header, initialize, tools/list, tool call and cleanup', async () => {
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  app.post('/mcp', async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture') { res.status(401).end(); return; }
    const server = new McpServer({ name: 'http-fixture', version: '1.0.0' });
    server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) =>
      ({ content: [{ type: 'text', text }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.once('close', () => { void server.close(); });
  });
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${listener.address().port}/mcp`;
  try {
    await assert.rejects(connectServer({ transport: 'http', url }), /Streamable HTTP error/);
    const conn = await connectServer({ transport: 'http', url, headers: { Authorization: 'Bearer fixture' } });
    try {
      assert.equal(conn.tools[0].name, 'echo');
      assert.equal((await conn.call('echo', { text: 'HTTP OK' })).content[0].text, 'HTTP OK');
    } finally { await conn.close(); }
  } finally { await new Promise(resolve => listener.close(resolve)); }
});

test('invalid config and colliding remote names fail closed', async () => {
  assert.throws(() => validateConfig({ servers: { 'bad name': { command: 'echo' } } }));
  assert.throws(() => validateConfig({ servers: {}, defaultServers: ['missing'] }));
  assert.throws(() => validateConfig({ servers: { bad: { transport: 'http', url: 'http://evil.example/mcp' } } }), /HTTPS or loopback/);
  assert.throws(() => validateConfig({ servers: { bad: { transport: 'http', url: 'http://127.0.0.1/mcp', command: 'oops' } } }));
  assert.doesNotThrow(() => validateConfig({ servers: { good: { transport: 'http', url: 'http://127.0.0.1/mcp' } } }));
  const s = simulation();
  await s.fire('session_start');
  // Reject a collision with another extension's registered tool.
  const bad = simulation(['alpha']);
  // Simulate a server that returns an unsupported tool name via the test connector.
  bad.pi.getAllTools = () => [{ name: 'pione_mcp_alpha_search' }];
  await bad.fire('session_start');
  assert(!bad.active.includes('pione_mcp_alpha_search'));
  assert.deepEqual(bad.closed, ['alpha']);
  assert(bad.messages.some(m => m.level === 'error'));
  await s.run('on unknown');
  assert(!s.branch.some(e => e.type === 'custom'));
  assert(s.messages.some(m => m.level === 'error'));
  const same = simulation(['alpha'], { alpha: ['a-b', 'a_b'], beta: 'lookup' });
  await same.fire('session_start');
  assert(!same.active.includes('pione_mcp_alpha_a_b'));
  assert.deepEqual(same.closed, ['alpha']);
});
