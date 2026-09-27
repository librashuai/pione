import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerMcp } from '../extensions/pione/mcp.ts';
import { loadConfig } from '../extensions/pione/mcp-client.ts';

// Run with PIONE_CHROME_MCP_TEST=1 node --test test/chrome-stdio.test.mjs
// Uses the same local pione-mcp.json and stdio process that Pi uses; no HTTP proxy.
test('pione bridge fetches official Pi website through Chrome DevTools stdio MCP',
  { skip: process.env.PIONE_CHROME_MCP_TEST !== '1' }, async () => {
  const config = await loadConfig(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'));
  assert.equal(config.servers.chrome?.transport ?? 'stdio', 'stdio');
  assert.equal(typeof config.servers.chrome.command, 'string');
  const handlers = new Map(), commands = new Map(), tools = new Map();
  const branch = [{ type: 'message', message: { role: 'user', content: 'Check pi.dev' } }];
  let active = [];
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => active, setActiveTools: names => { active = names; },
    getAllTools: () => [...tools.values()],
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
    sendMessage: message => branch.push({ type: 'message', message: { role: 'custom', ...message } }),
  };
  const ctx = {
    sessionManager: { getBranch: () => branch }, ui: { notify: (text, severity) => {
      if (severity === 'error') throw new Error(text);
    } }, waitForIdle: async () => {},
  };
  registerMcp(pi, { config: async () => config });
  await handlers.get('session_start')({}, ctx);
  try {
    await commands.get('mcp').handler('on chrome', ctx); // After first user message: late bridge stage.
    assert(active.includes('pione_mcp_call'));
    assert(!active.includes('pione_mcp_chrome_navigate'));
    const bridge = tools.get('pione_mcp_call');
    const navigate = await bridge.execute('1', { tool: 'pione_mcp_chrome_navigate', arguments: { url: 'https://pi.dev' } });
    assert.match(navigate.content[0].text, /pi\.dev/i);
    const evaluated = await bridge.execute('2', { tool: 'pione_mcp_chrome_evaluate', arguments: {
      script: '({title:document.title,heading:document.querySelector("h1")?.innerText,text:document.body.innerText.slice(0,300)})',
    } });
    const page = JSON.parse(evaluated.content[0].text);
    assert.equal(page.title, 'Pi');
    assert.match(page.heading + page.text, /agent harness/i);
    console.log(`Pi website via Chrome stdio MCP: ${page.title} — ${page.heading}`);
  } finally { await handlers.get('session_shutdown')({}, ctx); }
});
