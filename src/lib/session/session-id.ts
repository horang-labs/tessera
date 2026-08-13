/** Client-only Session identity used while creation is still in flight. */
export function isOptimisticSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith('temp-');
}
