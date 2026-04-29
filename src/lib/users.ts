import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { User, UserJSON, UsersFile } from '@/types/auth';
import { hashPassword } from './auth/password';

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

const USERS_FILE_PATH = expandHome(process.env.USERS_FILE_PATH || path.join(os.homedir(), '.tessera', 'users.json'));

let usersCacheData: UsersFile | null = null;
let usersCacheExpiry = 0;

function userJSONToUser(userJSON: UserJSON): User {
  return {
    ...userJSON,
    createdAt: new Date(userJSON.createdAt),
    lastLoginAt: new Date(userJSON.lastLoginAt),
  };
}

function userToUserJSON(user: User): UserJSON {
  return {
    ...user,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt.toISOString(),
  };
}

export async function readUsersFile(): Promise<UsersFile> {
  if (usersCacheData && usersCacheExpiry > Date.now()) {
    return usersCacheData;
  }

  try {
    const data = await fs.readFile(USERS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(data) as UsersFile;

    usersCacheData = parsed;
    usersCacheExpiry = Date.now() + 300000; // Cache for 5 min

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { users: [] };
    }
    throw error;
  }
}

export async function writeUsersFile(data: UsersFile): Promise<void> {
  const dir = path.dirname(USERS_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(USERS_FILE_PATH, JSON.stringify(data, null, 2));

  // Invalidate cache
  usersCacheData = null;
}

export async function findUserByUsername(username: string): Promise<User | null> {
  const data = await readUsersFile();
  const userJSON = data.users.find(u => u.username === username);
  return userJSON ? userJSONToUser(userJSON) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const data = await readUsersFile();
  const userJSON = data.users.find(u => u.id === id);
  return userJSON ? userJSONToUser(userJSON) : null;
}

export async function updateLastLogin(userId: string): Promise<void> {
  const data = await readUsersFile();
  const userJSON = data.users.find(u => u.id === userId);

  if (userJSON) {
    userJSON.lastLoginAt = new Date().toISOString();
    await writeUsersFile(data);
  }
}

export async function createUser(username: string, password: string): Promise<User> {
  const passwordHash = await hashPassword(password);
  const now = new Date();

  const user: User = {
    id: uuidv4(),
    username,
    passwordHash,
    createdAt: now,
    lastLoginAt: now,
  };

  const data = await readUsersFile();
  data.users.push(userToUserJSON(user));
  await writeUsersFile(data);

  return user;
}

export async function hasAnyUsers(): Promise<boolean> {
  const data = await readUsersFile();
  return data.users.length > 0;
}

export async function createFirstUser(username: string, password: string): Promise<User> {
  const data = await readUsersFile();
  if (data.users.length > 0) {
    throw new Error('A user already exists.');
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();
  const user: User = {
    id: uuidv4(),
    username,
    passwordHash,
    createdAt: now,
    lastLoginAt: now,
  };

  await writeUsersFile({
    users: [userToUserJSON(user)],
  });

  return user;
}
