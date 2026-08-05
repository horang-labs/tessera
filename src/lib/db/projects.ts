/**
 * Project CRUD operations backed by SQLite.
 */

import { normalizePreparationScript } from '@/lib/projects/preparation-script-policy';
import type { PreparationPhase } from '@/lib/projects/preparation-status-policy';
import { getDb } from './database';

export interface ProjectRow {
  id: string;
  decoded_path: string;
  display_name: string;
  provider: string | null;
  visible: number; // 0 | 1
  sort_order: number;
  /** The `before` stage: what an agent cannot start without. */
  preparation_script: string | null;
  /** The `after` stage: what a worktree needs but an agent need not wait for. */
  preparation_after_script: string | null;
  registered_at: string;
  updated_at: string;
}

/**
 * Register a project (idempotent).
 * If the project was previously closed (visible=0), re-opens it.
 */
export function registerProject(
  id: string,
  decodedPath: string,
  displayName: string,
  provider: string | null = null,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  // New projects get sort_order = max + 1 (append to bottom of strip)
  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM projects WHERE visible = 1').get() as { max_order: number };
  const nextOrder = maxRow.max_order + 1;
  db.prepare(`
    INSERT INTO projects (id, decoded_path, display_name, provider, visible, sort_order, registered_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET visible = 1, updated_at = ?
  `).run(id, decodedPath, displayName, provider, nextOrder, now, now, now);
}

/**
 * Close a project (hide from sidebar). Sessions are NOT deleted.
 */
export function removeProject(id: string): void {
  getDb().prepare('UPDATE projects SET visible = 0 WHERE id = ?').run(id);
}

/**
 * Get all visible (open) projects.
 */
export function getVisibleProjects(): ProjectRow[] {
  return getDb().prepare('SELECT * FROM projects WHERE visible = 1 ORDER BY sort_order, display_name').all() as ProjectRow[];
}

/**
 * Get every registered project for read-only Control inspection, including
 * projects hidden from the active sidebar.
 */
export function getAllProjects(): ProjectRow[] {
  return getDb().prepare(`
    SELECT *
    FROM projects
    ORDER BY visible DESC, sort_order, display_name
  `).all() as ProjectRow[];
}

/**
 * Get projects that have Tessera conversation/task history, including closed
 * projects hidden from the active sidebar.
 */
export function getProjectsWithHistory(): ProjectRow[] {
  return getDb().prepare(`
    SELECT *
    FROM projects p
    WHERE EXISTS (
      SELECT 1
      FROM sessions s
      WHERE s.project_id = p.id
        AND s.deleted = 0
    )
    OR EXISTS (
      SELECT 1
      FROM tasks t
      WHERE t.project_id = p.id
    )
    ORDER BY visible DESC, sort_order, display_name
  `).all() as ProjectRow[];
}

/**
 * Reorder projects by updating sort_order for each project ID.
 * @param orderedIds - project IDs in the desired display order
 */
export function reorderProjects(orderedIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
  const runAll = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id));
  });
  runAll();
}

/**
 * Check if a project is registered.
 */
export function isRegistered(id: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
  return !!row;
}

/**
 * Get a single project by ID.
 */
export function getProject(id: string): ProjectRow | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

/**
 * Write one of a project's preparation scripts and return what was stored.
 * A blank script is stored as no script at all.
 */
export function setPreparationScript(
  id: string,
  script: string | null,
  phase: PreparationPhase = 'before',
): string | null {
  const normalized = normalizePreparationScript(script);
  // The column is chosen from a closed set, never from anything a caller sends.
  const column = phase === 'after' ? 'preparation_after_script' : 'preparation_script';
  getDb()
    .prepare(`UPDATE projects SET ${column} = ?, updated_at = ? WHERE id = ?`)
    .run(normalized, new Date().toISOString(), id);
  return normalized;
}

/** The script a stage runs, or null when that stage has nothing to do. */
export function readProjectPreparationScript(
  project: Pick<ProjectRow, 'preparation_script' | 'preparation_after_script'>,
  phase: PreparationPhase,
): string | null {
  return phase === 'after' ? project.preparation_after_script : project.preparation_script;
}
