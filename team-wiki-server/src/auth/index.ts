/**
 * Authentication middleware.
 * Supports Bearer token and JWT-based auth.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export interface AuthConfig {
  /** Static bearer token for simple auth (empty = no auth) */
  bearerToken: string;
  /** JWT secret (empty = JWT disabled) */
  jwtSecret: string;
}

/**
 * Create authentication middleware.
 *
 * If both bearerToken and jwtSecret are empty, auth is disabled.
 * If bearerToken is set, clients must provide Authorization: Bearer <token>.
 * If jwtSecret is set, clients must provide a valid JWT.
 */
export function createAuthMiddleware(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth for health endpoint
    if (req.path === '/health') {
      next();
      return;
    }

    const authHeader = req.headers.authorization;

    if (!config.bearerToken && !config.jwtSecret) {
      // Auth disabled — use a default user ID
      (req as any).userId = 'anonymous';
      next();
      return;
    }

    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      // Try static bearer token first
      if (config.bearerToken && token === config.bearerToken) {
          (req as any).userId = 'user'; // single user mode
          (req as any).user = { id: 'user', username: 'token-user', role: 'admin' } satisfies AuthUser;
          next();
          return;
        }

      // Try JWT
      if (config.jwtSecret) {
        try {
      const decoded = jwt.verify(token, config.jwtSecret);
          const payload = decoded as any;
          const id = payload.sub || payload.userId || 'user';
          (req as any).userId = id;
          (req as any).user = {
            id,
            username: payload.username || 'user',
            role: payload.role === 'admin' ? 'admin' : 'user',
          } satisfies AuthUser;
          next();
          return;
        } catch {
          // JWT verification failed, fall through to error
        }
      }
    }

    res.status(401).json({ error: 'Invalid or expired token' });
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = getRequestUser(req);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin role required' });
    return;
  }
  next();
}

export function getRequestUser(req: Request): AuthUser | undefined {
  return (req as any).user as AuthUser | undefined;
}

export function getRequestUserId(req: Request): string {
  return getRequestUser(req)?.id || (req as any).userId || 'anonymous';
}
