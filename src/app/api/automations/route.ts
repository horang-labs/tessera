import type { NextRequest } from 'next/server';
import { handleAutomationRequest } from '@/app/api/automations/handler';

export function GET(request: NextRequest) {
  return handleAutomationRequest(request, { action: 'list' });
}
export function POST(request: NextRequest) {
  return handleAutomationRequest(request, { action: 'create' });
}
