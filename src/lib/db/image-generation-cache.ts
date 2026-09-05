import { getDb } from './database';
import type { ImageGenerationTrace } from '@/lib/image-generation/traces';

export const IMAGE_CACHE_VERSION = 1;

export function readImageCache(sessionId: string): {
  source_json: string; state_json: string; cards_json: string;
} | undefined {
  return getDb().prepare('SELECT source_json, state_json, cards_json FROM image_generation_cache WHERE session_id = ? AND version = ?')
    .get(sessionId, IMAGE_CACHE_VERSION);
}

export function readImageCards(sessionId: string): ImageGenerationTrace[] {
  const row = getDb().prepare('SELECT cards_json FROM image_generation_cache WHERE session_id = ? AND version = ?')
    .get(sessionId, IMAGE_CACHE_VERSION);
  return row ? JSON.parse(row.cards_json) : [];
}

/** One SQLite statement commits cards, reference history and checkpoint together. */
export function saveImageCache(sessionId: string, source: unknown, state: unknown, cards: ImageGenerationTrace[]): void {
  getDb().prepare(`INSERT INTO image_generation_cache(session_id, version, source_json, state_json, cards_json)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND deleted = 0)
    ON CONFLICT(session_id) DO UPDATE SET version=excluded.version, source_json=excluded.source_json,
    state_json=excluded.state_json, cards_json=excluded.cards_json`)
    .run(sessionId, IMAGE_CACHE_VERSION, JSON.stringify(source), JSON.stringify(state), JSON.stringify(cards), sessionId);
}
