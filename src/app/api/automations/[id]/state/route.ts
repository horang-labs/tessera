import type { NextRequest } from 'next/server';
import { handleAutomationRequest } from '@/app/api/automations/handler';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handleAutomationRequest(request, { action: 'state', ...await context.params });
}
