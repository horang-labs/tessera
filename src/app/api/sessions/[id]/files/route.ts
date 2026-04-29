import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import * as dbProjects from '@/lib/db/projects';
import { getDb } from '@/lib/db/database';

const MAX_FILES = 20000;

const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  '.turbo',
  'coverage',
  '.cache',
  '.vercel',
  '.idea',
  '.vscode',
  'out',
]);

type WalkResult = { files: string[]; truncated: boolean };

interface SessionRef {
  sessionId: string;
  title: string;
}

async function walk(root: string): Promise<WalkResult> {
  const out: string[] = [];
  let truncated = false;

  async function recurse(absDir: string, relDir: string): Promise<void> {
    if (truncated) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (truncated) return;
      if (ent.name.startsWith('.') && ent.name !== '.env.example') {
        continue;
      }
      if (ent.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(ent.name)) continue;
        const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
        await recurse(path.join(absDir, ent.name), childRel);
      } else if (ent.isFile()) {
        const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
        out.push(childRel);
        if (out.length >= MAX_FILES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await recurse(root, '');
  return { files: out, truncated };
}

async function resolveSessionRoot(sessionId: string): Promise<string | null> {
  const session = dbSessions.getSession(sessionId);
  if (!session) return null;
  if (session.work_dir) return session.work_dir;
  const project = dbProjects.getProject(session.project_id);
  return project?.decoded_path ?? null;
}

function listReferenceSessions(projectId: string, currentSessionId: string): {
  chats: SessionRef[];
  tasks: SessionRef[];
} {
  const rows = getDb().prepare(`
    SELECT id, title, task_id
    FROM sessions
    WHERE project_id = ?
      AND archived = 0
      AND deleted = 0
      AND id != ?
    ORDER BY updated_at DESC
  `).all(projectId, currentSessionId) as Array<{ id: string; title: string; task_id: string | null }>;

  const chats: SessionRef[] = [];
  const tasks: SessionRef[] = [];
  for (const r of rows) {
    const entry = { sessionId: r.id, title: r.title || '(generating title)' };
    if (r.task_id == null) chats.push(entry);
    else tasks.push(entry);
  }
  return { chats, tasks };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) {
    return auth.response;
  }

  const session = dbSessions.getSession(id);
  const projectId = session?.project_id ?? null;

  const refs = projectId ? listReferenceSessions(projectId, id) : { chats: [], tasks: [] };

  const root = await resolveSessionRoot(id);
  if (!root) {
    return NextResponse.json({
      files: [],
      chats: refs.chats,
      tasks: refs.tasks,
      truncated: false,
      reason: 'no-root',
    });
  }

  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return NextResponse.json({
        files: [],
        chats: refs.chats,
        tasks: refs.tasks,
        truncated: false,
        reason: 'not-a-directory',
      });
    }
  } catch {
    return NextResponse.json({
      files: [],
      chats: refs.chats,
      tasks: refs.tasks,
      truncated: false,
      reason: 'unreadable',
    });
  }

  try {
    const result = await walk(root);
    return NextResponse.json({
      files: result.files,
      chats: refs.chats,
      tasks: refs.tasks,
      truncated: result.truncated,
    });
  } catch {
    return NextResponse.json({
      files: [],
      chats: refs.chats,
      tasks: refs.tasks,
      truncated: false,
      reason: 'walk-failed',
    });
  }
}
