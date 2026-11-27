import { getDb } from '@/lib/db/database';
import type {
  ControlSessionCatalog,
  ControlSessionSearchRecord,
} from './service';

interface SessionCatalogRow {
  session_id: string;
  title: string;
  project_id: string | null;
  project_name: string | null;
  public_worktree_id: string | null;
  worktree_title: string | null;
  branch: string | null;
  provider: string;
  kind: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  provider_session_id: string | null;
  transcript_path: string | null;
}

// Provider conversation IDs live either in the terminal binding table or, for
// sessions that never reported one through hooks, inside provider_state.
const PROVIDER_STATE_SESSION_ID_KEYS = [
  'terminalProviderSessionId',
  'codexSessionId',
  'threadId',
  'opencodeTerminalSessionId',
  'opencodeSessionId',
] as const;

const providerStateValue = (key: string) => (
  `CASE WHEN json_valid(s.provider_state) THEN json_extract(s.provider_state, '$.${key}') END`
);

const SESSION_CATALOG_SQL = `
  SELECT s.id AS session_id, s.title, s.project_id, p.display_name AS project_name,
         t.public_worktree_id, t.title AS worktree_title,
         COALESCE(t.worktree_branch, s.worktree_branch) AS branch,
         s.provider, ${providerStateValue('kind')} AS kind,
         CASE WHEN s.archived = 1 OR t.archived = 1 OR t.worktree_deleted_at IS NOT NULL
           THEN 1 ELSE 0 END AS archived,
         s.created_at, s.updated_at,
         COALESCE(
           tps.provider_session_id,
           ${PROVIDER_STATE_SESSION_ID_KEYS.map(providerStateValue).join(',\n           ')}
         ) AS provider_session_id,
         tps.transcript_path
  FROM sessions s
  LEFT JOIN tasks t ON t.id = s.task_id
  LEFT JOIN projects p ON p.id = s.project_id
  LEFT JOIN terminal_provider_sessions tps ON tps.tessera_session_id = s.id
  WHERE s.deleted = 0
`;

export function createDatabaseControlSessionCatalog(): ControlSessionCatalog {
  return {
    search: ({ query, projectId, includeArchived, limit }) => {
      const rows = getDb().prepare(`
        ${SESSION_CATALOG_SQL}
          ${projectId === undefined ? '' : 'AND s.project_id = ?'}
        ORDER BY s.updated_at DESC, s.id ASC
      `).all(...(projectId === undefined ? [] : [projectId])) as SessionCatalogRow[];
      const terms = searchTerms(query);
      const matches = rows
        .filter((row) => includeArchived || row.archived === 0)
        .filter((row) => matchesAllTerms(row, terms));
      return {
        sessions: matches.slice(0, limit).map(toRecord),
        total: matches.length,
      };
    },
    get: (sessionId) => {
      const row = getDb().prepare(`${SESSION_CATALOG_SQL} AND s.id = ?`)
        .get(sessionId) as SessionCatalogRow | undefined;
      return row ? toRecord(row) : undefined;
    },
  };
}

function searchTerms(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAllTerms(row: SessionCatalogRow, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    row.title,
    row.project_name,
    row.worktree_title,
    row.branch,
    row.session_id,
    row.provider_session_id,
  ].filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function toRecord(row: SessionCatalogRow): ControlSessionSearchRecord {
  return {
    sessionId: row.session_id,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
    worktreeId: row.public_worktree_id,
    worktreeTitle: row.worktree_title,
    branch: row.branch,
    provider: row.provider,
    kind: row.kind === 'terminal' ? 'terminal' : 'chat',
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    providerSessionId: typeof row.provider_session_id === 'string' && row.provider_session_id
      ? row.provider_session_id
      : null,
    transcriptPath: row.transcript_path,
  };
}
