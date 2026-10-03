import assert from 'node:assert/strict';
import test from 'node:test';
import type { NativeRuntimeIdentity } from '@/lib/automation/activation-contracts';
import { TerminalHeadlessModel } from '@/lib/terminal/terminal-headless-model';
import { observeNativePrompt } from '@/lib/cli/providers/native-pty-prompt';

const identity: NativeRuntimeIdentity = { userId: 'owner', sessionId: 'worker', agentEnvironment: 'wsl',
  serverInstanceId: 'server', terminalId: 'terminal', generation: 1, provider: 'codex',
  providerConversationId: 'conversation', inputRevision: 0, observationRevision: 4 };

// rust-v0.159.2 chat_composer.rs: enabled prefix bold; empty placeholder dim.
// Native QA e8ac screenshot004 independently showed this empty composer/footer.
const codexReady = '\x1b[2J\x1b[4;1H\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m'
  + '\x1b[6;1H? for shortcuts\x1b[4;3H';

test('a fresh native Codex empty prompt is usable without an earlier worker turn', async () => {
  const model = new TerminalHeadlessModel(80, 12);
  try {
    model.write(codexReady); await model.whenSettled();
    const result = observeNativePrompt(identity, '0.159.2', model.readNativePromptFrame());
    assert.equal(result.kind, 'ready');
    if (result.kind === 'ready') assert.equal(result.empty, true);
  } finally { model.dispose(); }
});

test('native drafts veto bootstrap and unsupported versions do not write', async () => {
  const model = new TerminalHeadlessModel(80, 12);
  try {
    model.write(codexReady + '\x1b[4;3H\x1b[0mmy unsent draft\x1b[K'); await model.whenSettled();
    assert.equal(observeNativePrompt(identity, '0.159.2', model.readNativePromptFrame()).kind, 'draft');
    assert.equal(observeNativePrompt(identity, '0.160.0', model.readNativePromptFrame()).kind, 'unknown');
  } finally { model.dispose(); }
});

test('Claude fresh and restored empty composer use the pinned prompt, not prior completion', async () => {
  const model = new TerminalHeadlessModel(80, 12);
  try {
    // Shape of archived actual 2.1.284 ready screenshot036; parsed attributes await packaged QA.
    model.write('\x1b[3;1H' + '─'.repeat(80) + '\x1b[4;1H❯ \x1b[2mTry "fix lint errors"\x1b[0m'
      + '\x1b[5;1H' + '─'.repeat(80) + '\x1b[4;3H'); await model.whenSettled();
    for (const providerConversationId of [null, 'restored']) {
      assert.equal(observeNativePrompt({ ...identity, provider: 'claude-code', providerConversationId },
        '2.1.284', model.readNativePromptFrame()).kind, 'ready');
    }
  } finally { model.dispose(); }
});
