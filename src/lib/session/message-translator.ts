/**
 * Message Translator
 *
 * Builds a one-shot translation prompt → delegates to a caller-supplied CLI
 * provider's translateText() → returns the raw translated text.
 *
 * Provider-agnostic AND session-decoupled: translation uses a caller-supplied
 * provider + model config, NOT the coding session's provider, so the language
 * the user reads/writes is independent of the agent driving the session.
 */

import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import { buildTranslatePrompt, extractTranslation } from '@/lib/session/translate-prompt';
import logger from '@/lib/logger';

/**
 * Caller-supplied provider + model used for the one-shot translation call.
 * Decoupled from the coding session's provider.
 */
export interface TranslateModelConfig {
  provider: string;
  model?: string;
}

/**
 * Translate a single piece of text using a caller-supplied provider + model.
 *
 * Fail-open: returns null (rather than throwing) on missing config, unsupported
 * provider, or any provider error, so callers can fall back to the original text.
 *
 * @param text - The text to translate.
 * @param sourceLang - Source language code (e.g. "ko").
 * @param targetLang - Target language code (e.g. "en").
 * @param cfg - Caller-supplied provider + optional model override.
 * @param userId - Passed through to provider-specific translation.
 * @param promptTemplate - Optional user-configured prompt template (placeholders
 *   {{source}}/{{target}}/{{text}}); falls back to the built-in default when blank.
 */
export async function translateMessageText(
  text: string,
  sourceLang: string,
  targetLang: string,
  cfg: TranslateModelConfig,
  userId?: string,
  promptTemplate?: string,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const providerId = cfg.provider?.trim();
  if (!providerId) {
    return null;
  }

  if (sourceLang === targetLang) {
    return null;
  }

  let provider;
  try {
    provider = cliProviderRegistry.getProvider(providerId);
  } catch (error) {
    logger.warn({ providerId, error }, 'Translation: unknown provider');
    return null;
  }

  if (typeof provider.translateText !== 'function') {
    logger.warn({ providerId }, 'Translation: provider does not support translateText');
    return null;
  }

  const model = cfg.model && cfg.model.trim() ? cfg.model.trim() : undefined;
  const prompt = buildTranslatePrompt(trimmed, sourceLang, targetLang, promptTemplate);

  try {
    const result = await provider.translateText(prompt, userId, model);
    if (!result || !result.text) {
      return null;
    }
    return extractTranslation(result.text);
  } catch (error) {
    logger.warn({ providerId, sourceLang, targetLang, error }, 'Translation failed');
    return null;
  }
}
