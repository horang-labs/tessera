import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { createGhRunner } from '@/lib/github/gh-cli';
import {
  getTesseraRepositoryStarStatus,
  starTesseraRepository,
} from '@/lib/github/repository-star';
import logger from '@/lib/logger';

export const runtime = 'nodejs';

async function createUserGhRunner(request: NextRequest) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth;

  const agentEnvironment = await getAgentEnvironment(auth.userId);
  return { runGh: createGhRunner(agentEnvironment) };
}

export async function GET(request: NextRequest) {
  try {
    const result = await createUserGhRunner(request);
    if ('response' in result) return result.response;

    const status = await getTesseraRepositoryStarStatus(result.runGh);
    return NextResponse.json({ status });
  } catch (error) {
    logger.error({ error }, 'GET /api/github/star error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const result = await createUserGhRunner(request);
    if ('response' in result) return result.response;

    const starred = await starTesseraRepository(result.runGh);
    if (!starred) {
      return NextResponse.json(
        { starred: false },
        { status: 502 },
      );
    }

    return NextResponse.json({ starred: true });
  } catch (error) {
    logger.error({ error }, 'PUT /api/github/star error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
