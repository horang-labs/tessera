/**
 * Output (assistant -> user language) translation.
 *
 * Two entry points:
 *  - maybeTranslateAssistantMessage: fired after every turn (next to auto-title) when
 *    auto-translation is enabled. Translates the finalized assistant message once.
 *  - translateAssistantMessageById: on-demand (per-message "translate" button). Works
 *    regardless of the enabled toggle and re-translates even if a translation exists.
 *
 * Both emit an append-only `message_translation` replay event. sendReplayEvent both
 * persists (via the server's recordTransportMessage tap) and delivers to the client,
 * so one call does both. Fire-and-forget, fail-soft.
 */

import { sessionHistory } from '@/lib/session-history';
import { SettingsManager } from '@/lib/settings/manager';
import { translateMessageText, type TranslateModelConfig } from '@/lib/session/message-translator';
import logger from '@/lib/logger';
import type { SessionReplayEvent } from '@/lib/session-replay-types';

const EVENT_VERSION = 1;
const FILE_RETRY_COUNT = 3;
const FILE_RETRY_INTERVAL_MS = 5_000;

type SendReplayEvent = (userId: string, sessionId: string, event: SessionReplayEvent) => void;

interface MaybeTranslateAssistantMessageArgs {
  /** Per-process exactly-once guard, keyed `${sessionId}:${messageId}`. */
  translationTriggered: Set<string>;
  sendReplayEvent: SendReplayEvent;
  sessionId: string;
  userId: string;
}

interface TranslateAssistantMessageByIdArgs {
  translationTriggered: Set<string>;
  sendReplayEvent: SendReplayEvent;
  sessionId: string;
  userId: string;
  messageId: string;
}

interface FinalizedAssistantMessage {
  messageId: string;
  content: string;
}

/** Output direction: agent's working language -> user's language. */
function outputLangs(translate: { sourceLanguage: string; targetLanguage: string }): {
  sourceLang: string;
  targetLang: string;
} {
  return { sourceLang: translate.targetLanguage, targetLang: translate.sourceLanguage };
}

/**
 * Read the last assistant_message (content + stable messageId) from history, retrying
 * for JSONL write lag like ai-title-generator. Returns null if a translation already
 * exists for that message (durable, restart-safe dedup) or none is found.
 */
async function readFinalizedAssistantMessage(
  sessionId: string,
): Promise<FinalizedAssistantMessage | null> {
  for (let attempt = 0; attempt <= FILE_RETRY_COUNT; attempt++) {
    sessionHistory.flushSession(sessionId);
    const events = await sessionHistory.readEvents(sessionId);

    let found: FinalizedAssistantMessage | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'assistant_message' && event.content && event.messageId) {
        found = { messageId: event.messageId, content: event.content };
        break;
      }
    }

    if (found) {
      const alreadyTranslated = events.some(
        (e) => e.type === 'message_translation' && e.targetMessageId === found!.messageId,
      );
      if (alreadyTranslated) return null;
      return found;
    }

    if (attempt < FILE_RETRY_COUNT) {
      await new Promise((r) => setTimeout(r, FILE_RETRY_INTERVAL_MS));
    }
  }
  return null;
}

/** Read a specific assistant_message's content by its stable messageId. */
async function readAssistantMessageById(sessionId: string, messageId: string): Promise<string | null> {
  sessionHistory.flushSession(sessionId);
  const events = await sessionHistory.readEvents(sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'assistant_message' && event.messageId === messageId && event.content) {
      return event.content;
    }
  }
  return null;
}

/**
 * Translate one message's content and emit pending -> completed/error replay events.
 * Returns true on success.
 */
async function performTranslation(args: {
  sendReplayEvent: SendReplayEvent;
  sessionId: string;
  userId: string;
  messageId: string;
  content: string;
  sourceLang: string;
  targetLang: string;
  output: TranslateModelConfig;
  promptTemplate?: string;
}): Promise<boolean> {
  const { sendReplayEvent, sessionId, userId, messageId, content, sourceLang, targetLang, output, promptTemplate } = args;
  const base = {
    v: EVENT_VERSION,
    type: 'message_translation' as const,
    targetMessageId: messageId,
    sourceLang,
    targetLang,
  };

  // Live-only "translating…" indicator (not persisted).
  sendReplayEvent(userId, sessionId, { ...base, timestamp: new Date().toISOString(), status: 'pending' });

  const translated = await translateMessageText(content, sourceLang, targetLang, output, userId, promptTemplate);
  if (!translated) {
    sendReplayEvent(userId, sessionId, { ...base, timestamp: new Date().toISOString(), status: 'error' });
    return false;
  }

  sendReplayEvent(userId, sessionId, {
    ...base,
    timestamp: new Date().toISOString(),
    content: translated,
    status: 'completed',
  });
  return true;
}

/**
 * Auto path: translate the finalized assistant message after a turn, if enabled.
 */
export function maybeTranslateAssistantMessage({
  translationTriggered,
  sendReplayEvent,
  sessionId,
  userId,
}: MaybeTranslateAssistantMessageArgs): void {
  void (async () => {
    try {
      const settings = await SettingsManager.load(userId);
      const translate = settings.translate;
      if (!translate?.enabled) {
        return;
      }

      const { sourceLang, targetLang } = outputLangs(translate);
      if (!targetLang || sourceLang === targetLang) {
        return;
      }

      const finalized = await readFinalizedAssistantMessage(sessionId);
      if (!finalized) {
        return;
      }

      const { messageId, content } = finalized;
      const dedupKey = `${sessionId}:${messageId}`;
      if (translationTriggered.has(dedupKey)) {
        return;
      }
      translationTriggered.add(dedupKey);

      const ok = await performTranslation({
        sendReplayEvent, sessionId, userId, messageId, content, sourceLang, targetLang, output: translate.output, promptTemplate: translate.promptTemplate,
      });
      if (!ok) {
        // Fail-soft: allow a later manual retry.
        translationTriggered.delete(dedupKey);
        return;
      }
      logger.info({ sessionId, messageId, sourceLang, targetLang }, 'Translated assistant message');
    } catch (error: any) {
      logger.warn({ sessionId, error: error?.message }, 'Output translation failed');
    }
  })();
}

/**
 * On-demand path: translate a specific assistant message by id (manual button).
 * Ignores the enabled toggle and always (re-)translates.
 */
export function translateAssistantMessageById({
  translationTriggered,
  sendReplayEvent,
  sessionId,
  userId,
  messageId,
}: TranslateAssistantMessageByIdArgs): void {
  void (async () => {
    try {
      const settings = await SettingsManager.load(userId);
      const translate = settings.translate;
      if (!translate) {
        return;
      }

      const { sourceLang, targetLang } = outputLangs(translate);
      if (!targetLang || sourceLang === targetLang) {
        return;
      }

      const content = await readAssistantMessageById(sessionId, messageId);
      if (!content) {
        return;
      }

      // Mark as handled so the auto path won't re-translate this message later.
      translationTriggered.add(`${sessionId}:${messageId}`);

      const ok = await performTranslation({
        sendReplayEvent, sessionId, userId, messageId, content, sourceLang, targetLang, output: translate.output, promptTemplate: translate.promptTemplate,
      });
      logger.info({ sessionId, messageId, ok }, 'On-demand message translation');
    } catch (error: any) {
      logger.warn({ sessionId, messageId, error: error?.message }, 'On-demand translation failed');
    }
  })();
}
