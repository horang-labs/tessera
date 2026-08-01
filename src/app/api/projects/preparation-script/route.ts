import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbProjects from '@/lib/db/projects';
import {
  PREPARATION_PHASES,
  type PreparationPhase,
} from '@/lib/projects/preparation-status-policy';
import logger from '@/lib/logger';

/**
 * GET /api/projects/preparation-script?projectId=...
 * Returns both of the project's preparation scripts, either of which may be
 * null when that stage has nothing to run.
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
    return NextResponse.json({
      preparationScript: project.preparation_script ?? null,
      preparationAfterScript: project.preparation_after_script ?? null,
    });
  } catch (error) {
    logger.error({ error, projectId }, 'Failed to read preparation script');
    return NextResponse.json({ error: 'Failed to read preparation script' }, { status: 500 });
  }
}

/**
 * PUT /api/projects/preparation-script
 * Body: { projectId: string, preparationScript: string | null, phase?: 'before' | 'after' }
 * A blank script clears it. Omitting the phase writes the blocking one, which
 * is what every caller wrote before there was a second stage.
 * Returns what was stored.
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

  const { projectId, preparationScript, phase } = body as {
    projectId?: unknown;
    preparationScript?: unknown;
    phase?: unknown;
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
  if (
    phase !== undefined
    && !(PREPARATION_PHASES as readonly unknown[]).includes(phase)
  ) {
    return NextResponse.json(
      { error: `phase must be one of ${PREPARATION_PHASES.join(', ')}` },
      { status: 400 },
    );
  }

  const normalizedProjectId = projectId.trim();

  try {
    if (!dbProjects.getProject(normalizedProjectId)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    const stored = dbProjects.setPreparationScript(
      normalizedProjectId,
      preparationScript ?? null,
      (phase as PreparationPhase | undefined) ?? 'before',
    );
    return NextResponse.json({ preparationScript: stored });
  } catch (error) {
    logger.error({ error, projectId: normalizedProjectId }, 'Failed to save preparation script');
    return NextResponse.json({ error: 'Failed to save preparation script' }, { status: 500 });
  }
}
