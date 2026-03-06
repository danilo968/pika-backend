import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, optionalAuthenticate, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';

const router = Router();

// GET /api/users/search?q=query - Search users
router.get('/search', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { q } = req.query;

    if (!q || (q as string).length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    const result = await query(
      `SELECT id, username, display_name, avatar_url
       FROM users
       WHERE (username ILIKE $1 OR display_name ILIKE $1)
         AND id != $2
       LIMIT 20`,
      [`%${q}%`, req.userId]
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
              last_location_lat, last_location_lng, is_online, created_at
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
    const result = await query(
      `SELECT id, username, display_name, avatar_url, bio, created_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Get post count
    const postCount = await query(
      'SELECT COUNT(*)::integer FROM posts WHERE user_id = $1',
      [req.params.id]
    );

    // Get friend count
    const friendCount = await query(
      `SELECT COUNT(*)::integer FROM friendships
       WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'`,
      [req.params.id]
    );

    // Check friendship status with current user
    const friendship = await query(
      `SELECT status, requester_id FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1)`,
      [req.userId, req.params.id]
    );

    res.json({
      ...result.rows[0],
      post_count: postCount.rows[0].count,
      friend_count: friendCount.rows[0].count,
      friendship_status: friendship.rows[0]?.status || null,
      friendship_requester: friendship.rows[0]?.requester_id || null,
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/me - Update profile
router.put('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { displayName, bio, language } = req.body;

    const result = await query(
      `UPDATE users SET
        display_name = COALESCE($2, display_name),
        bio = COALESCE($3, bio),
        language = COALESCE($4, language),
        updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, email, display_name, avatar_url, bio, language`,
      [req.userId, displayName, bio, language]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/me/avatar - Upload avatar
router.put('/me/avatar', authenticate, upload.single('avatar'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Avatar file is required' });
      return;
    }

    const avatarUrl = `/uploads/${req.file.filename}`;

    const result = await query(
      `UPDATE users SET avatar_url = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, avatar_url`,
      [req.userId, avatarUrl]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Upload avatar error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/users/me/location - Update location
router.put('/me/location', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { latitude, longitude } = req.body;

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
