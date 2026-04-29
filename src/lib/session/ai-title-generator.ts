/**
 * AI Title Generator
 *
 * Reads Tessera's own session-history JSONL → builds prompt →
 * delegates to the active CLI provider's generateTitle() → returns { title }.
 *
 * Provider-agnostic: works with any CLI (Claude Code, Codex, Gemini, etc.)
 * because it reads from the Tessera's canonical history, not CLI-specific JSONL.
 */

import { sessionHistory } from '@/lib/session-history';
import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';

const MAX_MESSAGES = 20;
const MAX_CHARS_PER_MESSAGE = 500;
const FILE_RETRY_COUNT = 3;
const FILE_RETRY_INTERVAL_MS = 5_000;

/** Track in-flight generation to prevent concurrent calls for the same session */
const generatingSet = new Set<string>();

export interface GeneratedTitle {
  title: string;
}

/**
 * Extract user and assistant text from Tessera's session-history JSONL.
 * Event types: 'user_message' (content: string | ContentBlock[]),
 *              'assistant_message' (content: string).
 */
async function extractConversation(sessionId: string): Promise<string[]> {
  // Flush in-memory buffer so the last assistant message is included
  sessionHistory.flushSession(sessionId);
  const events = await sessionHistory.readEvents(sessionId);
  const messages: string[] = [];

  for (const event of events) {
    if (event.type === 'user_message') {
      let text = '';
      if (typeof event.content === 'string') {
        text = event.content;
      } else if (Array.isArray(event.content)) {
        text = event.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join(' ');
      }
      if (text) {
        messages.push(`[USER] ${text.slice(0, MAX_CHARS_PER_MESSAGE)}`);
      }
    } else if (event.type === 'assistant_message') {
      const text = typeof event.content === 'string' ? event.content : '';
      if (text) {
        messages.push(`[ASSISTANT] ${text.slice(0, MAX_CHARS_PER_MESSAGE)}`);
      }
    }
  }

  return messages.slice(-MAX_MESSAGES);
}

/**
 * Build the prompt for title generation.
 */
function buildPrompt(conversation: string[]): string {
  const numbered = conversation.map((line, i) => `  ${i + 1}. ${line}`).join('\n');
  return `Read the following conversation log and generate a JSON title.

CONVERSATION LOG:
${numbered}
END OF LOG.

Based on the log above, output a single JSON object with:
- "title": concise summary, max 30 chars, same language as the conversation

IMPORTANT: Output ONLY the JSON object. No explanation, no markdown, no conversation reply.
{"title":"Fix login bug"}`;
}

/**
 * Generate a title for a session using AI.
 * Reads conversation from Tessera session-history, delegates to the active
 * CLI provider's generateTitle(), returns a title.
 *
 * @param sessionId - The session to generate a title for.
 * @param userId - Passed through to provider-specific title generation.
 */
export async function generateAITitle(sessionId: string, userId: string): Promise<GeneratedTitle> {
  if (generatingSet.has(sessionId)) {
    throw new Error('Title generation already in progress for this session');
  }

  generatingSet.add(sessionId);
  try {
    const t0 = Date.now();

    // Wait for session-history JSONL to be written (first result may arrive after a small delay)
    let conversation: string[] = [];
    for (let attempt = 0; attempt <= FILE_RETRY_COUNT; attempt++) {
      conversation = await extractConversation(sessionId);
      if (conversation.length > 0) break;
      if (attempt < FILE_RETRY_COUNT) {
        logger.info({ sessionId }, `Conversation empty, retrying (${attempt + 1}/${FILE_RETRY_COUNT})...`);
        await new Promise((r) => setTimeout(r, FILE_RETRY_INTERVAL_MS));
      }
    }
    if (conversation.length === 0) {
      throw new Error('No conversation messages found');
    }
    const t1 = Date.now();

    const prompt = buildPrompt(conversation);
    logger.info({ sessionId, messageCount: conversation.length }, 'Generating AI title');

    const session = dbSessions.getSession(sessionId);
    const providerId = session?.provider?.trim();
    if (!providerId) {
      throw new Error(`Cannot generate title for session '${sessionId}' without a provider`);
    }
    const provider = cliProviderRegistry.getProvider(providerId);

    const result = await provider.generateTitle(prompt, userId);

    const t2 = Date.now();

    if (!result) {
      throw new Error(`Title generation failed for provider '${providerId}'`);
    }

    logger.info(
      { sessionId, title: result.title, providerId },
      `AI title generated (extract=${t1 - t0}ms cli=${t2 - t1}ms total=${t2 - t0}ms)`,
    );

    return result;
  } finally {
    generatingSet.delete(sessionId);
  }
}
