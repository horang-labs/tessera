/**
 * SQLite database singleton using sql.js (WASM-based, no native dependencies).
 *
 * Provides a better-sqlite3-compatible API wrapper so that all existing
 * query code (sessions.ts, projects.ts, etc.) works without changes.
 *
 * Database file:
 *   - production runtime: ${TESSERA_DATA_DIR:-~/.tessera}/tessera.db
 *   - development on main branch: ${TESSERA_DATA_DIR:-~/.tessera}/tessera.db
 *   - development on every other branch: ${TESSERA_DATA_DIR:-~/.tessera}/tessera-dev.db
 * Persistence: immediate write-through on every mutation.
 */

const initSqlJs = require('sql.js') as () => Promise<{ Database: new (data?: ArrayLike<number>) => SqlJsDatabase }>;

interface SqlJsDatabase {
  run(sql: string, params?: (string | number | null | Uint8Array)[]): void;
  exec(sql: string): { columns: string[]; values: (string | number | null | Uint8Array)[][] }[];
  prepare(sql: string): SqlJsStatement;
  getRowsModified(): number;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatement {
  bind(params?: (string | number | null | Uint8Array)[]): void;
  step(): boolean;
  getAsObject(): Record<string, string | number | null | Uint8Array>;
  free(): void;
}
import fs from 'fs';
import { CREATE_INDEXES, CREATE_TABLES, SCHEMA_VERSION } from './schema';
import { resolveDatabaseLocation } from './location';
import logger from '../logger';

// ── better-sqlite3 compatible wrapper ───────────────────────────────────────

class PreparedStatement {
  constructor(private wrapper: DatabaseWrapper, private sql: string) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    return this.wrapper._run(this.sql, params);
  }

  get(...params: unknown[]): any {
    return this.wrapper._get(this.sql, params);
  }

  all(...params: unknown[]): any[] {
    return this.wrapper._all(this.sql, params);
  }
}

class DatabaseWrapper {
  private inTransaction = false;

  constructor(private db: SqlJsDatabase, private dbPath: string) {}

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this, sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
    if (!this.inTransaction) this.persist();
  }

  pragma(directive: string): unknown {
    const results = this.db.exec(`PRAGMA ${directive}`);
    if (results.length === 0) return undefined;
    const { columns, values } = results[0];
    // Single-value pragma (e.g., PRAGMA foreign_keys = ON)
    if (values.length === 1 && columns.length === 1) {
      return values[0][0];
    }
    // Multi-row pragma (e.g., PRAGMA table_info)
    return values.map((row: (string | number | null | Uint8Array)[]) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col: string, i: number) => { obj[col] = row[i]; });
      return obj;
    });
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const wrapper = this;
    const transactionFn = ((...args: unknown[]) => {
      wrapper.db.run('BEGIN');
      wrapper.inTransaction = true;
      try {
        const result = fn(...args);
        wrapper.db.run('COMMIT');
        wrapper.inTransaction = false;
        wrapper.persist();
        return result;
      } catch (e) {
        wrapper.db.run('ROLLBACK');
        wrapper.inTransaction = false;
        throw e;
      }
    }) as unknown as T;
    return transactionFn;
  }

  /** @internal */
  _run(sql: string, params: unknown[]): { changes: number; lastInsertRowid: number } {
    this.db.run(sql, params as (string | number | null | Uint8Array)[]);
    const changes = this.db.getRowsModified();
    if (!this.inTransaction) this.persist();
    return { changes, lastInsertRowid: 0 };
  }

  /** @internal */
  _get(sql: string, params: unknown[]): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params as (string | number | null | Uint8Array)[]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row as Record<string, unknown>;
    }
    stmt.free();
    return undefined;
  }

  /** @internal */
  _all(sql: string, params: unknown[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params as (string | number | null | Uint8Array)[]);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    return rows;
  }

  private persist(): void {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────

const DB_KEY = Symbol.for('tessera.database');
const _g = globalThis as unknown as Record<symbol, DatabaseWrapper>;

/**
 * Initialize the database (async — sql.js WASM loading).
 * Must be called once at server startup before any getDb() calls.
 */
export async function initDatabase(): Promise<void> {
  if (_g[DB_KEY]) return;

  const dbLocation = await resolveDatabaseLocation();

  fs.mkdirSync(dbLocation.dbDir, { recursive: true, mode: 0o700 });

  const SqlJs = await initSqlJs();

  let db: SqlJsDatabase;
  if (fs.existsSync(dbLocation.dbPath)) {
    const fileBuffer = fs.readFileSync(dbLocation.dbPath);
    db = new SqlJs.Database(fileBuffer) as unknown as SqlJsDatabase;
  } else {
    db = new SqlJs.Database() as unknown as SqlJsDatabase;
  }

  const wrapper = new DatabaseWrapper(db, dbLocation.dbPath);

  // WAL not applicable for sql.js (in-memory), but foreign_keys works
  wrapper.pragma('foreign_keys = ON');

  // Create tables
  wrapper.exec(CREATE_TABLES);

  // Check/set schema version and run migrations
  const versionRow = wrapper.prepare('SELECT value FROM _meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
  const currentVersion = versionRow ? parseInt(String(versionRow.value), 10) : 0;

  if (!versionRow) {
    wrapper.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  } else if (currentVersion < SCHEMA_VERSION) {
    runMigrations(wrapper, currentVersion);
    wrapper.prepare('UPDATE _meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
  }

  ensureLatestSchema(wrapper);
  wrapper.exec(CREATE_INDEXES);

  _g[DB_KEY] = wrapper;
  logger.info({
    branchName: dbLocation.branchName,
    dbName: dbLocation.dbName,
    path: dbLocation.dbPath,
    source: dbLocation.source,
  }, 'SQLite database initialized (sql.js WASM)');
}

function addColumnIfMissing(
  db: DatabaseWrapper,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureLatestSchema(db: DatabaseWrapper): void {
  // Some dev databases can be shared across worktrees and already have the
  // latest schema version marker without every latest column. Keep startup
  // idempotent so runtime queries do not depend solely on the version marker.
  addColumnIfMissing(db, 'sessions', 'worktree_managed', 'INTEGER NOT NULL DEFAULT 0');
}

/**
 * Run sequential schema migrations.
 */
function runMigrations(db: DatabaseWrapper, fromVersion: number): void {
  if (fromVersion < 2) {
    db.exec(`ALTER TABLE projects ADD COLUMN visible INTEGER NOT NULL DEFAULT 1`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_v2 (
        id               TEXT PRIMARY KEY,
        project_id       TEXT,
        title            TEXT NOT NULL,
        has_custom_title INTEGER NOT NULL DEFAULT 0,
        provider         TEXT NOT NULL,
        task_status      TEXT NOT NULL DEFAULT 'chat',
        worktree_branch  TEXT,
        archived         INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      INSERT INTO sessions_v2 SELECT * FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v2 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
        ON sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_status
        ON sessions(project_id, task_status, archived);
    `);
    logger.info('Migration v2 applied: projects.visible + sessions FK removed');
  }

  if (fromVersion < 3) {
    db.exec(`ALTER TABLE sessions ADD COLUMN tag TEXT`);
    logger.info('Migration v3 applied: sessions.tag column added');
  }

  if (fromVersion < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_hashtags (
        session_id TEXT NOT NULL,
        hashtag    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, hashtag)
      );
      CREATE INDEX IF NOT EXISTS idx_session_hashtags_hashtag
        ON session_hashtags(hashtag);
    `);
    logger.info('Migration v4 applied: session_hashtags table added');
  }

  if (fromVersion < 5) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_project_created
        ON sessions(project_id, created_at DESC);
    `);
    logger.info('Migration v5 applied: idx_sessions_project_created index added');
  }

  if (fromVersion < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS custom_columns (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '#7c8db5',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
    logger.info('Migration v6 applied: custom_columns table added');
  }

  if (fromVersion < 7) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!cols.some(c => c.name === 'work_dir')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN work_dir TEXT`);
    }
    logger.info('Migration v7 applied: sessions.work_dir column added');
  }

  if (fromVersion < 8) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_messages_session
        ON conversation_messages(session_id, id ASC);
    `);
    logger.info('Migration v8 applied: conversation_messages table added');
  }

  if (fromVersion < 9) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!cols.some(c => c.name === 'deleted')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
    }
    logger.info('Migration v9 applied: sessions.deleted soft-delete column added');
  }

  if (fromVersion < 10) {
    const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[];
    if (!cols.some(c => c.name === 'sort_order')) {
      db.exec(`ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
      // Initialize sort_order based on current alphabetical order
      const rows = db.prepare('SELECT id FROM projects WHERE visible = 1 ORDER BY display_name').all() as { id: string }[];
      const stmt = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
      rows.forEach((row, idx) => stmt.run(idx, row.id));
    }
    logger.info('Migration v10 applied: projects.sort_order column added');
  }

  if (fromVersion < 11) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!cols.some(c => c.name === 'sort_order')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    }
    // Initialize sort_order per (project_id, task_status) group based on created_at DESC
    db.exec(`
      UPDATE sessions SET sort_order = (
        SELECT COUNT(*)
        FROM sessions s2
        WHERE s2.project_id = sessions.project_id
          AND s2.task_status = sessions.task_status
          AND s2.created_at > sessions.created_at
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_sort_order
        ON sessions(project_id, task_status, sort_order ASC)
    `);
    logger.info('Migration v11 applied: sessions.sort_order column added');
  }

  if (fromVersion < 12) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!cols.some(c => c.name === 'provider_state')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN provider_state TEXT`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_session
        ON session_messages(session_id, created_at);
    `);
    logger.info('Migration v12 applied: sessions.provider_state + session_messages table added');
  }

  if (fromVersion < 13) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_v13 (
        id               TEXT PRIMARY KEY,
        project_id       TEXT,
        title            TEXT NOT NULL,
        has_custom_title INTEGER NOT NULL DEFAULT 0,
        provider         TEXT NOT NULL,
        provider_state   TEXT,
        task_status      TEXT NOT NULL DEFAULT 'chat',
        tag              TEXT,
        work_dir         TEXT,
        worktree_branch  TEXT,
        archived         INTEGER NOT NULL DEFAULT 0,
        deleted          INTEGER NOT NULL DEFAULT 0,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      INSERT INTO sessions_v13 (
        id, project_id, title, has_custom_title, provider, provider_state,
        task_status, tag, work_dir, worktree_branch, archived, deleted,
        sort_order, created_at, updated_at
      )
      SELECT
        id, project_id, title, has_custom_title, provider, provider_state,
        task_status, tag, work_dir, worktree_branch, archived, deleted,
        sort_order, created_at, updated_at
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v13 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
        ON sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_created
        ON sessions(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_status
        ON sessions(project_id, task_status, archived);
      CREATE INDEX IF NOT EXISTS idx_sessions_sort_order
        ON sessions(project_id, task_status, sort_order ASC);
    `);
    logger.info('Migration v13 applied: sessions.jsonl_path column removed');
  }

  if (fromVersion < 14) {
    // Collections table (replaces custom_columns conceptually)
    db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '#7c8db5',
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);

    // Tasks table (groups multiple sessions under one worktree)
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL,
        title            TEXT NOT NULL,
        collection_id    TEXT,
        workflow_status   TEXT NOT NULL DEFAULT 'todo',
        worktree_branch  TEXT,
        summary          TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project
        ON tasks(project_id, workflow_status);
      CREATE INDEX IF NOT EXISTS idx_tasks_collection
        ON tasks(collection_id);
    `);

    // Add sort_order to tasks (if missing)
    const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    if (!taskCols.some(c => c.name === 'sort_order')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
    }

    // Add task_id and collection_id to sessions
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!cols.some(c => c.name === 'task_id')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN task_id TEXT`);
    }
    if (!cols.some(c => c.name === 'collection_id')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN collection_id TEXT`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_task
        ON sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_collection
        ON sessions(collection_id);
    `);

    // ── Data migration: convert existing task_status + custom_columns → collections ──
    const now = new Date().toISOString();

    // Define the collection set: old task_status values + custom_columns
    // Each gets a collection so sessions can be grouped by it.
    const collectionDefs: { label: string; color: string; oldStatus?: string; oldCustomId?: string }[] = [
      { label: 'Chat', color: '#8e8ea0', oldStatus: 'chat' },
      { label: 'In Progress', color: '#34d399', oldStatus: 'in_progress' },
      { label: 'In Review', color: '#60a5fa', oldStatus: 'in_review' },
      { label: 'Todo', color: '#6b6880', oldStatus: 'todo' },
      { label: 'Backlog', color: '#78716c', oldStatus: 'backlog' },
    ];

    // Add custom_columns as collections (preserve their label/color)
    const customCols = db.prepare('SELECT id, label, color FROM custom_columns ORDER BY sort_order').all() as { id: string; label: string; color: string }[];
    for (const cc of customCols) {
      collectionDefs.push({ label: cc.label, color: cc.color, oldCustomId: cc.id });
    }

    // Create collections and build a mapping from old status/customId → new collection_id
    const statusToCollectionId: Record<string, string> = {};
    const insertCol = db.prepare(
      'INSERT OR IGNORE INTO collections (id, label, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    collectionDefs.forEach((def, idx) => {
      const colId = 'col_' + Math.random().toString(16).slice(2, 10);
      insertCol.run(colId, def.label, def.color, idx, now, now);
      if (def.oldStatus) statusToCollectionId[def.oldStatus] = colId;
      if (def.oldCustomId) statusToCollectionId[def.oldCustomId] = colId;
    });

    // Also map done/cancelled/stopped to no collection (they stay as uncategorized chats)
    // But assign sessions with known statuses to their collection
    const updateStmt = db.prepare('UPDATE sessions SET collection_id = ? WHERE task_status = ? AND deleted = 0');
    for (const [oldStatus, colId] of Object.entries(statusToCollectionId)) {
      const result = updateStmt.run(colId, oldStatus);
      if (result.changes > 0) {
        logger.info({ oldStatus, collectionId: colId, count: result.changes }, 'Migrated sessions to collection');
      }
    }

    // ── Convert worktree sessions into TaskEntity records ──
    // Each worktree session becomes a single-session task.
    const wtSessions = db.prepare(`
      SELECT id, title, project_id, worktree_branch, collection_id, task_status, created_at, updated_at
      FROM sessions
      WHERE worktree_branch IS NOT NULL AND deleted = 0 AND task_id IS NULL
    `).all() as { id: string; title: string; project_id: string; worktree_branch: string; collection_id: string | null; task_status: string; created_at: string; updated_at: string }[];

    if (wtSessions.length > 0) {
      const insertTask = db.prepare(
        'INSERT INTO tasks (id, project_id, title, collection_id, workflow_status, worktree_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      const linkSession = db.prepare('UPDATE sessions SET task_id = ? WHERE id = ?');

      for (const s of wtSessions) {
        const taskId = 'task_' + s.id; // derive from session ID for determinism
        // Map old task_status to workflow_status
        let wfStatus = 'todo';
        if (s.task_status === 'in_progress') wfStatus = 'in_progress';
        else if (s.task_status === 'in_review') wfStatus = 'in_review';
        else if (s.task_status === 'done' || s.task_status === 'cancelled' || s.task_status === 'stopped') wfStatus = 'done';

        insertTask.run(taskId, s.project_id, s.title, s.collection_id, wfStatus, s.worktree_branch, s.created_at, s.updated_at);
        linkSession.run(taskId, s.id);
      }
      logger.info({ count: wtSessions.length }, 'Migrated worktree sessions to tasks');
    }

    logger.info({ collectionsCreated: collectionDefs.length }, 'Migration v14 applied: collections + tasks tables, sessions migrated to collections');
  }

  if (fromVersion < 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_v15 (
        id               TEXT PRIMARY KEY,
        project_id       TEXT,
        title            TEXT NOT NULL,
        has_custom_title INTEGER NOT NULL DEFAULT 0,
        provider         TEXT NOT NULL,
        provider_state   TEXT,
        task_status      TEXT NOT NULL DEFAULT 'chat',
        work_dir         TEXT,
        worktree_branch  TEXT,
        archived         INTEGER NOT NULL DEFAULT 0,
        deleted          INTEGER NOT NULL DEFAULT 0,
        task_id          TEXT,
        collection_id    TEXT,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      INSERT INTO sessions_v15 (
        id, project_id, title, has_custom_title, provider, provider_state,
        task_status, work_dir, worktree_branch, archived, deleted,
        task_id, collection_id, sort_order, created_at, updated_at
      )
      SELECT
        id, project_id, title, has_custom_title, provider, provider_state,
        task_status, work_dir, worktree_branch, archived, deleted,
        task_id, collection_id, sort_order, created_at, updated_at
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v15 RENAME TO sessions;
      DROP INDEX IF EXISTS idx_session_hashtags_hashtag;
      DROP TABLE IF EXISTS session_hashtags;
      CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
        ON sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_created
        ON sessions(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_status
        ON sessions(project_id, task_status, archived);
      CREATE INDEX IF NOT EXISTS idx_sessions_sort_order
        ON sessions(project_id, task_status, sort_order ASC);
    `);
    logger.info('Migration v15 applied: removed session tag and hashtag metadata');
  }

  if (fromVersion < 16) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_v16 (
        id               TEXT PRIMARY KEY,
        project_id       TEXT,
        title            TEXT NOT NULL,
        has_custom_title INTEGER NOT NULL DEFAULT 0,
        provider         TEXT NOT NULL,
        provider_state   TEXT,
        work_dir         TEXT,
        worktree_branch  TEXT,
        archived         INTEGER NOT NULL DEFAULT 0,
        deleted          INTEGER NOT NULL DEFAULT 0,
        task_id          TEXT,
        collection_id    TEXT,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      INSERT INTO sessions_v16 (
        id, project_id, title, has_custom_title, provider, provider_state,
        work_dir, worktree_branch, archived, deleted, task_id,
        collection_id, sort_order, created_at, updated_at
      )
      SELECT
        id, project_id, title, has_custom_title, provider, provider_state,
        work_dir, worktree_branch, archived, deleted, task_id,
        collection_id, sort_order, created_at, updated_at
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v16 RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
        ON sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_created
        ON sessions(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_archived
        ON sessions(project_id, archived);
      CREATE INDEX IF NOT EXISTS idx_sessions_sort_order
        ON sessions(project_id, sort_order ASC);
      CREATE INDEX IF NOT EXISTS idx_sessions_task
        ON sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_collection
        ON sessions(collection_id);
    `);
    logger.info('Migration v16 applied: sessions.task_status column removed');
  }

  if (fromVersion < 17) {
    const collectionCols = db.prepare(`PRAGMA table_info(collections)`).all() as { name: string }[];
    if (!collectionCols.some((column) => column.name === 'project_id')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS collections_v17 (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL,
          label       TEXT NOT NULL,
          color       TEXT NOT NULL DEFAULT '#7c8db5',
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_collections_project_sort_v17
          ON collections_v17(project_id, sort_order ASC, created_at ASC);
      `);

      const existingCollections = db.prepare(`
        SELECT id, label, color, sort_order, created_at, updated_at
        FROM collections
        ORDER BY sort_order ASC, created_at ASC
      `).all() as {
        id: string;
        label: string;
        color: string;
        sort_order: number;
        created_at: string;
        updated_at: string;
      }[];

      const projectRows = db.prepare(`
        SELECT DISTINCT project_id
        FROM (
          SELECT id AS project_id FROM projects
          UNION
          SELECT project_id FROM sessions WHERE project_id IS NOT NULL
          UNION
          SELECT project_id FROM tasks WHERE project_id IS NOT NULL
        )
        WHERE project_id IS NOT NULL AND project_id != ''
      `).all() as { project_id: string }[];

      const insertCollection = db.prepare(`
        INSERT INTO collections_v17 (
          id, project_id, label, color, sort_order, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const updateSessionCollection = db.prepare(`
        UPDATE sessions
        SET collection_id = ?
        WHERE project_id = ? AND collection_id = ?
      `);
      const updateTaskCollection = db.prepare(`
        UPDATE tasks
        SET collection_id = ?, updated_at = ?
        WHERE project_id = ? AND collection_id = ?
      `);
      const usedCollectionIds = new Set<string>();
      const makeCollectionId = () => {
        let nextId = '';
        do {
          nextId = 'col_' + Math.random().toString(16).slice(2, 10);
        } while (usedCollectionIds.has(nextId));
        usedCollectionIds.add(nextId);
        return nextId;
      };

      for (const { project_id: projectId } of projectRows) {
        for (const collection of existingCollections) {
          const nextCollectionId = makeCollectionId();
          insertCollection.run(
            nextCollectionId,
            projectId,
            collection.label,
            collection.color,
            collection.sort_order,
            collection.created_at,
            collection.updated_at
          );
          updateSessionCollection.run(nextCollectionId, projectId, collection.id);
          updateTaskCollection.run(
            nextCollectionId,
            new Date().toISOString(),
            projectId,
            collection.id
          );
        }
      }

      db.exec(`DROP TABLE collections`);
      db.exec(`ALTER TABLE collections_v17 RENAME TO collections`);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_collections_project_sort
        ON collections(project_id, sort_order ASC, created_at ASC);
    `);
    logger.info('Migration v17 applied: collections are now scoped per project');
  }

  if (fromVersion < 18) {
    const now = new Date().toISOString();

    const clearedTaskCollections = db.prepare(`
      UPDATE tasks
      SET collection_id = NULL, updated_at = ?
      WHERE collection_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM collections c WHERE c.id = tasks.collection_id
        )
    `).run(now).changes;

    const syncedTaskSessionCollections = db.prepare(`
      UPDATE sessions
      SET collection_id = (
            SELECT t.collection_id
            FROM tasks t
            WHERE t.id = sessions.task_id
          ),
          updated_at = ?
      WHERE task_id IS NOT NULL
        AND COALESCE(collection_id, '') != COALESCE((
          SELECT t.collection_id
          FROM tasks t
          WHERE t.id = sessions.task_id
        ), '')
    `).run(now).changes;

    const clearedOrphanSessionCollections = db.prepare(`
      UPDATE sessions
      SET collection_id = NULL, updated_at = ?
      WHERE collection_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM collections c WHERE c.id = sessions.collection_id
        )
    `).run(now).changes;

    logger.info({
      clearedTaskCollections,
      syncedTaskSessionCollections,
      clearedOrphanSessionCollections,
    }, 'Migration v18 applied: normalized task/session collection references');
  }

  if (fromVersion < 19) {
    const addColumnIfMissing = (table: string, column: string, definition: string) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((col) => col.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };

    addColumnIfMissing('sessions', 'archived_at', 'TEXT');
    addColumnIfMissing('sessions', 'worktree_deleted_at', 'TEXT');
    addColumnIfMissing('tasks', 'archived', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('tasks', 'archived_at', 'TEXT');
    addColumnIfMissing('tasks', 'worktree_deleted_at', 'TEXT');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_archived
        ON tasks(project_id, archived, archived_at DESC);
    `);

    logger.info('Migration v19 applied: archive metadata and worktree retention columns');
  }

  if (fromVersion < 20) {
    const now = new Date().toISOString();

    const promotedLegacyTasks = db.prepare(`
      UPDATE tasks
      SET archived = 1,
          archived_at = COALESCE((
            SELECT MAX(s.archived_at)
            FROM sessions s
            WHERE s.task_id = tasks.id
              AND s.deleted = 0
              AND s.archived = 1
          ), updated_at, ?),
          updated_at = ?
      WHERE COALESCE(archived, 0) = 0
        AND EXISTS (
          SELECT 1
          FROM sessions s
          WHERE s.task_id = tasks.id
            AND s.deleted = 0
        )
        AND EXISTS (
          SELECT 1
          FROM sessions s
          WHERE s.task_id = tasks.id
            AND s.deleted = 0
            AND s.archived = 1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sessions s
          WHERE s.task_id = tasks.id
            AND s.deleted = 0
            AND s.archived = 0
        )
    `).run(now, now).changes;

    const clearedTaskSessionArchiveFlags = db.prepare(`
      UPDATE sessions
      SET archived = 0,
          archived_at = NULL,
          updated_at = ?
      WHERE task_id IS NOT NULL
        AND (archived != 0 OR archived_at IS NOT NULL)
    `).run(now).changes;

    logger.info({
      promotedLegacyTasks,
      clearedTaskSessionArchiveFlags,
    }, 'Migration v20 applied: moved task archive state off child sessions');
  }

  if (fromVersion < 21) {
    const addColumnIfMissing = (table: string, column: string, definition: string) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((col) => col.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };

    addColumnIfMissing('tasks', 'pr_number', 'INTEGER');
    addColumnIfMissing('tasks', 'pr_url', 'TEXT');
    addColumnIfMissing('tasks', 'pr_state', 'TEXT');
    addColumnIfMissing('tasks', 'pr_merged_at', 'TEXT');
    addColumnIfMissing('tasks', 'pr_last_synced', 'TEXT');
    addColumnIfMissing('tasks', 'pr_unsupported', 'INTEGER NOT NULL DEFAULT 0');

    logger.info('Migration v21 applied: tasks PR sync columns added');
  }

  if (fromVersion < 22) {
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    if (!cols.some((col) => col.name === 'remote_branch_exists')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN remote_branch_exists INTEGER`);
    }
    logger.info('Migration v22 applied: tasks.remote_branch_exists column added');
  }

  if (fromVersion < 23) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects_v23 (
        id            TEXT PRIMARY KEY,
        decoded_path  TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        provider      TEXT,
        visible       INTEGER NOT NULL DEFAULT 1,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        registered_at TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      INSERT INTO projects_v23 (
        id, decoded_path, display_name, provider, visible, sort_order,
        registered_at, updated_at
      )
      SELECT
        id, decoded_path, display_name, provider, visible, sort_order,
        registered_at, updated_at
      FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_v23 RENAME TO projects;

      CREATE TABLE IF NOT EXISTS sessions_v23 (
        id               TEXT PRIMARY KEY,
        project_id       TEXT,
        title            TEXT NOT NULL,
        has_custom_title INTEGER NOT NULL DEFAULT 0,
        provider         TEXT NOT NULL,
        provider_state   TEXT,
        work_dir         TEXT,
        worktree_branch  TEXT,
        archived         INTEGER NOT NULL DEFAULT 0,
        archived_at      TEXT,
        worktree_deleted_at TEXT,
        deleted          INTEGER NOT NULL DEFAULT 0,
        task_id          TEXT,
        collection_id    TEXT,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      INSERT INTO sessions_v23 (
        id, project_id, title, has_custom_title, provider, provider_state,
        work_dir, worktree_branch, archived, archived_at, worktree_deleted_at,
        deleted, task_id, collection_id, sort_order, created_at, updated_at
      )
      SELECT
        id, project_id, title, has_custom_title, provider, provider_state,
        work_dir, worktree_branch, archived, archived_at, worktree_deleted_at,
        deleted, task_id, collection_id, sort_order, created_at, updated_at
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v23 RENAME TO sessions;
    `);
    logger.info('Migration v23 applied: removed implicit provider defaults');
  }

  if (fromVersion < 24) {
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    if (!cols.some((col) => col.name === 'pr_head_ref_oid')) {
      db.exec(`ALTER TABLE tasks ADD COLUMN pr_head_ref_oid TEXT`);
    }
    logger.info('Migration v24 applied: tasks.pr_head_ref_oid column added');
  }

  if (fromVersion < 25) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!cols.some((col) => col.name === 'worktree_managed')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN worktree_managed INTEGER NOT NULL DEFAULT 0`);
    }
    logger.info('Migration v25 applied: sessions.worktree_managed column added');
  }
}

/**
 * Get the database instance. Throws if initDatabase() hasn't been called.
 */
export function getDb(): DatabaseWrapper {
  if (!_g[DB_KEY]) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return _g[DB_KEY];
}
