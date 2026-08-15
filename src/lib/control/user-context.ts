import { getElectronAuthUserId } from '@/lib/electron-user';
import { isElectronRuntime } from '@/lib/electron-runtime';
import { readUsersFile } from '@/lib/users';

interface ControlUserIdDependencies {
  isElectronRuntime(): boolean;
  getElectronAuthUserId(): Promise<string>;
  readFirstUserId(): Promise<string | undefined>;
}

const defaultDependencies: ControlUserIdDependencies = {
  isElectronRuntime,
  getElectronAuthUserId,
  readFirstUserId: async () => (await readUsersFile()).users[0]?.id,
};

/** Resolve the same runtime user identity used by HTTP and WebSocket auth. */
export async function resolveControlUserId(
  dependencies: ControlUserIdDependencies = defaultDependencies,
): Promise<string | undefined> {
  if (dependencies.isElectronRuntime()) {
    return dependencies.getElectronAuthUserId();
  }
  return dependencies.readFirstUserId();
}
