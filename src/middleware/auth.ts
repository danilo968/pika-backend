import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabase';

export interface AuthRequest extends Request {
  userId?: string;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];

  // Validate token via Supabase Auth API
  supabaseAdmin.auth.getUser(token).then(({ data, error }) => {
    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    req.userId = data.user.id;
    next();
  }).catch(() => {
    res.status(401).json({ error: 'Invalid or expired token' });
  });
}

/** Like authenticate but doesn't reject — just populates userId if token is valid */
export function optionalAuthenticate(req: AuthRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    supabaseAdmin.auth.getUser(token).then(({ data, error }) => {
      if (!error && data.user) {
        req.userId = data.user.id;
      }
      next();
    }).catch(() => {
      next();
    });
  } else {
    next();
  }
}
