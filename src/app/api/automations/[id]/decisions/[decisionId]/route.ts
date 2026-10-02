import type { NextRequest } from 'next/server';
import { handleAutomationRequest } from '@/app/api/automations/handler';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string; decisionId: string }> }) {
  return handleAutomationRequest(request, { action: 'decision', ...await context.params });
}
