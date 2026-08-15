import { getElectronAuthUserId } from './electron-user';
import { isElectronRuntime } from './electron-runtime';
import { readUsersFile } from './users';

export async function resolveServerDefaultUserId(): Promise<string | undefined> {
  if (isElectronRuntime()) {
    return getElectronAuthUserId();
  }

  const users = await readUsersFile();
  return users.users[0]?.id;
}
