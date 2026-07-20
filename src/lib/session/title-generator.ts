/**
 * Session Title Generator
 *
 * Generates concise, deterministic session titles from the first user message.
 * This path must stay synchronous so a useful title appears as soon as a prompt
 * is sent, without waiting for a provider or model response.
 */

const TITLE_SCAN_LIMIT = 512;
const TITLE_MAX_LENGTH = 40;

const PROMPT_FILLER_PATTERNS = [
  /^(?:can|could|would|will) you (?:please )?/iu,
  /^please\s+/iu,
  /^help me(?:\s+to)?\s+/iu,
  /^i (?:want|need) you to\s+/iu,
];

/**
 * Generate a session title from a user message.
 *
 * The first request clause is cleaned and capped at a word boundary. Bang
 * commands retain their existing shortcut behavior.
 */
export function generateSessionTitle(message: string): string {
  const cleaned = message.trim();

  if (!cleaned) {
    return '';
  }

  if (cleaned.startsWith('!')) {
    const commandMatch = cleaned.match(/^!(\S+)/);
    if (commandMatch) {
      return sanitizeTitle(commandMatch[1]);
    }
  }

  let candidate = takeCodePointPrefix(cleaned, TITLE_SCAN_LIMIT);

  // Keep Markdown link labels, then remove destinations and standalone URLs.
  candidate = candidate.replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1');
  const hadUrl = /(?:https?:\/\/|www\.)[^\s;!?]+/iu.test(candidate);
  candidate = candidate.replace(/(?:https?:\/\/|www\.)[^\s;!?]+/giu, ' ');

  // A short first clause reads more like a title than an entire prompt.
  candidate = candidate.split(/(?:\r?\n|[!?！？]+|[。；]|[.;](?=\s|$))/u, 1)[0] ?? '';
  candidate = candidate
    .replace(/[*~`>#]+/gu, '')
    .replace(/[^\p{L}\p{N}\s\-_]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  for (const pattern of PROMPT_FILLER_PATTERNS) {
    if (pattern.test(candidate)) {
      candidate = candidate.replace(pattern, '').trim();
      break;
    }
  }

  if (hadUrl) {
    candidate = candidate.replace(/\b(?:at|on|in|from|to|via|for)$/iu, '').trim();
  }

  candidate = capitalizeFirstCodePoint(candidate);
  return truncateAtWordBoundary(candidate, TITLE_MAX_LENGTH);
}

function capitalizeFirstCodePoint(value: string): string {
  const [first = '', ...rest] = Array.from(value);
  return `${first.toUpperCase()}${rest.join('')}`;
}

function takeCodePointPrefix(value: string, limit: number): string {
  let prefix = '';
  let count = 0;
  for (const codePoint of value) {
    if (count >= limit) {
      break;
    }
    prefix += codePoint;
    count += 1;
  }
  return prefix;
}

function truncateAtWordBoundary(value: string, maxLength: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxLength) {
    return value;
  }

  const clipped = codePoints.slice(0, maxLength).join('');
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
}

/**
 * Sanitize a title by retaining Unicode letters, numbers, spaces, dashes, and
 * underscores.
 */
export function sanitizeTitle(title: string): string {
  return title.replace(/[^\p{L}\p{N}\s\-_]/gu, '').trim();
}

/** Generate a numbered fallback when no title can be derived. */
export function generateDefaultTitle(sessionCount: number): string {
  return `Session ${sessionCount + 1}`;
}
