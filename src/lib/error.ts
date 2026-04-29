import { AuthError } from '@/types/auth';

export function createAuthError(
  type: string,
  title: string,
  status: number,
  detail: string,
  instance: string
): AuthError {
  return {
    type: `urn:tessera:error:${type}`,
    title,
    status,
    detail,
    instance,
    timestamp: new Date().toISOString(),
  };
}
