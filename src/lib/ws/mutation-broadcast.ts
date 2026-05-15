import { wsServer } from './server';

export function getOriginClientIdFromRequest(req: Request | { headers: Headers }): string | undefined {
  const value = req.headers.get('x-tessera-client-id');
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function broadcastSessionMutation(userId: string, params: {
  kind: 'created' | 'updated' | 'deleted' | 'reordered' | 'project_reordered' | 'project_deleted';
  originClientId?: string;
  projectId?: string;
}): void {
  wsServer.sendToUser(userId, { type: 'session_mutated', ...params });
}

export function broadcastSessionTitleGeneration(
  userId: string,
  sessionId: string,
  isGenerating: boolean,
): void {
  wsServer.sendToUser(userId, {
    type: 'session_title_generation',
    sessionId,
    isGenerating,
  });
}

export function broadcastTaskMutation(userId: string, params: {
  kind: 'created' | 'updated' | 'deleted' | 'reordered';
  originClientId?: string;
  projectId: string;
}): void {
  wsServer.sendToUser(userId, { type: 'task_mutated', ...params });
}

export function broadcastCollectionMutation(userId: string, params: {
  kind: 'created' | 'updated' | 'deleted';
  originClientId?: string;
  projectId: string;
}): void {
  wsServer.sendToUser(userId, { type: 'collection_mutated', ...params });
}
