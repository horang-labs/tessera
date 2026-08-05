export interface ElectronAuthUser {
  id: string;
  username: string;
  lastLoginAt: string;
}

const ELECTRON_LOCAL_USER: ElectronAuthUser = {
  id: 'electron-local-user',
  username: 'local',
  lastLoginAt: new Date(0).toISOString(),
};

export async function getElectronAuthUser(): Promise<ElectronAuthUser> {
  return ELECTRON_LOCAL_USER;
}

export async function getElectronAuthUserId(): Promise<string> {
  const user = await getElectronAuthUser();
  return user.id;
}
