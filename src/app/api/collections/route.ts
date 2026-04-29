import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbCollections from '@/lib/db/collections';
import { generateCollectionId } from '@/types/collection';
import logger from '@/lib/logger';

/**
 * GET /api/collections
 * Returns collections for a project ordered by sort_order.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId || projectId.trim().length === 0) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  try {
    const collections = dbCollections.getCollections(projectId.trim());
    return NextResponse.json({ collections });
  } catch (err: unknown) {
    logger.error({ error: err }, 'Failed to fetch collections');
    return NextResponse.json({ error: 'Failed to fetch collections' }, { status: 500 });
  }
}

/**
 * POST /api/collections
 * Creates a new collection. Body: { projectId: string, label: string, color: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { projectId, label, color } = body as {
    projectId?: unknown;
    label?: unknown;
    color?: unknown;
  };

  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  if (typeof label !== 'string' || label.trim().length === 0) {
    return NextResponse.json({ error: 'Label is required' }, { status: 400 });
  }
  if (label.length > 40) {
    return NextResponse.json({ error: 'Label must be 40 characters or less' }, { status: 400 });
  }
  if (typeof color !== 'string' || !color.startsWith('#')) {
    return NextResponse.json({ error: 'Invalid color format' }, { status: 400 });
  }

  try {
    const id = generateCollectionId();
    const normalizedProjectId = projectId.trim();
    const sortOrder = dbCollections.getNextCollectionSortOrder(normalizedProjectId);
    const collection = dbCollections.createCollection(
      id,
      normalizedProjectId,
      label.trim(),
      color,
      sortOrder
    );
    logger.info({ id, projectId: normalizedProjectId, label: label.trim() }, 'Collection created');
    return NextResponse.json({ collection }, { status: 201 });
  } catch (err: unknown) {
    logger.error({ error: err }, 'Failed to create collection');
    return NextResponse.json({ error: 'Failed to create collection' }, { status: 500 });
  }
}
