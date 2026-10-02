import type { NextRequest } from 'next/server';
import { handleAutomationRequest } from '@/app/api/automations/handler';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handleAutomationRequest(request, { action: 'detail', ...await context.params });
}
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handleAutomationRequest(request, { action: 'edit', ...await context.params });
}
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handleAutomationRequest(request, { action: 'delete', ...await context.params });
}
