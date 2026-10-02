/**
 * SQLite schema definitions for Tessera's own database.
 *
 * This DB is the source of truth for projects, sessions, and conversation messages.
 */

export const SCHEMA_VERSION = 41;

/**
 * v38 needs the authenticated agent environment before legacy path evidence
 * can be registered as a host-openable Worktree location.
 */
export const CANONICAL_WORKTREE_BOOTSTRAP_META_KEY = 'canonical_worktree_bootstrap_v38';

export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worktrees (
  id                 TEXT PRIMARY KEY,
  filesystem_path    TEXT,
  canonical_path_key TEXT UNIQUE,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worktree_identity_reconciliation_authorizations (
  old_worktree_id TEXT NOT NULL,
  new_worktree_id TEXT NOT NULL,
  PRIMARY KEY (old_worktree_id, new_worktree_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  decoded_path  TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  provider      TEXT,
  visible       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  preparation_script TEXT,
  preparation_after_script TEXT,
  project_worktree_id TEXT,
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
  model            TEXT,
  reasoning_effort TEXT,
  service_tier     TEXT,
  work_dir         TEXT,
  worktree_branch  TEXT,
  worktree_managed INTEGER NOT NULL DEFAULT 0,
  worktree_id      TEXT,
  scope_branch     TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  archived_at      TEXT,
  worktree_deleted_at TEXT,
  deleted          INTEGER NOT NULL DEFAULT 0,
  task_id          TEXT,
  chat_workflow_status TEXT,
  collection_id    TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Runtime intent survives server shutdown; actual liveness remains in memory.
CREATE TABLE IF NOT EXISTS session_runtime_recovery (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS image_generation_cache (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  cards_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terminal_provider_sessions (
  provider_id        TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  tessera_session_id TEXT NOT NULL UNIQUE,
  transcript_path   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (provider_id, provider_session_id)
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
  public_worktree_id TEXT NOT NULL UNIQUE,
  project_id       TEXT NOT NULL,
  title            TEXT NOT NULL,
  collection_id    TEXT,
  workflow_status   TEXT NOT NULL DEFAULT 'todo',
  worktree_branch  TEXT,
  worktree_path    TEXT,
  creation_scope_worktree_id TEXT,
  creation_scope_branch TEXT,
  start_point      TEXT,
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
  pr_relation      TEXT,
  pr_status_known  INTEGER NOT NULL DEFAULT 0,
  preparation_status TEXT NOT NULL DEFAULT 'never_run',
  preparation_started_at TEXT,
  preparation_finished_at TEXT,
  preparation_exit_code INTEGER,
  preparation_output TEXT,
  preparation_script TEXT,
  preparation_phase TEXT,
  preparation_after_script TEXT,
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

CREATE INDEX IF NOT EXISTS idx_sessions_worktree_scope
  ON sessions(worktree_id, scope_branch);

CREATE INDEX IF NOT EXISTS idx_sessions_collection
  ON sessions(collection_id);

CREATE INDEX IF NOT EXISTS idx_session_messages_session
  ON session_messages(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_terminal_provider_sessions_tessera
  ON terminal_provider_sessions(tessera_session_id);

CREATE INDEX IF NOT EXISTS idx_collections_project_sort
  ON collections(project_id, sort_order ASC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_tasks_project
  ON tasks(project_id, workflow_status);

CREATE INDEX IF NOT EXISTS idx_tasks_collection
  ON tasks(collection_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_public_worktree_id
  ON tasks(public_worktree_id);

CREATE INDEX IF NOT EXISTS idx_tasks_creation_scope
  ON tasks(creation_scope_worktree_id, creation_scope_branch);

CREATE INDEX IF NOT EXISTS idx_conv_messages_session
  ON conversation_messages(session_id, id ASC);
`;

/** v40: local automation journal. Audit rows intentionally have no Session FK. */
export const AUTORUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_automation_boundaries (
 owner_user_id TEXT NOT NULL, session_id TEXT NOT NULL, boundary_id TEXT NOT NULL,
 automation_id TEXT NOT NULL, mode TEXT NOT NULL, consumed_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user_id,session_id,boundary_id)
);
CREATE TABLE IF NOT EXISTS session_automation_decisions (
 id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES session_automations(id) ON DELETE RESTRICT,
 boundary_id TEXT NOT NULL, phase TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 run_id TEXT UNIQUE REFERENCES session_automation_runs(id) ON DELETE RESTRICT, detail_json TEXT NOT NULL,
 UNIQUE(automation_id,boundary_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autorun_active ON session_automation_decisions(automation_id) WHERE active=1;
CREATE TABLE IF NOT EXISTS session_automation_analysis_attempts (
 decision_id TEXT NOT NULL REFERENCES session_automation_decisions(id) ON DELETE RESTRICT,
 ordinal INTEGER NOT NULL, selection_json TEXT NOT NULL, packet_hash TEXT NOT NULL, attempt_json TEXT NOT NULL,
 PRIMARY KEY(decision_id,ordinal)
);
`;

export const AUTOMATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_automations (
 id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, revision INTEGER NOT NULL,
 state TEXT NOT NULL, target_session_id TEXT, next_due_at INTEGER,
 input_hold TEXT NOT NULL DEFAULT 'none', held_session_id TEXT, input_epoch TEXT,
 config_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automation_due ON session_automations(owner_user_id,state,next_due_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_wake ON session_automations(owner_user_id,target_session_id)
 WHERE state IN ('enabled','paused');
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_hold ON session_automations(owner_user_id,held_session_id)
 WHERE input_hold != 'none';
CREATE TABLE IF NOT EXISTS session_automation_runs (
 id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES session_automations(id) ON DELETE RESTRICT,
 automation_revision INTEGER NOT NULL, owner_user_id TEXT NOT NULL, occurrence_key TEXT NOT NULL,
 state TEXT NOT NULL, due_at INTEGER NOT NULL, retry_at INTEGER, session_id TEXT,
 canonical_worktree_id TEXT, overlap_held INTEGER NOT NULL DEFAULT 0,
 snapshot_json TEXT NOT NULL,
 UNIQUE(automation_id,automation_revision,occurrence_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_inflight ON session_automation_runs(automation_id)
 WHERE state IN ('pending','deferred','dispatching');
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_overlap ON session_automation_runs(canonical_worktree_id)
 WHERE overlap_held=1;
CREATE INDEX IF NOT EXISTS idx_automation_retry ON session_automation_runs(state,retry_at,due_at);
CREATE INDEX IF NOT EXISTS idx_automation_history ON session_automation_runs(owner_user_id,automation_id,due_at);
CREATE INDEX IF NOT EXISTS idx_automation_run_session ON session_automation_runs(owner_user_id,session_id);
CREATE TABLE IF NOT EXISTS session_automation_scheduler (
 id INTEGER PRIMARY KEY CHECK(id=1), instance_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL,
 lease_until INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_automation_idempotency (
 owner_user_id TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
 response_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_user_id,key)
);
${AUTORUN_SCHEMA}`;
