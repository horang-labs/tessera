import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { AUTOMATION_ERROR_STATUS, type AutomationErrorCode } from '@/lib/automation/contracts';
import { AutomationService, fail } from '@/lib/automation/service';
import { getAutomationService } from '@/lib/automation/startup';

const revision = z.number().int().positive();
const stateBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), expectedRevision: revision }).strict(),
  z.object({ action: z.literal('pause') }).strict(),
]);
const editBody = z.object({ expectedRevision: revision, input: z.unknown() }).strict();
const resolveBody = z.object({ resolution: z.literal('acknowledge-no-retry') }).strict();
const listQuery = z.object({
  sessionId: z.string().min(1).optional(), worktreeId: z.string().min(1).optional(),
  includeDeleted: z.enum(['true', 'false']).optional(), cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict().refine(v => !v.sessionId || !v.worktreeId);
const historyQuery = z.object({ cursor: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
type Operation = { action: 'list' | 'create' | 'detail' | 'edit' | 'state' | 'delete' | 'runs' | 'resolve' | 'ownership' | 'preview' | 'decisions' | 'decision'; id?: string; runId?: string; decisionId?: string };
async function body<T>(request: NextRequest, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try { value = await request.json(); } catch { fail('INVALID_AUTOMATION', 'A JSON body is required.'); }
  const result = schema.safeParse(value);
  if (!result.success) fail('INVALID_AUTOMATION');
  return result.data;
}
/** Shared HTTP seam; auth and origin evaluation remain the production implementation in tests. */
export async function handleAutomationRequest(request: NextRequest, operation: Operation, suppliedService?: AutomationService): Promise<NextResponse> {
  const auth = await requireAuthenticatedUserId(request, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });
  if ('response' in auth) return auth.response.status === 403
    ? NextResponse.json({ error: { code: 'OWNER_NOT_ALLOWED', message: 'Origin not allowed.' } }, { status: 403 })
    : auth.response;
  try {
    const service = suppliedService ?? getAutomationService();
    await service.authorize(auth.userId);
    const id = operation.id ?? '';
    switch (operation.action) {
      case 'list': {
        const parsed = listQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
        if (!parsed.success) fail('INVALID_AUTOMATION');
        return NextResponse.json(service.list(auth.userId, { ...parsed.data, includeDeleted: parsed.data.includeDeleted === 'true' }));
      }
      case 'create': {
        let input: unknown;
        try { input = await request.json(); } catch { fail('INVALID_AUTOMATION'); }
        return NextResponse.json(await service.create(auth.userId, request.headers.get('idempotency-key') ?? '', input), { status: 201 });
      }
      case 'detail': return NextResponse.json(service.detail(auth.userId, id));
      case 'edit': {
        const value = await body(request, editBody);
        return NextResponse.json(await service.edit(auth.userId, id, value.expectedRevision, value.input));
      }
      case 'state': {
        const value = await body(request, stateBody);
        const result = value.action === 'pause' ? await service.pause(auth.userId, id) : await service.enable(auth.userId, id, value.expectedRevision);
        return NextResponse.json(result.body, { status: result.status });
      }
      case 'delete': {
        const result = await service.pause(auth.userId, id, true);
        return NextResponse.json(result.body, { status: result.status });
      }
      case 'runs': {
        const value = historyQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
        if (!value.success) fail('INVALID_AUTOMATION');
        return NextResponse.json(service.history(auth.userId, id, value.data));
      }
      case 'resolve':
        await body(request, resolveBody);
        return NextResponse.json(await service.resolve(auth.userId, id, operation.runId ?? ''));
      case 'preview': return NextResponse.json(await service.autorun.preview(auth.userId,id,await body(request,z.unknown())));
      case 'decisions': {
        const value=historyQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
        if (!value.success) fail('INVALID_AUTOMATION');
        return NextResponse.json(service.autorun.decisions(auth.userId,id,value.data));
      }
      case 'decision': return NextResponse.json(service.autorun.decision(auth.userId,id,operation.decisionId??''));
      case 'ownership': return NextResponse.json(await service.sessionOwnership(auth.userId, id));
    }
  } catch (error) {
    const code = (error as { code?: AutomationErrorCode })?.code;
    if (code && code in AUTOMATION_ERROR_STATUS) {
      return NextResponse.json({ error: { code, message: (error as Error).message } }, { status: AUTOMATION_ERROR_STATUS[code] });
    }
    return NextResponse.json({ error: { code: 'OWNER_UNAVAILABLE', message: 'Automation state is unavailable.' } }, { status: 503 });
  }
}
