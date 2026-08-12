import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import type { CodexLifecycleOperation } from './codex-lifecycle-policy';
import { ProviderIntegrationEnvironmentError } from './provider-integration';
import type { ProviderIntegrationLaunchDecision } from './provider-integration';
import { parseCodexLifecycleMutation } from './codex-lifecycle-operations';

export type CodexLifecycleRouteManager = (
  userId: string,
  operation: CodexLifecycleOperation,
) => Promise<ProviderIntegrationLaunchDecision>;

export function createCodexLifecycleRoute(manager: CodexLifecycleRouteManager) {
  const respond = async (
    userId: string,
    operation: CodexLifecycleOperation,
  ): Promise<NextResponse> => {
    try {
      return NextResponse.json(await manager(userId, operation));
    } catch (error) {
      const unavailable = error instanceof ProviderIntegrationEnvironmentError;
      return NextResponse.json({
        error: unavailable
          ? 'The current Agent Environment could not be resolved.'
          : error instanceof Error ? error.message : String(error),
      }, { status: unavailable ? 503 : 500 });
    }
  };

  return {
    GET: async (request: NextRequest) => {
      const auth = await requireAuthenticatedUserId(request);
      return 'response' in auth ? auth.response : respond(auth.userId, 'status');
    },
    POST: async (request: NextRequest) => {
      const auth = await requireAuthenticatedUserId(request);
      if ('response' in auth) return auth.response;
      let body: Record<string, unknown>;
      try {
        const parsed = await request.json() as unknown;
        body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        return NextResponse.json({ error: 'A JSON lifecycle operation is required.' }, { status: 400 });
      }
      const parsed = parseCodexLifecycleMutation(body);
      if ('error' in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 });
      }
      return respond(auth.userId, parsed.operation);
    },
  };
}
