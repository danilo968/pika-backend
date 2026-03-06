import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, optionalAuthenticate, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';

const router = Router();

// POST /api/posts - Create a new post
router.post('/', authenticate, upload.single('media'), async (req: AuthRequest, res: Response) => {
  try {
    const { caption } = req.body;
    const mediaUrl = req.file ? `/uploads/${req.file.filename}` : null;

    if (!mediaUrl && !caption) {
      res.status(400).json({ error: 'Either media or caption is required' });
      return;
    }

    const result = await query(
      `INSERT INTO posts (user_id, media_url, caption)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.userId, mediaUrl, caption || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create post error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/posts/user/:userId - Get user's posts
router.get('/user/:userId', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const result = await query(
      `SELECT p.*, u.username, u.display_name, u.avatar_url
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.userId, parseInt(limit as string), offset]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get posts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/posts/:id - Delete own post
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Post not found or not authorized' });
      return;
    }

    res.json({ message: 'Post deleted' });
  } catch (err) {
    console.error('Delete post error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
