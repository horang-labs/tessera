export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: Date;
  lastLoginAt: Date;
}

export interface UserJSON {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface UsersFile {
  users: UserJSON[];
}

export interface JWTPayload {
  sub: string;
  username: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface AuthError {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  timestamp: string;
}

export interface LoginResponse {
  success: boolean;
  user: {
    id: string;
    username: string;
  };
}

export interface LogoutResponse {
  success: boolean;
  message: string;
}

export interface MeResponse {
  user: {
    id: string;
    username: string;
    lastLoginAt: string;
  };
}
