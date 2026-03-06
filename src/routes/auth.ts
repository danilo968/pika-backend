import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { generateCode, sendVerificationEmail, sendPasswordResetEmail } from '../services/email';

const router = Router();

function generateTokens(userId: string) {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET!, {
    expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as any,
  });
  const refreshToken = jwt.sign({ userId, tokenId: uuidv4() }, process.env.JWT_REFRESH_SECRET!, {
    expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as any,
  });
  return { accessToken, refreshToken };
}

// POST /api/auth/signup
router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { username, email, password, displayName } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }

    if (username.length < 3 || username.length > 30) {
      res.status(400).json({ error: 'Username must be between 3 and 30 characters' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username.toLowerCase(), email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Username or email already taken' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (username, email, password_hash, display_name, email_verified)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id, username, email, display_name, avatar_url, bio, language, email_verified, created_at`,
      [username.toLowerCase(), email.toLowerCase(), passwordHash, displayName || username]
    );

    const user = result.rows[0];
    const { accessToken, refreshToken } = generateTokens(user.id);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshToken, expiresAt]
    );

    // Send verification email (non-blocking — don't fail signup if email fails)
    try {
      const code = generateCode();
      const codeExpiry = new Date(Date.now() + 15 * 60 * 1000);
      await query('DELETE FROM email_verification_codes WHERE user_id = $1', [user.id]);
      await query(
        'INSERT INTO email_verification_codes (user_id, code, expires_at) VALUES ($1, $2, $3)',
        [user.id, code, codeExpiry]
      );
      await sendVerificationEmail(email.toLowerCase(), code);
    } catch (emailErr) {
      console.error('Failed to send verification email:', emailErr);
    }

    res.status(201).json({
      user,
      accessToken,
      refreshToken,
      requiresVerification: true,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/verify-email
router.post('/verify-email', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ error: 'Verification code is required' });
      return;
    }

    const userResult = await query('SELECT email_verified FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows[0]?.email_verified) {
      res.json({ message: 'Email already verified' });
      return;
    }

    const codeResult = await query(
      `SELECT * FROM email_verification_codes
       WHERE user_id = $1 AND code = $2 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [req.userId, code]
    );

    if (codeResult.rows.length === 0) {
      res.status(400).json({ error: 'Invalid or expired verification code' });
      return;
    }

    await query('UPDATE users SET email_verified = true WHERE id = $1', [req.userId]);
    await query('DELETE FROM email_verification_codes WHERE user_id = $1', [req.userId]);

    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userResult = await query('SELECT email, email_verified FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (user.email_verified) {
      res.json({ message: 'Email already verified' });
      return;
    }

    // Rate limit: 60 seconds between resends
    const recent = await query(
      `SELECT created_at FROM email_verification_codes
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '60 seconds'`,
      [req.userId]
    );
    if (recent.rows.length > 0) {
      res.status(429).json({ error: 'Please wait before requesting another code' });
      return;
    }

    const code = generateCode();
    const codeExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await query('DELETE FROM email_verification_codes WHERE user_id = $1', [req.userId]);
    await query(
      'INSERT INTO email_verification_codes (user_id, code, expires_at) VALUES ($1, $2, $3)',
      [req.userId, code, codeExpiry]
    );
    await sendVerificationEmail(user.email, code);

    res.json({ message: 'Verification code sent' });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const userResult = await query(
      'SELECT id, email FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    // Always respond success to prevent email enumeration
    if (userResult.rows.length === 0) {
      res.json({ message: 'If an account exists with that email, a reset code has been sent' });
      return;
    }

    const user = userResult.rows[0];

    // Rate limit: 60 seconds between resends
    const recent = await query(
      `SELECT created_at FROM password_reset_codes
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '60 seconds'`,
      [user.id]
    );
    if (recent.rows.length > 0) {
      res.json({ message: 'If an account exists with that email, a reset code has been sent' });
      return;
    }

    const code = generateCode();
    const codeExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await query('DELETE FROM password_reset_codes WHERE user_id = $1', [user.id]);
    await query(
      'INSERT INTO password_reset_codes (user_id, code, expires_at) VALUES ($1, $2, $3)',
      [user.id, code, codeExpiry]
    );
    await sendPasswordResetEmail(user.email, code);

    res.json({ message: 'If an account exists with that email, a reset code has been sent' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      res.status(400).json({ error: 'Email, code, and new password are required' });
      return;
    }

    if (newPassword.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const userResult = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) {
      res.status(400).json({ error: 'Invalid reset code' });
      return;
    }

    const user = userResult.rows[0];

    const codeResult = await query(
      `SELECT * FROM password_reset_codes
       WHERE user_id = $1 AND code = $2 AND expires_at > NOW() AND used = false
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, code]
    );

    if (codeResult.rows.length === 0) {
      res.status(400).json({ error: 'Invalid or expired reset code' });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);
    await query('UPDATE password_reset_codes SET used = true WHERE id = $1', [codeResult.rows[0].id]);
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.id]);

    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { login, password } = req.body;

    if (!login || !password) {
      res.status(400).json({ error: 'Login and password are required' });
      return;
    }

    const result = await query(
      'SELECT * FROM users WHERE username = $1 OR email = $1',
      [login.toLowerCase()]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const { accessToken, refreshToken } = generateTokens(user.id);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshToken, expiresAt]
    );

    await query('UPDATE users SET is_online = true WHERE id = $1', [user.id]);

    const { password_hash, ...safeUser } = user;

    res.json({
      user: safeUser,
      accessToken,
      refreshToken,
      requiresVerification: !user.email_verified,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      res.status(400).json({ error: 'Refresh token is required' });
      return;
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET!);
    } catch {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    const stored = await query(
      'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
      [token]
    );

    if (stored.rows.length === 0) {
      res.status(401).json({ error: 'Refresh token expired or revoked' });
      return;
    }

    await query('DELETE FROM refresh_tokens WHERE token = $1', [token]);

    const { accessToken, refreshToken } = generateTokens(decoded.userId);

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [decoded.userId, refreshToken, expiresAt]
    );

    res.json({ accessToken, refreshToken });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { refreshToken: token } = req.body;

    if (token) {
      await query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
    }

    await query('UPDATE users SET is_online = false WHERE id = $1', [req.userId]);

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
