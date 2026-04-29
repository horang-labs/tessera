import { generateKeyPairSync } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

const AUTH_KEYS_DIR = expandHome(process.env.AUTH_KEYS_DIR || path.join(os.homedir(), '.tessera', 'auth'));
export const PRIVATE_KEY_PATH = path.join(AUTH_KEYS_DIR, 'private.pem');
export const PUBLIC_KEY_PATH = path.join(AUTH_KEYS_DIR, 'public.pem');

export interface RSAKeys {
  publicKey: string;
  privateKey: string;
}

export function generateRSAKeys(): RSAKeys {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return { publicKey, privateKey };
}

export async function ensureRSAKeys(): Promise<void> {
  try {
    await fs.access(PRIVATE_KEY_PATH);
    await fs.access(PUBLIC_KEY_PATH);
    console.log('[Auth] RSA keys exist');
  } catch {
    console.log('[Auth] Generating RSA key pair...');

    await fs.mkdir(AUTH_KEYS_DIR, { recursive: true });

    const { publicKey, privateKey } = generateRSAKeys();

    await fs.writeFile(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
    await fs.writeFile(PUBLIC_KEY_PATH, publicKey);

    console.log('[Auth] RSA key pair generated successfully');
  }
}

export async function loadPrivateKey(): Promise<string> {
  return await fs.readFile(PRIVATE_KEY_PATH, 'utf8');
}

export async function loadPublicKey(): Promise<string> {
  return await fs.readFile(PUBLIC_KEY_PATH, 'utf8');
}
