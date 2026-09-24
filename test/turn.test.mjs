import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastTurn, renderTurn } from '../extensions/pione/turn.ts';

const entry = (role, content) => ({ type: 'message', message: { role, content } });

test('uses only the last user turn on the active branch', () => {
  const branch = [entry('user', 'old'), entry('assistant', [{ type: 'text', text: 'old answer' }]),
    entry('user', 'new'), entry('assistant', [
      { type: 'thinking', thinking: 'private' },
      { type: 'toolCall', name: 'bash', arguments: { command: 'pwd' } },
      { type: 'text', text: 'done' },
    ]), { type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'D:/repo' }] } }];
  const md = renderTurn(lastTurn(branch));
  assert.match(md, /## User\n\nnew/);
  assert.match(md, /### Tool call: bash/);
  assert.match(md, /## Tool result: bash/);
  assert.match(md, /done/);
  assert.doesNotMatch(md, /old|private/);
});

test('does not export if there is no user message', () => {
  assert.deepEqual(lastTurn([entry('assistant', [])]), []);
});

test('escapes backticks in tool arguments using a longer fence', () => {
  const md = renderTurn([entry('assistant', [{ type: 'toolCall', name: 'test', arguments: { value: '```' } }])]);
  assert.match(md, /````json\n/);
  assert.match(md, /\n````\n$/);
});
