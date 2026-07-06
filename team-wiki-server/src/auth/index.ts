/**
 * Authentication middleware.
 * Supports Bearer token and JWT-based auth.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

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
        next();
        return;
      }

      // Try JWT
      if (config.jwtSecret) {
        try {
      const decoded = jwt.verify(token, config.jwtSecret);
          (req as any).userId = (decoded as any).sub || (decoded as any).userId || 'user';
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
