import type { NextRequest } from 'next/server';
import { handleAutomationRequest } from '@/app/api/automations/handler';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string; runId: string }> }) {
  return handleAutomationRequest(request, { action: 'resolve', ...await context.params });
}
