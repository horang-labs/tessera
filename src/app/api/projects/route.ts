import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import * as dbProjects from '@/lib/db/projects';

/**
 * POST /api/projects — Register a project directory (no session creation).
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { folderPath } = body as { folderPath?: string };

  if (!folderPath || typeof folderPath !== 'string') {
    return NextResponse.json({ error: 'folderPath is required' }, { status: 400 });
  }

  const resolvedPath = path.resolve(folderPath);

  if (!fs.existsSync(resolvedPath)) {
    return NextResponse.json({ error: 'Directory does not exist' }, { status: 400 });
  }

  const displayName = path.basename(resolvedPath);
  dbProjects.registerProject(resolvedPath, resolvedPath, displayName);

  return NextResponse.json({ ok: true, projectId: resolvedPath, displayName });
}
