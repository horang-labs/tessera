'use client';

/**
 * Keeps the read-only chat view of a PTY session in step with the terminal.
 *
 * The conversation lives in the provider's transcript, not in Tessera's stream,
 * so nothing pushes new messages to the chat view while the agent works in the
 * terminal. Every PTY lifecycle hook already arrives as a `session_state`
 * message, which is exactly "something changed in this session" — so we re-read
 * the transcript on that signal instead of watching the file.
 *
 * Refreshes are debounced: a single turn fires many hooks (PreToolUse,
 * PostToolUse, Stop), and each would otherwise re-decode the whole transcript.
 * The server side is already cheap — its cache keys on transcript mtime, so an
 * unchanged file costs nothing.
 */

import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useTerminalViewModeStore } from '@/stores/terminal-view-mode-store';
import { supportsTerminalChatView } from '@/lib/terminal/terminal-chat-view-support';
import type { EnhancedMessage } from '@/types/chat';
import { restoreSessionReplay } from './restore-session-replay';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';

const REFRESH_DEBOUNCE_MS = 300;
/** Mirrors INITIAL_PAGE_SIZE in use-session-navigation. */
const MIN_REFRESH_LIMIT = 25;
const MAX_REFRESH_LIMIT = 500;

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
/** Sessions whose transcript changed again while a refresh was still running. */
const restaleWhileInFlight = new Set<string>();

/**
 * Messages sent from the chat view that the transcript has not caught up to yet.
 *
 * Agents flush their transcript on turn boundaries, not on receipt — Codex was
 * measured taking ~35s to record a prompt. Hooks, meanwhile, fire immediately.
 * So the first refresh after a send returns a transcript that predates the
 * message, and replacing the list wholesale would make the user's own message
 * vanish until the turn ends. These are re-appended after every refresh and
 * dropped as soon as the transcript actually contains them.
 */
const pendingSends = new Map<string, EnhancedMessage[]>();

/** Stops a send from lingering forever if its turn never lands in the transcript. */
const PENDING_SEND_TTL_MS = 10 * 60_000;

function normalizeForMatch(content: unknown): string {
  return typeof content === 'string' ? content.trim() : '';
}

/**
 * Drops optimistic sends once a newer canonical user turn contains the text the
 * chat overlay pasted. The PTY may already hold a draft, so the provider can
 * record `draft + sent text` rather than the sent text verbatim.
 *
 * Canonical messages are consumed one-to-one so one transcript turn cannot
 * accidentally confirm several queued sends with the same suffix.
 */
export function reconcilePendingTerminalChatMessages(
  pendingMessages: EnhancedMessage[],
  serverMessages: EnhancedMessage[],
): EnhancedMessage[] {
  const unmatchedServerUserMessages = serverMessages.filter(
    (message) => message.type === 'text' && message.role === 'user',
  );

  return pendingMessages.filter((pendingMessage) => {
    const pendingText = normalizeForMatch(
      (pendingMessage as { content?: unknown }).content,
    );
    const pendingTimestamp = Date.parse(pendingMessage.timestamp);
    if (!pendingText || !Number.isFinite(pendingTimestamp)) return true;

    const matchIndex = unmatchedServerUserMessages.findIndex((serverMessage) => {
      const serverText = normalizeForMatch(
        (serverMessage as { content?: unknown }).content,
      );
      const serverTimestamp = Date.parse(serverMessage.timestamp);
      return Number.isFinite(serverTimestamp)
        && serverTimestamp >= pendingTimestamp
        && (serverText === pendingText || serverText.endsWith(pendingText));
    });

    if (matchIndex === -1) return true;
    unmatchedServerUserMessages.splice(matchIndex, 1);
    return false;
  });
}

/**
 * Registers a message the user just sent to the PTY and shows it immediately.
 * The chat view has no stream of its own, so without this the send appears to
 * do nothing until the agent finishes its turn.
 */
export function registerPendingTerminalChatMessage(
  sessionId: string,
  text: string,
  submittedAt: string,
): void {
  const message: EnhancedMessage = {
    id: `terminal-chat-pending-${Date.now()}`,
    type: 'text',
    role: 'user',
    content: text,
    timestamp: submittedAt,
  };

  const queue = pendingSends.get(sessionId) ?? [];
  queue.push(message);
  pendingSends.set(sessionId, queue);
  useChatStore.getState().addMessage(sessionId, message);

  setTimeout(() => {
    const current = pendingSends.get(sessionId);
    if (!current) return;
    const remaining = current.filter((entry) => entry !== message);
    if (remaining.length) pendingSends.set(sessionId, remaining);
    else pendingSends.delete(sessionId);
  }, PENDING_SEND_TTL_MS).unref?.();
}

/**
 * Appends still-unconfirmed sends to a freshly read transcript. A pending entry
 * is dropped once reconciliation finds its canonical user turn in the server's
 * list.
 */
function mergePendingMessages(
  sessionId: string,
  serverMessages: EnhancedMessage[],
): EnhancedMessage[] {
  const queue = pendingSends.get(sessionId);
  if (!queue?.length) return serverMessages;

  const stillPending = reconcilePendingTerminalChatMessages(queue, serverMessages);

  if (stillPending.length) pendingSends.set(sessionId, stillPending);
  else pendingSends.delete(sessionId);

  return stillPending.length ? [...serverMessages, ...stillPending] : serverMessages;
}

/** True only while this session is actually being shown as a read-only chat. */
function isLiveTerminalChatView(sessionId: string): boolean {
  if (useTerminalViewModeStore.getState().modeBySession[sessionId] !== 'chat') {
    return false;
  }
  const session = projectViewWorkspaceState.resolveSession(sessionId);
  return !!session
    && session.kind === 'terminal'
    && supportsTerminalChatView(session.provider);
}

/**
 * Keep the page as large as what the user has already scrolled into view, so a
 * refresh never silently drops older messages they had loaded.
 */
function resolveRefreshLimit(sessionId: string): number {
  const loaded = useChatStore.getState().messages.get(sessionId)?.length ?? 0;
  return Math.min(MAX_REFRESH_LIMIT, Math.max(MIN_REFRESH_LIMIT, loaded));
}

async function refreshTerminalChat(sessionId: string): Promise<void> {
  if (!isLiveTerminalChatView(sessionId)) return;

  if (inFlight.has(sessionId)) {
    restaleWhileInFlight.add(sessionId);
    return;
  }
  inFlight.add(sessionId);

  try {
    const params = new URLSearchParams({ limit: String(resolveRefreshLimit(sessionId)) });
    const response = await fetch(`/api/sessions/${sessionId}/messages?${params}`);
    if (!response.ok) return;

    const result = await response.json();
    // The view may have been switched back to the terminal (or the session
    // closed) while the request was in flight — don't clobber whatever replaced it.
    if (!isLiveTerminalChatView(sessionId)) return;

    restoreSessionReplay(sessionId, {
      ...result,
      messages: mergePendingMessages(sessionId, result.messages ?? []),
    });
    const session = projectViewWorkspaceState.resolveSession(sessionId);
    if (result.pagination && session) {
      useChatStore.getState().setReadOnlyPagination(sessionId, {
        projectDir: session.projectDir,
        hasMore: result.pagination.hasMore,
        nextBeforeBytes: result.pagination.nextBeforeBytes,
      });
    }
  } catch {
    // A failed refresh just leaves the previous snapshot on screen; the next
    // hook retries. Never surface this as a session error.
  } finally {
    inFlight.delete(sessionId);
    if (restaleWhileInFlight.delete(sessionId)) {
      scheduleTerminalChatRefresh(sessionId);
    }
  }
}

/**
 * Ask for a refresh of this session's read-only chat. Cheap and safe to call on
 * every hook — it returns immediately unless the session is currently on screen
 * as a chat view.
 */
export function scheduleTerminalChatRefresh(sessionId: string): void {
  if (!sessionId || !isLiveTerminalChatView(sessionId)) return;

  const existing = pendingTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  pendingTimers.set(
    sessionId,
    setTimeout(() => {
      pendingTimers.delete(sessionId);
      void refreshTerminalChat(sessionId);
    }, REFRESH_DEBOUNCE_MS),
  );
}

/** Drops any queued refresh, e.g. when switching back to the terminal surface. */
export function cancelTerminalChatRefresh(sessionId: string): void {
  const existing = pendingTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(sessionId);
  }
  restaleWhileInFlight.delete(sessionId);
}
