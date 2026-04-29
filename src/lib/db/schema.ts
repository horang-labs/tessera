/**
 * SQLite schema definitions for Tessera's own database.
 *
 * This DB is the source of truth for projects, sessions, and conversation messages.
 */

export const SCHEMA_VERSION = 24;

export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  decoded_path  TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  provider      TEXT,
  visible       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  registered_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS session_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_columns (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#7c8db5',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  label       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#7c8db5',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  title            TEXT NOT NULL,
  collection_id    TEXT,
  workflow_status   TEXT NOT NULL DEFAULT 'todo',
  worktree_branch  TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  archived_at      TEXT,
  worktree_deleted_at TEXT,
  summary          TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  pr_number        INTEGER,
  pr_url           TEXT,
  pr_state         TEXT,
  pr_merged_at     TEXT,
  pr_last_synced   TEXT,
  pr_unsupported   INTEGER NOT NULL DEFAULT 0,
  remote_branch_exists INTEGER,
  pr_head_ref_oid  TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

`;

// Create the latest index set only after migrations complete. Older databases may
// still be missing columns like sessions.sort_order or collections.project_id when
// CREATE TABLE IF NOT EXISTS first runs during startup.
export const CREATE_INDEXES = `
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

CREATE INDEX IF NOT EXISTS idx_session_messages_session
  ON session_messages(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_collections_project_sort
  ON collections(project_id, sort_order ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_tasks_project
  ON tasks(project_id, workflow_status);

CREATE INDEX IF NOT EXISTS idx_tasks_collection
  ON tasks(collection_id);

CREATE INDEX IF NOT EXISTS idx_conv_messages_session
  ON conversation_messages(session_id, id ASC);
`;
