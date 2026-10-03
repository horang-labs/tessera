import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalChatComposer } from '../src/components/chat/terminal-chat-composer';
import { applySessionInputOwnership } from '../src/lib/automation/client-state';
import { useChatStore } from '../src/stores/chat-store';
import { i18n } from '../src/lib/i18n';
import { useTerminalSessionStore } from '../src/stores/terminal-session-store';

function renderComposer(sessionId: string, isSinglePanel: boolean) {
  // SSR consumes the hydration snapshot: seed it with the same saved draft as the client.
  const initial = useChatStore.getInitialState();
  const drafts = initial.draftInputs;
  const terminalInitial = useTerminalSessionStore.getInitialState();
  const sessions = terminalInitial.bySessionId;
  initial.draftInputs = useChatStore.getState().draftInputs;
  terminalInitial.bySessionId = useTerminalSessionStore.getState().bySessionId;
  try {
    return renderToStaticMarkup(createElement(TerminalChatComposer, { sessionId, isSinglePanel, onInterrupt() {} }));
  } finally {
    initial.draftInputs = drafts;
    terminalInitial.bySessionId = sessions;
  }
}

function status(html: string) {
  const caption = html.match(/<span[^>]*role="status"[^>]*>(.*?)<\/span><\/span>/s)?.[1];
  assert.ok(caption, 'composer exposes its live status');
  return caption;
}

function sendButton(html: string) {
  const button = html.match(/<button[^>]*data-testid="terminal-chat-composer-send"[^>]*>/)?.[0];
  assert.ok(button, 'composer exposes Send');
  return button;
}

test('released human input keeps its draft and Send while the shared composer advertises human ownership', async () => {
  const language = i18n.language;
  await i18n.changeLanguage('en');
  const sessionId = 'composer-released';
  try {
    useChatStore.getState().setDraftInput(sessionId, 'Retained human draft');
    applySessionInputOwnership({ sessionId, terminalId: 'terminal', epoch: 'released', mode: 'human',
      automationId: null, runId: null, reason: null });
    for (const isSinglePanel of [false, true]) {
      const html = renderComposer(sessionId, isSinglePanel);
      assert.match(status(html), /Human input available/);
      assert.doesNotMatch(status(html), /lucide-lock|view only/i);
      assert.match(html, />Retained human draft<\/textarea>/);
      assert.doesNotMatch(html, /readonly=""/i);
      assert.doesNotMatch(sendButton(html), /disabled/);
    }
  } finally {
    useChatStore.getState().setDraftInput(sessionId, '');
    await i18n.changeLanguage(language);
  }
});

test('working human-owned composer reports work without claiming view-only and retains Escape capability', async () => {
  const language = i18n.language;
  await i18n.changeLanguage('en');
  const sessionId = 'composer-working';
  try {
    useChatStore.getState().setDraftInput(sessionId, 'Next instruction');
    applySessionInputOwnership({ sessionId, terminalId: 'terminal', epoch: 'working', mode: 'human',
      automationId: null, runId: null, reason: null });
    useTerminalSessionStore.getState().applySessionState({ type: 'session_state', sessionId, terminalId: 'terminal',
      status: 'running', hookEvent: 'UserPromptSubmit', interruptInputPolicy: 'single-escape' });
    for (const isSinglePanel of [false, true]) {
      const html = renderComposer(sessionId, isSinglePanel);
      assert.match(status(html), /Working in the terminal/);
      assert.doesNotMatch(status(html), /view only|Human input available/);
      assert.match(html, /data-testid="terminal-chat-cancel"/);
      assert.doesNotMatch(html, /readonly=""/i);
      assert.match(html, />Next instruction<\/textarea>/);
      assert.doesNotMatch(sendButton(html), /disabled/);
    }
  } finally {
    useTerminalSessionStore.getState().clearSession(sessionId);
    useChatStore.getState().setDraftInput(sessionId, '');
    await i18n.changeLanguage(language);
  }
});

test('localized shared composer captions agree with held gates, working capability and native approval', async () => {
  const language = i18n.language;
  const sessionId = 'composer-localized-states';
  const copy = {
    en: ['Human input available', 'Automation owns input', 'Draining — input locked', 'Delivery uncertain — input locked', 'Input ownership unavailable — read-only', 'Working in the terminal', 'Waiting for input in the terminal'],
    ko: ['직접 입력 가능', '자동화가 입력 전담', '기존 입력 처리 중 — 입력 잠김', '전달 여부 불명 — 입력 잠김', '입력 소유권 확인 불가 — 읽기 전용', '터미널에서 작업 중', '터미널에서 입력을 기다리는 중'],
    ja: ['手動入力できます', '自動化が入力を管理中', '入力処理の完了待ち — 入力ロック', '送信結果不明 — 入力ロック', '入力の所有状態を確認できません — 閲覧のみ', 'ターミナルで作業中', 'ターミナルで入力を待機中'],
    zh: ['可手动输入', '自动化正在控制输入', '正在等待输入处理完成 — 输入已锁定', '发送结果不确定 — 输入已锁定', '无法确认输入控制权 — 只读', '正在终端中工作', '正在终端中等待输入'],
  };
  const cases = [
    { mode: 'human', lifecycle: 'idle', copy: 0, blocked: false, cancel: false },
    { mode: 'armed', lifecycle: 'idle', copy: 1, blocked: true, cancel: false },
    { mode: 'draining', lifecycle: 'idle', copy: 2, blocked: true, cancel: false },
    { mode: 'recovery-required', lifecycle: 'idle', copy: 3, blocked: true, cancel: false },
    { mode: 'unavailable', lifecycle: 'idle', copy: 4, blocked: true, cancel: false },
    { mode: 'human', lifecycle: 'running', copy: 5, blocked: false, cancel: true },
    { mode: 'armed', lifecycle: 'running', copy: 5, blocked: true, cancel: false },
    { mode: 'human', lifecycle: 'input_required', copy: 6, blocked: true, cancel: false },
    { mode: 'draining', lifecycle: 'input_required', copy: 6, blocked: true, cancel: false },
  ] as const;
  try {
    useChatStore.getState().setDraftInput(sessionId, 'Retained state-check draft');
    for (const [locale, labels] of Object.entries(copy)) {
      await i18n.changeLanguage(locale);
      for (const state of cases) {
        applySessionInputOwnership({ sessionId, terminalId: 'terminal', epoch: `${locale}-${state.mode}`, mode: state.mode,
          automationId: state.mode === 'human' ? null : 'rule', runId: null, reason: null });
        useTerminalSessionStore.getState().applySessionState({ type: 'session_state', sessionId, terminalId: 'terminal',
          status: state.lifecycle, hookEvent: 'fixture', interruptInputPolicy: 'single-escape' });
        for (const isSinglePanel of [false, true]) {
          const html = renderComposer(sessionId, isSinglePanel);
          assert.ok(status(html).includes(labels[state.copy]), `${locale}: ${state.mode}/${state.lifecycle} caption`);
          assert.equal(/readonly=""/i.test(html), state.blocked);
          assert.equal(/disabled/.test(sendButton(html)), state.blocked);
          assert.equal(/data-testid="terminal-chat-cancel"/.test(html), state.cancel);
          assert.match(html, />Retained state-check draft<\/textarea>/);
          if (state.lifecycle === 'idle') assert.equal(/lucide-lock/.test(status(html)), state.blocked);
        }
      }
    }
  } finally {
    useTerminalSessionStore.getState().clearSession(sessionId);
    useChatStore.getState().setDraftInput(sessionId, '');
    await i18n.changeLanguage(language);
  }
});

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
