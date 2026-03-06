import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { sendFriendRequestPush } from '../services/pushService';

const router = Router();

// POST /api/friends/request/:userId - Send friend request
router.post('/request/:userId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const targetId = req.params.userId;

    if (targetId === req.userId) {
      res.status(400).json({ error: 'Cannot send friend request to yourself' });
      return;
    }

    // Check if friendship already exists
    const existing = await query(
      `SELECT * FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1)`,
      [req.userId, targetId]
    );

    if (existing.rows.length > 0) {
      const friendship = existing.rows[0];
      if (friendship.status === 'blocked') {
        res.status(403).json({ error: 'Cannot send request' });
        return;
      }
      res.status(409).json({ error: 'Friend request already exists' });
      return;
    }

    const result = await query(
      `INSERT INTO friendships (requester_id, addressee_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [req.userId, targetId]
    );

    res.status(201).json(result.rows[0]);

    // Send push notification to the target user (fire-and-forget)
    const senderInfo = await query('SELECT display_name, username FROM users WHERE id = $1', [req.userId]);
    const senderName = senderInfo.rows[0]?.display_name || senderInfo.rows[0]?.username || 'Someone';
    sendFriendRequestPush(targetId as string, senderName, req.userId as string)
      .catch((err) => console.error('Friend request push failed:', err));
  } catch (err) {
    console.error('Send friend request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/friends/accept/:userId - Accept friend request
router.put('/accept/:userId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `UPDATE friendships SET status = 'accepted'
       WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING *`,
      [req.params.userId, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Friend request not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Accept friend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/friends/reject/:userId - Reject friend request
router.put('/reject/:userId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM friendships
       WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING id`,
      [req.params.userId, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Friend request not found' });
      return;
    }

    res.json({ message: 'Friend request rejected' });
  } catch (err) {
    console.error('Reject friend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/friends/:userId - Remove friend
router.delete('/:userId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `DELETE FROM friendships
       WHERE ((requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1))
         AND status = 'accepted'
       RETURNING id`,
      [req.userId, req.params.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Friendship not found' });
      return;
    }

    res.json({ message: 'Friend removed' });
  } catch (err) {
    console.error('Remove friend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/friends/suggestions - Friend suggestions
router.get('/suggestions', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    // Get current user's location
    const userResult = await query('SELECT last_location_lat, last_location_lng FROM users WHERE id = $1', [req.userId]);
    const userLat = userResult.rows[0]?.last_location_lat;
    const userLng = userResult.rows[0]?.last_location_lng;

    const result = await query(
      `WITH my_friends AS (
        SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END as friend_id
        FROM friendships
        WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'
      )
      SELECT u.id, u.username, u.display_name, u.avatar_url,
        (SELECT COUNT(*) FROM my_friends mf
         JOIN friendships f2 ON (
           (f2.requester_id = mf.friend_id AND f2.addressee_id = u.id)
           OR (f2.requester_id = u.id AND f2.addressee_id = mf.friend_id)
         )
         WHERE f2.status = 'accepted'
        ) as mutual_count,
        CASE WHEN u.last_location_lat IS NOT NULL AND $2::double precision IS NOT NULL
          THEN (6371000 * acos(LEAST(1.0, cos(radians($2::double precision)) * cos(radians(u.last_location_lat)) *
          cos(radians(u.last_location_lng) - radians($3::double precision)) + sin(radians($2::double precision)) *
          sin(radians(u.last_location_lat)))))
        END as distance
      FROM users u
      WHERE u.id != $1
        AND u.id NOT IN (
          SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END
          FROM friendships WHERE requester_id = $1 OR addressee_id = $1
        )
      ORDER BY mutual_count DESC, distance ASC NULLS LAST
      LIMIT 10`,
      [req.userId, userLat, userLng]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Friend suggestions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/friends - List friends
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online
       FROM friendships f
       JOIN users u ON (
         CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END = u.id
       )
       WHERE (f.requester_id = $1 OR f.addressee_id = $1)
         AND f.status = 'accepted'
       ORDER BY u.display_name`,
      [req.userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List friends error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/friends/requests - List pending requests
router.get('/requests', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT f.*, u.id as user_id, u.username, u.display_name, u.avatar_url
       FROM friendships f
       JOIN users u ON f.requester_id = u.id
       WHERE f.addressee_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List requests error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
