'use client';

import { installRendererConsoleBridge } from '@/lib/renderer-console-bridge';

// Installed at module scope rather than in an effect: the bridge has to be live before React
// mounts anything, otherwise everything logged during hydration is lost. The install is a
// no-op on the server, outside Electron, and in a non-debug build.
installRendererConsoleBridge();

export function RendererConsoleBridge(): null {
  return null;
}
