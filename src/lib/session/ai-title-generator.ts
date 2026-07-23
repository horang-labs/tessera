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
import { generateSessionTitle } from '@/lib/session/title-generator';

const MAX_MESSAGES = 20;
const MAX_CHARS_PER_MESSAGE = 500;
const FILE_RETRY_COUNT = 3;
const FILE_RETRY_INTERVAL_MS = 5_000;

/** Track in-flight generation to prevent concurrent calls for the same session */
const generatingSet = new Set<string>();

export interface GeneratedTitle {
  title: string;
  /** True when provider output failed and the first user message supplied the title. */
  fallback?: boolean;
}

interface GenerateAITitleOptions {
  fallbackToFirstUserMessage?: boolean;
}

interface ConversationExcerpt {
  messages: string[];
  firstUserMessage: string | null;
}

/**
 * Extract user and assistant text from Tessera's session-history JSONL.
 * Event types: 'user_message' (content: string | ContentBlock[]),
 *              'assistant_message' (content: string).
 */
async function extractConversation(sessionId: string): Promise<ConversationExcerpt> {
  // Flush in-memory buffer so the last assistant message is included
  sessionHistory.flushSession(sessionId);
  const events = await sessionHistory.readEvents(sessionId);
  const messages: string[] = [];
  let firstUserMessage: string | null = null;

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
        firstUserMessage ??= text;
        messages.push(`[USER] ${text.slice(0, MAX_CHARS_PER_MESSAGE)}`);
      }
    } else if (event.type === 'assistant_message') {
      const text = typeof event.content === 'string' ? event.content : '';
      if (text) {
        messages.push(`[ASSISTANT] ${text.slice(0, MAX_CHARS_PER_MESSAGE)}`);
      }
    }
  }

  return {
    messages: messages.slice(-MAX_MESSAGES),
    firstUserMessage,
  };
}

export function generateFallbackTitle(firstUserMessage: string | null): string | null {
  if (!firstUserMessage) return null;
  const firstLine = firstUserMessage.trim().split(/\r?\n/, 1)[0] ?? '';
  const title = generateSessionTitle(firstUserMessage) || firstLine;
  if (!title) return null;
  return Array.from(title).slice(0, 30).join('');
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
export async function generateAITitle(
  sessionId: string,
  userId: string,
  options: GenerateAITitleOptions = {},
): Promise<GeneratedTitle> {
  if (generatingSet.has(sessionId)) {
    throw new Error('Title generation already in progress for this session');
  }

  generatingSet.add(sessionId);
  try {
    const t0 = Date.now();

    // Wait for session-history JSONL to be written (first result may arrive after a small delay)
    let conversation: ConversationExcerpt = { messages: [], firstUserMessage: null };
    for (let attempt = 0; attempt <= FILE_RETRY_COUNT; attempt++) {
      conversation = await extractConversation(sessionId);
      if (conversation.messages.length > 0) break;
      if (attempt < FILE_RETRY_COUNT) {
        logger.info({ sessionId }, `Conversation empty, retrying (${attempt + 1}/${FILE_RETRY_COUNT})...`);
        await new Promise((r) => setTimeout(r, FILE_RETRY_INTERVAL_MS));
      }
    }
    if (conversation.messages.length === 0) {
      throw new Error('No conversation messages found');
    }
    const t1 = Date.now();

    const prompt = buildPrompt(conversation.messages);
    logger.info({ sessionId, messageCount: conversation.messages.length }, 'Generating AI title');

    const session = dbSessions.getSession(sessionId);
    const providerId = session?.provider?.trim();
    if (!providerId) {
      throw new Error(`Cannot generate title for session '${sessionId}' without a provider`);
    }
    const provider = cliProviderRegistry.getProvider(providerId);

    let result: Awaited<ReturnType<typeof provider.generateTitle>> = null;
    let providerError: unknown;
    try {
      result = await provider.generateTitle(prompt, userId);
    } catch (error) {
      providerError = error;
    }

    const t2 = Date.now();

    const generatedTitle = result?.title.replace(/\s+/g, ' ').trim() ?? '';
    if (!generatedTitle) {
      if (!options.fallbackToFirstUserMessage) {
        if (providerError instanceof Error) throw providerError;
        throw new Error(`Title generation failed for provider '${providerId}'`);
      }

      const fallbackTitle = generateFallbackTitle(conversation.firstUserMessage);
      if (!fallbackTitle) {
        if (providerError instanceof Error) throw providerError;
        throw new Error(`Title generation failed for provider '${providerId}'`);
      }

      logger.warn({
        sessionId,
        providerId,
        error: providerError instanceof Error ? providerError.message : 'Provider returned no title',
        fallbackTitle,
      }, 'AI title generation failed; using deterministic fallback');
      return { title: fallbackTitle, fallback: true };
    }

    const title = Array.from(generatedTitle).slice(0, 30).join('');
    logger.info(
      { sessionId, title, providerId },
      `AI title generated (extract=${t1 - t0}ms cli=${t2 - t1}ms total=${t2 - t0}ms)`,
    );

    return { title };
  } finally {
    generatingSet.delete(sessionId);
  }
}
