import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import {
  PROVIDER_SKILL_IDS,
  type ProviderSkillId,
} from './provider-skill-management';
import { isProviderSkillId } from './provider-skill-id';
import type { AgentEnvironment } from '@/lib/settings/types';
import type { ProviderSkillIntegrationResult } from './provider-integration';
import type { ProviderSkillGuiRequest } from './provider-skill-policy';

export type ProviderSkillRouteManager = (
  userId: string,
  request: ProviderSkillGuiRequest,
) => Promise<ProviderSkillIntegrationResult>;

type ResolveUserId = (request: NextRequest) => Promise<string | NextResponse>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProviderIds(value: unknown): { providerIds?: ProviderSkillId[]; error?: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((providerId) => typeof providerId !== 'string')) {
    return { error: 'providerIds must be an array of supported provider IDs.' };
  }
  if (value.length === 0) return {};
  const providerIds = [...new Set(value)] as string[];
  const unsupported = providerIds.find((providerId) => (
    !isProviderSkillId(providerId)
  ));
  return unsupported
    ? { error: `Unsupported provider: ${unsupported}` }
    : { providerIds: providerIds as ProviderSkillId[] };
}

function responseStatus(result: ProviderSkillIntegrationResult): number {
  if (result.success) return 200;
  if (result.error?.code === 'PROVIDER_SKILL_CONFLICT') return 409;
  if (result.error?.code === 'PROVIDER_SKILL_ENVIRONMENT_CHANGED') return 409;
  if (result.error?.code === 'PROVIDER_SKILL_TRANSACTION_FAILED') return 503;
  return 400;
}

async function defaultResolveUserId(request: NextRequest): Promise<string | NextResponse> {
  const auth = await requireAuthenticatedUserId(request);
  return 'response' in auth ? auth.response : auth.userId;
}

export function createProviderSkillRoute(
  manager: ProviderSkillRouteManager,
  resolveUserId: ResolveUserId = defaultResolveUserId,
) {
  const authorize = async (request: NextRequest): Promise<string | NextResponse> => (
    resolveUserId(request)
  );
  const respond = async (
    userId: string,
    request: ProviderSkillGuiRequest,
  ): Promise<NextResponse> => {
    try {
      const result = await manager(userId, request);
      return NextResponse.json(result, { status: responseStatus(result) });
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 503 });
    }
  };

  return {
    GET: async (request: NextRequest) => {
      const userId = await authorize(request);
      if (userId instanceof NextResponse) return userId;
      const allProviders = request.nextUrl.searchParams.get('all') === '1';
      const selectedProviders = request.nextUrl.searchParams.getAll('provider');
      if (allProviders && selectedProviders.length > 0) {
        return NextResponse.json({ error: 'Use either all=1 or provider selections, not both.' }, { status: 400 });
      }
      const parsed = allProviders
        ? { providerIds: [...PROVIDER_SKILL_IDS] }
        : parseProviderIds(selectedProviders);
      if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
      return respond(userId, { operation: 'status', ...parsed });
    },
    POST: async (request: NextRequest) => {
      const userId = await authorize(request);
      if (userId instanceof NextResponse) return userId;
      let body: Record<string, unknown>;
      try {
        const parsed = await request.json() as unknown;
        body = isRecord(parsed) ? parsed : {};
      } catch {
        return NextResponse.json({ error: 'A JSON provider skill operation is required.' }, { status: 400 });
      }
      const unknownField = Object.keys(body).find((key) => (
        !['operation', 'providerIds', 'expectedAgentEnvironment'].includes(key)
      ));
      if (unknownField) {
        return NextResponse.json({ error: `Unknown provider skill field: ${unknownField}` }, { status: 400 });
      }
      if (!['install', 'update', 'remove'].includes(String(body.operation))) {
        return NextResponse.json({ error: 'operation must be install, update, or remove.' }, { status: 400 });
      }
      const parsed = parseProviderIds(body.providerIds);
      if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
      if (!parsed.providerIds) {
        return NextResponse.json({
          error: 'providerIds must explicitly select at least one provider.',
        }, { status: 400 });
      }
      if (body.expectedAgentEnvironment !== 'native' && body.expectedAgentEnvironment !== 'wsl') {
        return NextResponse.json({
          error: 'expectedAgentEnvironment must identify the environment shown to the user.',
        }, { status: 400 });
      }
      return respond(userId, {
        operation: body.operation as 'install' | 'update' | 'remove',
        expectedAgentEnvironment: body.expectedAgentEnvironment as AgentEnvironment,
        ...parsed,
      });
    },
  };
}
