import jwt from 'jsonwebtoken';
import { JWTPayload } from '@/types/auth';
import { loadPrivateKey, loadPublicKey } from './keys';

const TOKEN_LIFETIME = 604800; // 7 days in seconds

// Token verification cache (60s TTL)
const tokenCache = new Map<string, { payload: JWTPayload; expiresAt: number }>();

export async function generateToken(userId: string, username: string): Promise<string> {
  const privateKey = await loadPrivateKey();

  const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
    sub: userId,
    username,
    iss: 'tessera',
    aud: 'tessera-users',
  };

  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    expiresIn: TOKEN_LIFETIME,
  });
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  try {
    const publicKey = await loadPublicKey();

    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'tessera',
      audience: 'tessera-users',
      clockTolerance: 60,
    }) as JWTPayload;

    // Cache for 60 seconds
    tokenCache.set(token, {
      payload: decoded,
      expiresAt: Date.now() + 60000,
    });

    return decoded;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'TokenExpiredError') {
        console.log('[Auth] Token expired');
      } else if (error.name === 'JsonWebTokenError') {
        console.warn('[Auth] Invalid token:', error.message);
      }
    }
    return null;
  }
}
