import { randomBytes } from 'node:crypto';
import type { AgentEnvironment } from '@/lib/settings/types';

export interface ControlAuthorityContext {
  agentEnvironment: AgentEnvironment;
  projectId: string;
  sessionId: string;
  worktreeId?: string;
}

export interface ControlAuthorityGrant {
  token: string;
  revoke(): void;
}

export interface ControlAuthoritySource {
  resolve(token: string | undefined): ControlAuthorityContext | null;
}

export interface ControlAuthorityRegistry extends ControlAuthoritySource {
  grant(context: ControlAuthorityContext): ControlAuthorityGrant;
}

export function createControlAuthorityRegistry(): ControlAuthorityRegistry {
  const authorities = new Map<string, ControlAuthorityContext>();

  return {
    grant(context) {
      let token: string;
      do {
        token = randomBytes(32).toString('base64url');
      } while (authorities.has(token));
      const authority = { ...context };
      authorities.set(token, authority);
      let revoked = false;
      return {
        token,
        revoke() {
          if (revoked) return;
          revoked = true;
          if (authorities.get(token) === authority) authorities.delete(token);
        },
      };
    },

    resolve(token) {
      if (!token) return null;
      const authority = authorities.get(token);
      return authority ? { ...authority } : null;
    },
  };
}
