export const CODEX_LIFECYCLE_MUTATIONS = ['install', 'update', 'reconcile', 'remove'] as const;

export type CodexLifecycleMutation = typeof CODEX_LIFECYCLE_MUTATIONS[number];
export type CodexLifecycleOperation = 'status' | CodexLifecycleMutation;

export type CodexLifecycleMutationParseResult =
  | { operation: CodexLifecycleMutation }
  | { error: string };

export function parseCodexLifecycleMutation(
  body: Record<string, unknown>,
): CodexLifecycleMutationParseResult {
  const operation = body.operation;
  if (!CODEX_LIFECYCLE_MUTATIONS.includes(operation as CodexLifecycleMutation)) {
    return { error: 'Lifecycle operation must be install, update, reconcile, or remove.' };
  }
  if (operation === 'install' && body.consent !== 'granted') {
    return { error: 'Explicit Codex lifecycle hook consent is required.' };
  }
  if (operation !== 'install' && body.consent !== undefined) {
    return { error: 'Consent is accepted only for lifecycle installation.' };
  }
  return { operation: operation as CodexLifecycleMutation };
}

export function dispatchCodexLifecycleOperation<T>(
  operation: CodexLifecycleOperation,
  handlers: Record<CodexLifecycleOperation, () => T>,
): T {
  return handlers[operation]();
}
