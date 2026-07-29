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
import { restoreSessionReplay } from './restore-session-replay';

const REFRESH_DEBOUNCE_MS = 300;
/** Mirrors INITIAL_PAGE_SIZE in use-session-navigation. */
const MIN_REFRESH_LIMIT = 25;
const MAX_REFRESH_LIMIT = 500;

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
/** Sessions whose transcript changed again while a refresh was still running. */
const restaleWhileInFlight = new Set<string>();

/** True only while this session is actually being shown as a read-only chat. */
function isLiveTerminalChatView(sessionId: string): boolean {
  if (useTerminalViewModeStore.getState().modeBySession[sessionId] !== 'chat') {
    return false;
  }
  const session = useSessionStore.getState().getSession(sessionId);
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

    restoreSessionReplay(sessionId, result);
    const session = useSessionStore.getState().getSession(sessionId);
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
