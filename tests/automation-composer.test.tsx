import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalChatComposer } from '../src/components/chat/terminal-chat-composer';
import { applySessionInputOwnership } from '../src/lib/automation/client-state';
import { useChatStore } from '../src/stores/chat-store';

test('shared panel/Peek composer becomes read-only while armed without discarding the saved Session draft', () => {
  const sessionId = 'composer-automation';
  useChatStore.getState().setDraftInput(sessionId, 'Unsent local draft');
  const ownership = { sessionId, terminalId: 'terminal', epoch: 'armed', mode: 'armed' as const,
    automationId: 'rule', runId: null, reason: null };
  applySessionInputOwnership(ownership);
  const composer = () => renderToStaticMarkup(createElement(TerminalChatComposer, { sessionId, onInterrupt() {} }));
  const armed = composer();
  assert.match(armed, /readonly=""/i);
  assert.equal(useChatStore.getState().getDraftInput(sessionId), 'Unsent local draft');
  applySessionInputOwnership({ ...ownership, mode: 'human', epoch: 'human', automationId: null });
  const remounted = composer();
  assert.equal(useChatStore.getState().getDraftInput(sessionId), 'Unsent local draft');
  assert.doesNotMatch(remounted, /readonly=""/i);
});
