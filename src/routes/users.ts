import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, optionalAuthenticate, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { isValidCoordinates, escapeILIKE, safeUnlinkUpload, isValidUUID } from '../utils/validation';

const router = Router();

const profileUpdateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 updates per window
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const avatarUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 avatar uploads per hour
  message: { error: 'Too many avatar uploads. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/users/search?q=query - Search users
router.get('/search', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { q } = req.query;

    if (!q || (q as string).length < 2 || (q as string).length > 100) {
      res.status(400).json({ error: 'Search query must be between 2 and 100 characters' });
      return;
    }

    const result = await query(
      `SELECT id, username, display_name, avatar_url
       FROM users
       WHERE (username ILIKE $1 OR display_name ILIKE $1)
         AND ($2::uuid IS NULL OR id != $2)
       LIMIT 20`,
      [`%${escapeILIKE(q as string)}%`, req.userId || null]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Search users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/users/me - Get current user profile
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, username, email, display_name, avatar_url, bio, language,
              last_location_lat, last_location_lng, is_online, date_of_birth, created_at
       FROM users WHERE id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/users/:id - Get user profile
router.get('/:id', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.id)) {
      res.status(400).json({ error: 'Invalid user ID format' });
      return;
    }

    // Single query with subqueries instead of N+1
    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.created_at,
        (SELECT COUNT(*)::integer FROM posts WHERE user_id = u.id) as post_count,
        (SELECT COUNT(*)::integer FROM friendships
         WHERE (requester_id = u.id OR addressee_id = u.id) AND status = 'accepted') as friend_count
       FROM users u WHERE u.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Check friendship status with current user (only if authenticated)
    let friendshipStatus = null;
    let friendshipRequester = null;
    if (req.userId) {
      const friendship = await query(
        `SELECT status, requester_id FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2)
            OR (requester_id = $2 AND addressee_id = $1)`,
        [req.userId, req.params.id]
      );
      const rawStatus = friendship.rows[0]?.status || null;
      // Hide 'blocked' status to prevent revealing block to the blocked user
      friendshipStatus = rawStatus === 'blocked' ? null : rawStatus;
      friendshipRequester = rawStatus === 'blocked' ? null : (friendship.rows[0]?.requester_id || null);
    }

    res.json({
      ...result.rows[0],
      friendship_status: friendshipStatus,
      friendship_requester: friendshipRequester,
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/me - Update profile
router.put('/me', authenticate, profileUpdateLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { displayName, bio, language, dateOfBirth } = req.body;

    // Input type and length validation
    if (displayName !== undefined && displayName !== null) {
      if (typeof displayName !== 'string') {
        res.status(400).json({ error: 'Display name must be a string' });
        return;
      }
      if (displayName.trim().length === 0) {
        res.status(400).json({ error: 'Display name cannot be empty or whitespace only' });
        return;
      }
      if (displayName.length > 100) {
        res.status(400).json({ error: 'Display name must be 100 characters or less' });
        return;
      }
    }
    if (bio !== undefined && bio !== null) {
      if (typeof bio !== 'string') {
        res.status(400).json({ error: 'Bio must be a string' });
        return;
      }
      if (bio.length > 500) {
        res.status(400).json({ error: 'Bio must be 500 characters or less' });
        return;
      }
    }
    const validLanguages = ['en', 'sq', 'de', 'fr', 'it', 'es', 'pt', 'nl', 'tr', 'el', 'sr', 'mk', 'bs', 'hr', 'ro', 'bg'];
    if (language && !validLanguages.includes(language)) {
      res.status(400).json({ error: 'Invalid language code' });
      return;
    }

    // If dateOfBirth provided, validate and allow one-time set only
    if (dateOfBirth) {
      if (typeof dateOfBirth !== 'string') {
        res.status(400).json({ error: 'Date of birth must be a string' });
        return;
      }
      const birth = new Date(dateOfBirth);
      if (isNaN(birth.getTime())) {
        res.status(400).json({ error: 'Invalid date of birth format' });
        return;
      }
      const existing = await query('SELECT date_of_birth FROM users WHERE id = $1', [req.userId]);
      if (existing.rows[0]?.date_of_birth) {
        // Already set — ignore (one-time only)
      } else {
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const md = today.getMonth() - birth.getMonth();
        if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) age--;
        if (age < 16) {
          res.status(400).json({ error: 'You must be at least 16 years old' });
          return;
        }
        await query('UPDATE users SET date_of_birth = $2, updated_at = NOW() WHERE id = $1', [req.userId, birth.toISOString()]);
      }
    }

    // Build SET clause dynamically — allows clearing fields by sending null
    const setClauses: string[] = [];
    const params: any[] = [req.userId];

    if ('displayName' in req.body) {
      params.push(displayName ?? null);
      setClauses.push(`display_name = $${params.length}`);
    }
    if ('bio' in req.body) {
      params.push(bio ?? null);
      setClauses.push(`bio = $${params.length}`);
    }
    if ('language' in req.body) {
      params.push(language ?? null);
      setClauses.push(`language = $${params.length}`);
    }

    // If no profile fields to update (e.g., only dateOfBirth was sent), still return current profile
    if (setClauses.length === 0) {
      const current = await query(
        `SELECT id, username, email, display_name, avatar_url, bio, language, date_of_birth
         FROM users WHERE id = $1`,
        [req.userId]
      );
      res.json(current.rows[0]);
      return;
    }

    setClauses.push('updated_at = NOW()');

    const result = await query(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $1
       RETURNING id, username, email, display_name, avatar_url, bio, language, date_of_birth`,
      params
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/me/avatar - Upload avatar
router.put('/me/avatar', authenticate, avatarUploadLimiter, upload.single('avatar'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Avatar file is required' });
      return;
    }

    // Fetch old avatar URL before overwriting
    const oldResult = await query('SELECT avatar_url FROM users WHERE id = $1', [req.userId]);
    const oldAvatarUrl = oldResult.rows[0]?.avatar_url;

    const avatarUrl = `/uploads/${req.file.filename}`;

    const result = await query(
      `UPDATE users SET avatar_url = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, avatar_url`,
      [req.userId, avatarUrl]
    );

    // Clean up old avatar file (with path traversal protection)
    if (oldAvatarUrl && oldAvatarUrl.startsWith('/uploads/')) {
      safeUnlinkUpload(oldAvatarUrl);
    }

    res.json(result.rows[0]);
  } catch (err) {
    // Clean up orphaned file on DB failure (safe: logs + ignores unlink errors)
    if (req.file?.filename) {
      safeUnlinkUpload(`/uploads/${req.file.filename}`);
    }
    console.error('Upload avatar error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/me/location - Update location
router.put('/me/location', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { latitude, longitude } = req.body;

    if (typeof latitude !== 'number' || typeof longitude !== 'number' || !isValidCoordinates(latitude, longitude)) {
      res.status(400).json({ error: 'Invalid coordinates' });
      return;
    }

    await query(
      'UPDATE users SET last_location_lat = $2, last_location_lng = $3 WHERE id = $1',
      [req.userId, latitude, longitude]
    );

    res.json({ message: 'Location updated' });
  } catch (err) {
    console.error('Update location error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
