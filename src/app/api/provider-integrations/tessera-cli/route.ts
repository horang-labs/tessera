import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { tesseraCliSkillManager } from '@/lib/cli/tessera-cli-skill';

async function authorize(request: NextRequest): Promise<string | NextResponse> {
  const auth = await requireAuthenticatedUserId(request);
  return 'response' in auth ? auth.response : auth.userId;
}

export async function GET(request: NextRequest) {
  const userId = await authorize(request);
  if (userId instanceof NextResponse) return userId;
  const environment = await getAgentEnvironment(userId);
  return NextResponse.json(await tesseraCliSkillManager.inspect(environment));
}

export async function POST(request: NextRequest) {
  const userId = await authorize(request);
  if (userId instanceof NextResponse) return userId;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.operation !== 'remove') {
    return NextResponse.json({ error: 'Only Tessera-specific skill removal is accepted.' }, { status: 400 });
  }
  const environment = await getAgentEnvironment(userId);
  if (body.expectedAgentEnvironment !== environment) {
    return NextResponse.json({ error: 'The Agent Environment changed. Re-check before removing the skill.' }, { status: 409 });
  }
  return NextResponse.json(await tesseraCliSkillManager.remove(environment));
}
