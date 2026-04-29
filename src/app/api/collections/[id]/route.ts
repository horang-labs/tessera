import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbCollections from '@/lib/db/collections';
import { isCollection } from '@/types/collection';
import logger from '@/lib/logger';

/**
 * PATCH /api/collections/[id]
 * Updates a collection's label or color.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;

  if (!isCollection(id)) {
    return NextResponse.json({ error: 'Invalid collection ID' }, { status: 400 });
  }

  if (!dbCollections.collectionExists(id)) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { label, color, sortOrder } = body as { label?: unknown; color?: unknown; sortOrder?: unknown };
  const patch: Partial<{ label: string; color: string; sort_order: number }> = {};

  if (label !== undefined) {
    if (typeof label !== 'string' || label.trim().length === 0) {
      return NextResponse.json({ error: 'Label is required' }, { status: 400 });
    }
    if (label.length > 40) {
      return NextResponse.json({ error: 'Label must be 40 characters or less' }, { status: 400 });
    }
    patch.label = label.trim();
  }

  if (color !== undefined) {
    if (typeof color !== 'string' || !color.startsWith('#')) {
      return NextResponse.json({ error: 'Invalid color format' }, { status: 400 });
    }
    patch.color = color;
  }

  if (sortOrder !== undefined) {
    if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder) || sortOrder < 0) {
      return NextResponse.json({ error: 'Invalid sortOrder' }, { status: 400 });
    }
    patch.sort_order = sortOrder;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  try {
    dbCollections.updateCollection(id, patch);
    logger.info({ id, ...patch }, 'Collection updated');
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    logger.error({ id, error: err }, 'Failed to update collection');
    return NextResponse.json({ error: 'Failed to update collection' }, { status: 500 });
  }
}

/**
 * DELETE /api/collections/[id]
 * Deletes a collection and resets collection_id to null for its sessions.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;

  if (!isCollection(id)) {
    return NextResponse.json({ error: 'Invalid collection ID' }, { status: 400 });
  }

  if (!dbCollections.collectionExists(id)) {
    return NextResponse.json({ error: 'Collection not found' }, { status: 404 });
  }

  try {
    const { movedCount } = dbCollections.deleteCollection(id);
    logger.info({ id, movedCount }, 'Collection deleted');
    return NextResponse.json({ ok: true, movedCount });
  } catch (err: unknown) {
    logger.error({ id, error: err }, 'Failed to delete collection');
    return NextResponse.json({ error: 'Failed to delete collection' }, { status: 500 });
  }
}
