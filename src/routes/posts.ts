import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { query } from '../config/database';
import { authenticate, optionalAuthenticate, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { isValidUUID, safeParseInt, safeUnlinkUpload } from '../utils/validation';

const router = Router();

const postWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/posts - Create a new post
router.post('/', authenticate, postWriteLimiter, upload.single('media'), async (req: AuthRequest, res: Response) => {
  try {
    const { caption } = req.body;
    const mediaUrl = req.file ? `/uploads/${req.file.filename}` : null;

    if (caption !== undefined && caption !== null && typeof caption !== 'string') {
      res.status(400).json({ error: 'Caption must be a string' });
      return;
    }

    if (!mediaUrl && !caption) {
      res.status(400).json({ error: 'Either media or caption is required' });
      return;
    }

    if (caption && caption.length > 500) {
      res.status(400).json({ error: 'Caption must be 500 characters or less' });
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
    // Clean up orphaned file on DB failure
    if (req.file?.path) {
      fs.unlink(req.file.path, (unlinkErr) => {
        if (unlinkErr) console.error('Failed to delete orphaned file:', unlinkErr.message);
      });
    }
    console.error('Create post error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/posts/user/:userId - Get user's posts
router.get('/user/:userId', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.userId)) {
      res.status(400).json({ error: 'Invalid user ID format' });
      return;
    }

    const pageNum = safeParseInt(req.query.page as string | undefined, 1, 1, 1000);
    const limitNum = safeParseInt(req.query.limit as string | undefined, 20, 1, 100);
    const offset = (pageNum - 1) * limitNum;

    const result = await query(
      `SELECT p.*, u.username, u.display_name, u.avatar_url
       FROM posts p
       JOIN users u ON p.user_id = u.id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.userId, limitNum, offset]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get posts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/posts/:id - Delete own post
router.delete('/:id', authenticate, postWriteLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.id)) {
      res.status(400).json({ error: 'Invalid post ID format' });
      return;
    }

    const result = await query(
      'DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING id, media_url',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Post not found or not authorized' });
      return;
    }

    // Clean up media file from disk (with path traversal protection)
    const mediaUrl = result.rows[0].media_url;
    if (mediaUrl) {
      safeUnlinkUpload(mediaUrl);
    }

    res.json({ message: 'Post deleted' });
  } catch (err) {
    console.error('Delete post error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
