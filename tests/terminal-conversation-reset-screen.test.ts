import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexScreenShowsConversationReset,
  openCodeScreenShowsConversationReset,
} from '@/lib/terminal/terminal-conversation-reset-screen';

const CODEX_SESSION_ID = '019f89be-ddfb-70f2-b21b-474c42bab15d';

// Captured from codex-cli 0.144.5 right after /clear.
const CODEX_AFTER_RESET = [
  '╭──────────────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.144.5)                           │',
  '│ model:     gpt-5.6-sol low   fast   /model to change │',
  '╰──────────────────────────────────────────────────────╯',
  '  Tip: See the Codex keymap documentation for supported actions and examples.',
  'Token usage: total=7,016 input=7,011 (+ 9,984 cached) output=5',
  `To continue this session, run codex resume ${CODEX_SESSION_ID}`,
  '› Summarize recent commits',
].join('\n');

const CODEX_MID_CONVERSATION = [
  '› reply with exactly: ok',
  '• ok',
  '  gpt-5.6-sol low fast · Context 2% used · Fast on',
].join('\n');

// Captured from opencode 1.14.48 right after /new.
const OPENCODE_AFTER_RESET = [
  '                     ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▄ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
  '  ┃  Ask anything... "Fix a TODO in the codebase"',
  '  ┃  Build · GPT-5.3 Codex Spark OpenAI',
  '                          tab agents  ctrl+p commands',
].join('\n');

const OPENCODE_MID_CONVERSATION = [
  '  > reply with exactly: ok',
  '  ok',
  '  ~/Source/tessera-dev:dev                              1.14.48',
].join('\n');

test('codex resume hint for the bound session marks that conversation closed', () => {
  assert.equal(codexScreenShowsConversationReset({
    visibleText: CODEX_AFTER_RESET,
    currentProviderSessionId: CODEX_SESSION_ID,
  }), true);
});

test('codex mid-conversation screens and other sessions never match', () => {
  assert.equal(codexScreenShowsConversationReset({
    visibleText: CODEX_MID_CONVERSATION,
    currentProviderSessionId: CODEX_SESSION_ID,
  }), false);
  // The hint names some other rollout — this PTY's conversation is untouched.
  assert.equal(codexScreenShowsConversationReset({
    visibleText: CODEX_AFTER_RESET,
    currentProviderSessionId: '019f8998-575d-7e73-8764-eda3aaccd380',
  }), false);
  assert.equal(codexScreenShowsConversationReset({
    visibleText: CODEX_AFTER_RESET,
    currentProviderSessionId: '',
  }), false);
});

test('opencode home screen after a bound conversation marks it reset', () => {
  assert.equal(openCodeScreenShowsConversationReset({
    visibleText: OPENCODE_AFTER_RESET,
    currentProviderSessionId: 'ses_07676a371ffebpi3WHDsyiiNJc',
  }), true);
  assert.equal(openCodeScreenShowsConversationReset({
    visibleText: OPENCODE_MID_CONVERSATION,
    currentProviderSessionId: 'ses_07676a371ffebpi3WHDsyiiNJc',
  }), false);
});

test('no bound provider session means there is nothing to fork away from', () => {
  assert.equal(openCodeScreenShowsConversationReset({
    visibleText: OPENCODE_AFTER_RESET,
    currentProviderSessionId: '',
  }), false);
});
