import type {
  ControlCliBridgeContext,
  ControlCliBridgeFactory,
  PreparedControlCliBridge,
} from './cli-bridge';

let controlCliBridgeFactory: ControlCliBridgeFactory | null = null;

export function configureSharedControlCliBridge(
  factory: ControlCliBridgeFactory,
): () => Promise<void> {
  if (controlCliBridgeFactory && controlCliBridgeFactory !== factory) {
    throw new Error('The shared Control CLI bridge is already configured.');
  }
  controlCliBridgeFactory = factory;
  let released = false;
  let releaseInFlight: Promise<void> | null = null;
  return async () => {
    if (released) return;
    if (releaseInFlight) return releaseInFlight;
    if (controlCliBridgeFactory === factory) controlCliBridgeFactory = null;
    const release = Promise.resolve()
      .then(() => factory.dispose())
      .then(() => { released = true; });
    releaseInFlight = release;
    try {
      await release;
    } finally {
      if (releaseInFlight === release) releaseInFlight = null;
    }
  };
}

export function prepareSharedControlCliBridge(
  context: ControlCliBridgeContext,
): Promise<PreparedControlCliBridge> {
  if (!controlCliBridgeFactory) {
    throw new Error('The exact-instance Tessera CLI bridge is unavailable.');
  }
  return controlCliBridgeFactory.create(context);
}
