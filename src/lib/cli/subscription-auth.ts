import type { ExecResult } from './cli-exec';

/** Unknown/failed probes must not be mistaken for a change of billing mode. */
export function hasClaudeSubscription(result: ExecResult): boolean | null {
  if (!result.ok) return null;
  try {
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object') return null;
    if (value.apiProvider && value.apiProvider !== 'firstParty') return false;
    if (value.authMethod === 'claude.ai') return value.subscriptionType !== null;
    if (['api_key', 'api_key_helper', 'oauth_token', 'third_party'].includes(value.authMethod)) return false;
  } catch { /* Older CLIs may not return JSON. */ }
  return null;
}

export interface CodexAccountStatus {
  account?: { type?: string } | null;
  requiresOpenaiAuth?: boolean;
}

export function hasCodexSubscription(account: CodexAccountStatus): boolean | null {
  if (account.requiresOpenaiAuth === false) return false;
  if (account.account?.type === 'chatgpt') return true;
  if (account.account?.type === 'apiKey' || account.account?.type === 'amazonBedrock') return false;
  return null;
}
