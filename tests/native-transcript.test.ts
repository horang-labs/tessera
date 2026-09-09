import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseClaudeNativeTranscript } from '@/lib/cli/providers/claude-code/native-transcript';
import { parseCodexNativeTranscript } from '@/lib/cli/providers/codex/native-transcript';
import {
  resolveCodexAccountOverlayPath,
  resolveCodexAccountTranscriptPath,
} from '@/lib/codex-home';
import { wslDisplayPathToWindowsFilesystemPath } from '@/lib/filesystem/path-environment';

function codexMessageLine(role: string, text: string): string {
  return JSON.stringify({
    type: 'response_item',
    timestamp: '2026-07-22T18:06:06.000Z',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
    },
  });
}

test('claude transcript keeps only lead-agent prose', () => {
  const transcript = [
    JSON.stringify({ type: 'mode', mode: 'normal' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '웹에서도 잘되나' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '숨겨진 추론' },
          { type: 'text', text: '확인했습니다' },
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      },
    }),
    // Subagent turn — not part of the conversation the user had.
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'text', text: '서브에이전트' }] },
    }),
    // Tool results ride on `user` lines and carry no prose.
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] },
    }),
  ].join('\n');

  assert.deepEqual(parseClaudeNativeTranscript(transcript), [
    { role: 'user', text: '웹에서도 잘되나' },
    { role: 'assistant', text: '확인했습니다' },
  ]);
});

test('claude transcript survives malformed lines', () => {
  const transcript = [
    'not json',
    '',
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '살아남음' }] } }),
  ].join('\n');

  assert.deepEqual(parseClaudeNativeTranscript(transcript), [
    { role: 'assistant', text: '살아남음' },
  ]);
});

test('codex transcript drops developer turns and injected instructions', () => {
  const transcript = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'abc' } }),
    codexMessageLine('developer', '<permissions instructions> sandboxing...'),
    codexMessageLine('user', '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n# Global Rules\n'),
    codexMessageLine('user', '웹에서 지금 테스트중'),
    codexMessageLine('assistant', '네, 확인했습니다.'),
  ].join('\n');

  assert.deepEqual(parseCodexNativeTranscript(transcript), [
    { role: 'user', text: '웹에서 지금 테스트중' },
    { role: 'assistant', text: '네, 확인했습니다.' },
  ]);
});

test('codex transcript trusts recorded prompts over marker heuristics', () => {
  const transcript = [
    codexMessageLine('user', '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n주입된 내용\n'),
    codexMessageLine('user', 'AGENTS.md 고쳐줘'),
    codexMessageLine('assistant', '네'),
  ].join('\n');

  // A prompt that looks synthetic is still real when Tessera recorded it.
  assert.deepEqual(
    parseCodexNativeTranscript(transcript, { knownUserPrompts: ['AGENTS.md 고쳐줘'] }),
    [
      { role: 'user', text: 'AGENTS.md 고쳐줘' },
      { role: 'assistant', text: '네' },
    ],
  );
});

test('codex rollout path under a removed overlay resolves to the account home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-transcript-'));
  try {
    const relativeParts = ['sessions', '2026', '07', '22', 'rollout-test.jsonl'];
    const accountPath = path.join(root, '.codex', ...relativeParts);
    fs.mkdirSync(path.dirname(accountPath), { recursive: true });
    fs.writeFileSync(accountPath, '');

    // The overlay directory itself is gone — only the recorded path remains.
    const overlayPath = path.join(
      root,
      '.tessera',
      'codex-overlay',
      'session-e0f1',
      ...relativeParts,
    );

    assert.equal(resolveCodexAccountTranscriptPath(overlayPath), accountPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a generated image under a Codex overlay resolves to the account home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-image-'));
  try {
    const relativeParts = ['generated_images', 'thread', 'result.png'];
    const accountPath = path.join(root, '.codex', ...relativeParts);
    fs.mkdirSync(path.dirname(accountPath), { recursive: true });
    fs.writeFileSync(accountPath, 'image');
    const overlayPath = path.join(
      root,
      '.tessera',
      'codex-overlay',
      'session-e0f1',
      ...relativeParts,
    );

    assert.equal(resolveCodexAccountOverlayPath(overlayPath), accountPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex path outside an overlay is returned untouched', () => {
  const plainPath = path.join('/home', 'u', '.codex', 'sessions', 'rollout-plain.jsonl');
  assert.equal(resolveCodexAccountTranscriptPath(plainPath), plainPath);
});

// A Windows-hosted server (packaged Electron) reads transcripts the WSL agent
// reported in guest form; without translation the read fails outright.
const WSL_PATH_INFO = {
  homeDisplayPath: '/home/work',
  homeFilesystemPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work',
  rootFilesystemPath: '\\\\wsl.localhost\\Ubuntu-24.04',
};

test('a guest transcript path becomes the UNC path a Windows host can open', () => {
  assert.equal(
    wslDisplayPathToWindowsFilesystemPath(
      '/home/work/.claude/projects/-home-work-repo/abc.jsonl',
      WSL_PATH_INFO,
    ),
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\.claude\\projects\\-home-work-repo\\abc.jsonl',
  );
});

test('a guest path on a mounted drive maps to the drive letter, not the share', () => {
  assert.equal(
    wslDisplayPathToWindowsFilesystemPath('/mnt/c/Users/work/rollout.jsonl', WSL_PATH_INFO),
    'C:\\Users\\work\\rollout.jsonl',
  );
});
