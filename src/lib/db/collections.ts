/**
 * Collection CRUD operations backed by SQLite.
 */

import { getDb } from './database';

export interface CollectionRow {
  id: string;
  project_id: string;
  label: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * Get all collections for a project ordered by sort_order.
 */
export function getCollections(projectId: string): CollectionRow[] {
  return getDb()
    .prepare(`
      SELECT *
      FROM collections
      WHERE project_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `)
    .all(projectId) as CollectionRow[];
}

/**
 * Check if a collection exists by ID.
 */
export function collectionExists(id: string, projectId?: string): boolean {
  const row = projectId
    ? getDb()
      .prepare('SELECT 1 FROM collections WHERE id = ? AND project_id = ?')
      .get(id, projectId)
    : getDb()
      .prepare('SELECT 1 FROM collections WHERE id = ?')
      .get(id);
  return row !== undefined;
}

/**
 * Create a new collection.
 */
export function createCollection(
  id: string,
  projectId: string,
  label: string,
  color: string,
  sortOrder: number
): CollectionRow {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO collections (id, project_id, label, color, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, label, color, sortOrder, now, now);
  return {
    id,
    project_id: projectId,
    label,
    color,
    sort_order: sortOrder,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Update a collection's label, color, or sort_order.
 */
export function updateCollection(
  id: string,
  patch: Partial<Pick<CollectionRow, 'label' | 'color' | 'sort_order'>>
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.label !== undefined) { sets.push('label = ?'); values.push(patch.label); }
  if (patch.color !== undefined) { sets.push('color = ?'); values.push(patch.color); }
  if (patch.sort_order !== undefined) { sets.push('sort_order = ?'); values.push(patch.sort_order); }

  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Delete a collection and reset collection_id to null for all its tasks and sessions.
 * Returns the number of sessions moved.
 */
export function deleteCollection(id: string): { movedCount: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const clearTaskCollection = db.prepare(
    'UPDATE tasks SET collection_id = NULL, updated_at = ? WHERE collection_id = ?'
  );
  const clearSessionCollection = db.prepare(
    'UPDATE sessions SET collection_id = NULL, updated_at = ? WHERE collection_id = ?'
  );
  let sessionMoveResult = { changes: 0 };

  db.transaction(() => {
    clearTaskCollection.run(now, id);
    sessionMoveResult = clearSessionCollection.run(now, id);
    db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  })();

  return { movedCount: sessionMoveResult.changes };
}

/**
 * Get the next sort_order value (max + 1) for a project.
 */
export function getNextCollectionSortOrder(projectId: string): number {
  const row = getDb()
    .prepare('SELECT MAX(sort_order) as max_order FROM collections WHERE project_id = ?')
    .get(projectId) as { max_order: number | null };
  return (row.max_order ?? -1) + 1;
}
