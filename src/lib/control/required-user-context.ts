import { ControlOperationError } from './service';

/** Memoize the runtime user shared by Control adapters, retrying unavailable lookups. */
export function createRequiredControlUserIdResolver(options: {
  userId?: string;
  resolveUserId?: () => Promise<string | undefined>;
}): () => Promise<string> {
  let resolvedUserId = options.userId;
  let resolvingUserId: Promise<string | undefined> | undefined;

  return async () => {
    if (resolvedUserId) return resolvedUserId;
    resolvingUserId ??= Promise.resolve(options.resolveUserId?.());
    const userId = await resolvingUserId;
    if (userId) {
      resolvedUserId = userId;
      return userId;
    }
    resolvingUserId = undefined;
    throw new ControlOperationError(
      'INSTANCE_UNAVAILABLE',
      'The Tessera user context is unavailable.',
      503,
    );
  };
}
