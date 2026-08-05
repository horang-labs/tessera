import { getElectronAuthUserId } from '@/lib/auth/electron-user';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import { readUsersFile } from '@/lib/users';

interface ControlUserIdDependencies {
  isElectronAuthBypassEnabled(): boolean;
  getElectronAuthUserId(): Promise<string>;
  readFirstUserId(): Promise<string | undefined>;
}

const defaultDependencies: ControlUserIdDependencies = {
  isElectronAuthBypassEnabled,
  getElectronAuthUserId,
  readFirstUserId: async () => (await readUsersFile()).users[0]?.id,
};

/** Resolve the same runtime user identity used by HTTP and WebSocket auth. */
export async function resolveControlUserId(
  dependencies: ControlUserIdDependencies = defaultDependencies,
): Promise<string | undefined> {
  if (dependencies.isElectronAuthBypassEnabled()) {
    return dependencies.getElectronAuthUserId();
  }
  return dependencies.readFirstUserId();
}
