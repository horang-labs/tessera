import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildOpenCodeHookPluginSource } from '@/lib/terminal/opencode-hook-plugin';
import { createOpenCodeOverlay } from '@/lib/terminal/opencode-overlay';

type OpenCodeEventHook = (input: { event: unknown }) => Promise<void>;

interface LoadedPlugin {
  event: OpenCodeEventHook;
  payloads: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  restore: () => void;
}

async function loadPlugin(options: {
  resumeId?: string;
  rejectFirstPost?: boolean;
} = {}): Promise<LoadedPlugin> {
  const previous = {
    hookPort: process.env.TESSERA_HOOK_PORT,
    paneToken: process.env.TESSERA_PANE_TOKEN,
    sessionId: process.env.TESSERA_SESSION_ID,
    resumeId: process.env.TESSERA_OPENCODE_RESUME_ID,
    fetch: globalThis.fetch,
  };
  process.env.TESSERA_HOOK_PORT = '43210';
  process.env.TESSERA_PANE_TOKEN = 'pane-token';
  process.env.TESSERA_SESSION_ID = 'tessera-session';
  if (options.resumeId) process.env.TESSERA_OPENCODE_RESUME_ID = options.resumeId;
  else delete process.env.TESSERA_OPENCODE_RESUME_ID;

  const payloads: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  let attempt = 0;
  globalThis.fetch = async (_input, init) => {
    attempt += 1;
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    attempts.push(payload);
    if (options.rejectFirstPost && attempt === 1) throw new Error('temporary failure');
    payloads.push(payload);
    return new Response(null, { status: 204 });
  };

  const source = buildOpenCodeHookPluginSource();
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}-${Math.random()}`;
  const pluginModule = await import(url) as {
    TesseraLifecyclePlugin: (input: { directory: string }) => Promise<{ event: OpenCodeEventHook }>;
  };
  const plugin = await pluginModule.TesseraLifecyclePlugin({ directory: '/workspace' });

  return {
    event: plugin.event,
    payloads,
    attempts,
    restore: () => {
      if (previous.hookPort === undefined) delete process.env.TESSERA_HOOK_PORT;
      else process.env.TESSERA_HOOK_PORT = previous.hookPort;
      if (previous.paneToken === undefined) delete process.env.TESSERA_PANE_TOKEN;
      else process.env.TESSERA_PANE_TOKEN = previous.paneToken;
      if (previous.sessionId === undefined) delete process.env.TESSERA_SESSION_ID;
      else process.env.TESSERA_SESSION_ID = previous.sessionId;
      if (previous.resumeId === undefined) delete process.env.TESSERA_OPENCODE_RESUME_ID;
      else process.env.TESSERA_OPENCODE_RESUME_ID = previous.resumeId;
      globalThis.fetch = previous.fetch;
    },
  };
}

async function settlePosts(expectedCount: number, payloads: unknown[]): Promise<void> {
  for (let i = 0; i < 50 && payloads.length < expectedCount; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(payloads.length, expectedCount);
}

test('new OpenCode turn emits Start, canonical prompt, and Stop once', async () => {
  const plugin = await loadPlugin();
  try {
    await plugin.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_child', parentID: 'ses_target', directory: '/workspace' } },
      },
    });
    await plugin.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_target', directory: '/workspace' } },
      },
    });
    // Duplicate creation and a foreign session must not change the target.
    await plugin.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_target', directory: '/workspace' } },
      },
    });
    // busy can arrive before the text part; the later part must still emit Prompt before Stop.
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'msg-1', sessionID: 'ses_target', role: 'user' } },
      },
    });
    await plugin.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_target', status: { type: 'busy' } } },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { id: 'part-1', messageID: 'msg-1', sessionID: 'ses_target', type: 'text', text: 'final prompt' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { id: 'part-1', messageID: 'msg-1', sessionID: 'ses_target', type: 'text', text: 'final prompt' } },
      },
    });
    await plugin.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_foreign', status: { type: 'busy' } } },
    });
    await plugin.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_target', status: { type: 'busy' } } },
    });
    await plugin.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_target', status: { type: 'idle' } } },
    });
    await plugin.event({
      event: { type: 'session.idle', properties: { sessionID: 'ses_target' } },
    });

    await settlePosts(3, plugin.payloads);
    assert.deepEqual(plugin.payloads, [
      { hook_event_name: 'SessionStart', session_id: 'ses_target' },
      { hook_event_name: 'UserPromptSubmit', session_id: 'ses_target', prompt: 'final prompt' },
      { hook_event_name: 'Stop', session_id: 'ses_target' },
    ]);
  } finally {
    plugin.restore();
  }
});

test('resume targets the saved session and keeps processing after a failed POST', async () => {
  const plugin = await loadPlugin({ resumeId: 'ses_resume', rejectFirstPost: true });
  try {
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'foreign-message', sessionID: 'ses_foreign', role: 'user' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'resume-message', sessionID: 'ses_resume', role: 'user' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { id: 'resume-part', messageID: 'resume-message', sessionID: 'ses_resume', type: 'text', text: 'resume prompt' } },
      },
    });
    await plugin.event({
      event: { type: 'session.idle', properties: { sessionID: 'ses_resume' } },
    });

    await settlePosts(3, plugin.payloads);
    assert.deepEqual(plugin.payloads.map((payload) => payload.hook_event_name), [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
    ]);
    assert.ok(plugin.payloads.every((payload) => payload.session_id === 'ses_resume'));
    assert.deepEqual(plugin.attempts.map((payload) => payload.hook_event_name), [
      'SessionStart',
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
    ]);
  } finally {
    plugin.restore();
  }
});

test('OpenCode native fork switches the invocation target and emits the child lifecycle', async () => {
  const plugin = await loadPlugin({ resumeId: 'ses_parent' });
  try {
    await settlePosts(1, plugin.payloads);
    await plugin.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_fork', directory: '/workspace' } },
      },
    });
    await settlePosts(2, plugin.payloads);
    assert.deepEqual(plugin.payloads[1], {
      hook_event_name: 'SessionStart',
      session_id: 'ses_fork',
    });
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'fork-message', sessionID: 'ses_fork', role: 'user' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { id: 'fork-part', messageID: 'fork-message', sessionID: 'ses_fork', type: 'text', text: 'fork prompt' } },
      },
    });
    await plugin.event({
      event: { type: 'session.idle', properties: { sessionID: 'ses_fork' } },
    });

    await settlePosts(4, plugin.payloads);
    assert.deepEqual(plugin.payloads.slice(1), [
      { hook_event_name: 'SessionStart', session_id: 'ses_fork' },
      { hook_event_name: 'UserPromptSubmit', session_id: 'ses_fork', prompt: 'fork prompt' },
      { hook_event_name: 'Stop', session_id: 'ses_fork' },
    ]);
  } finally {
    plugin.restore();
  }
});

test('OpenCode waits for all real text parts and ignores synthetic expansion text', async () => {
  const plugin = await loadPlugin();
  try {
    await plugin.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_target', directory: '/workspace' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'msg-1', sessionID: 'ses_target', role: 'user' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { id: 'part-1', messageID: 'msg-1', sessionID: 'ses_target', type: 'text', text: 'first' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { id: 'part-synthetic', messageID: 'msg-1', sessionID: 'ses_target', type: 'text', text: 'expanded file', synthetic: true } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { id: 'part-2', messageID: 'msg-1', sessionID: 'ses_target', type: 'text', text: 'second' } },
      },
    });
    await plugin.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_target', status: { type: 'idle' } } },
    });

    await settlePosts(3, plugin.payloads);
    assert.deepEqual(plugin.payloads, [
      { hook_event_name: 'SessionStart', session_id: 'ses_target' },
      { hook_event_name: 'UserPromptSubmit', session_id: 'ses_target', prompt: 'first\nsecond' },
      { hook_event_name: 'Stop', session_id: 'ses_target' },
    ]);
  } finally {
    plugin.restore();
  }
});

test('OpenCode completes a real busy turn even when prompt text parts are missed', async () => {
  const plugin = await loadPlugin({ resumeId: 'ses_resume' });
  try {
    await settlePosts(1, plugin.payloads);
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'msg-missed-parts', sessionID: 'ses_resume', role: 'user' } },
      },
    });
    await plugin.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_resume', status: { type: 'busy' } } },
    });
    await plugin.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_resume', status: { type: 'idle' } } },
    });

    await settlePosts(2, plugin.payloads);
    assert.deepEqual(plugin.payloads[1], {
      hook_event_name: 'Stop',
      session_id: 'ses_resume',
    });
  } finally {
    plugin.restore();
  }
});

test('OpenCode does not emit Stop for background busy and tolerates idle before the final part', async () => {
  const plugin = await loadPlugin({ resumeId: 'ses_resume' });
  try {
    await plugin.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_resume', status: { type: 'busy' } } },
    });
    await plugin.event({
      event: { type: 'session.status', properties: { sessionID: 'ses_resume', status: { type: 'idle' } } },
    });
    await settlePosts(1, plugin.payloads);
    assert.deepEqual(plugin.payloads, [
      { hook_event_name: 'SessionStart', session_id: 'ses_resume' },
    ]);

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'msg-late', sessionID: 'ses_resume', role: 'user' } },
      },
    });
    const idle = plugin.event({
      event: { type: 'session.idle', properties: { sessionID: 'ses_resume' } },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { id: 'late-part', messageID: 'msg-late', sessionID: 'ses_resume', type: 'text', text: 'late prompt' } },
      },
    });
    await idle;

    await settlePosts(3, plugin.payloads);
    assert.deepEqual(plugin.payloads.slice(1), [
      { hook_event_name: 'UserPromptSubmit', session_id: 'ses_resume', prompt: 'late prompt' },
      { hook_event_name: 'Stop', session_id: 'ses_resume' },
    ]);
  } finally {
    plugin.restore();
  }
});

test('OpenCode invocation overlay contains only the Tessera plugin and cleans up idempotently', () => {
  const overlay = createOpenCodeOverlay(`terminal-${Date.now()}`);
  const pluginPath = `${overlay.configDir}/plugins/tessera-lifecycle.js`;
  assert.equal(fs.existsSync(pluginPath), true);
  assert.match(fs.readFileSync(pluginPath, 'utf8'), /TesseraLifecyclePlugin/);

  overlay.dispose();
  overlay.dispose();
  assert.equal(fs.existsSync(overlay.configDir), false);
});
