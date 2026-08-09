interface PairedDeviceLifecycleLock {
  mutationQueue: Promise<void>;
}

const LIFECYCLE_LOCK_KEY = Symbol.for('tessera.pairedDeviceLifecycleLock');
const lifecycleGlobal = globalThis as typeof globalThis & {
  [LIFECYCLE_LOCK_KEY]?: PairedDeviceLifecycleLock;
};
const lifecycleLock = lifecycleGlobal[LIFECYCLE_LOCK_KEY] ??= {
  mutationQueue: Promise.resolve(),
};

export async function withPairedDeviceLifecycle<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  const previousMutation = lifecycleLock.mutationQueue;
  let releaseMutation!: () => void;
  lifecycleLock.mutationQueue = new Promise<void>((resolve) => { releaseMutation = resolve; });
  await previousMutation;
  try {
    return await operation();
  } finally {
    releaseMutation();
  }
}
