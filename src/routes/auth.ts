import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabaseAdmin } from '../config/supabase';

const router = Router();

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function calculateAge(dob: string): number {
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// POST /api/auth/sync-profile — called by mobile after Supabase signup
// Creates the app user row linked to the Supabase auth user
router.post('/sync-profile', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { username, displayName, dateOfBirth } = req.body;
    const supabaseUserId = req.userId!;

    // Check if profile already exists
    const existing = await query('SELECT id FROM users WHERE id = $1', [supabaseUserId]);
    if (existing.rows.length > 0) {
      // Profile already synced — return it
      const result = await query(
        `SELECT id, username, email, display_name, avatar_url, bio, language, email_verified, date_of_birth, created_at
         FROM users WHERE id = $1`,
        [supabaseUserId]
      );
      res.json(result.rows[0]);
      return;
    }

    if (!username) {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    if (username.length < 3 || username.length > 30) {
      res.status(400).json({ error: 'Username must be between 3 and 30 characters' });
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      res.status(400).json({ error: 'Username may only contain letters, numbers, dots, hyphens, and underscores' });
      return;
    }

    // Accept age ranges ("16-25", "26-35", "36-45+") or YYYY-MM-DD dates
    const validAgeRanges = ['16-25', '26-35', '36-45+'];
    if (dateOfBirth) {
      if (validAgeRanges.includes(dateOfBirth)) {
        // Age range — store as-is, no further validation needed
      } else if (typeof dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
        const age = calculateAge(dateOfBirth);
        if (isNaN(age) || age < 16) {
          res.status(400).json({ error: 'You must be at least 16 years old to use Pika' });
          return;
        }
      } else {
        res.status(400).json({ error: 'Invalid date of birth format' });
        return;
      }
    }

    // Check username uniqueness
    const usernameTaken = await query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
    if (usernameTaken.rows.length > 0) {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }

    // Get email from Supabase auth user
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(supabaseUserId);
    const email = authUser?.user?.email || '';
    const emailVerified = !!authUser?.user?.email_confirmed_at;

    const result = await query(
      `INSERT INTO users (id, username, email, password_hash, display_name, date_of_birth, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, email, display_name, avatar_url, bio, language, email_verified, date_of_birth, created_at`,
      [supabaseUserId, username.toLowerCase(), email.toLowerCase(), 'supabase-managed', displayName || username, dateOfBirth || null, emailVerified]
    );

    await query('UPDATE users SET is_online = true WHERE id = $1', [supabaseUserId]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Sync profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/lookup?username=xxx — resolve username to email for Supabase login
router.get('/lookup', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username } = req.query;
    if (!username || typeof username !== 'string') {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    const result = await query('SELECT email FROM users WHERE username = $1', [username.toLowerCase()]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ email: result.rows[0].email });
  } catch (err) {
    console.error('Lookup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await query('UPDATE users SET is_online = false WHERE id = $1', [req.userId]);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
