import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbProjects from '@/lib/db/projects';
import logger from '@/lib/logger';

/**
 * GET /api/projects/preparation-script?projectId=...
 * Returns the project's preparation script, or null when it has none.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const projectId = req.nextUrl.searchParams.get('projectId')?.trim();
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  try {
    const project = dbProjects.getProject(projectId);
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    return NextResponse.json({ preparationScript: project.preparation_script ?? null });
  } catch (error) {
    logger.error({ error, projectId }, 'Failed to read preparation script');
    return NextResponse.json({ error: 'Failed to read preparation script' }, { status: 500 });
  }
}

/**
 * PUT /api/projects/preparation-script
 * Body: { projectId: string, preparationScript: string | null }
 * A blank script clears it. Returns what was stored.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { projectId, preparationScript } = body as {
    projectId?: unknown;
    preparationScript?: unknown;
  };

  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  if (
    preparationScript !== null
    && preparationScript !== undefined
    && typeof preparationScript !== 'string'
  ) {
    return NextResponse.json({ error: 'preparationScript must be a string or null' }, { status: 400 });
  }

  const normalizedProjectId = projectId.trim();

  try {
    if (!dbProjects.getProject(normalizedProjectId)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    const stored = dbProjects.setPreparationScript(
      normalizedProjectId,
      preparationScript ?? null,
    );
    return NextResponse.json({ preparationScript: stored });
  } catch (error) {
    logger.error({ error, projectId: normalizedProjectId }, 'Failed to save preparation script');
    return NextResponse.json({ error: 'Failed to save preparation script' }, { status: 500 });
  }
}
