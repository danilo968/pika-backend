import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/conversations - List user's conversations
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT c.id, c.created_at,
         json_agg(json_build_object(
           'id', u.id, 'username', u.username,
           'display_name', u.display_name, 'avatar_url', u.avatar_url,
           'is_online', u.is_online
         )) FILTER (WHERE u.id != $1) as participants,
         (SELECT json_build_object(
           'content', m.content, 'sender_id', m.sender_id, 'created_at', m.created_at
         ) FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1
         ) as last_message,
         (SELECT COUNT(*) FROM messages m
          WHERE m.conversation_id = c.id AND m.sender_id != $1 AND m.read_at IS NULL
         )::integer as unread_count
       FROM conversations c
       JOIN conversation_participants cp ON c.id = cp.conversation_id
       JOIN conversation_participants cp2 ON c.id = cp2.conversation_id
       JOIN users u ON cp2.user_id = u.id
       WHERE cp.user_id = $1
       GROUP BY c.id
       ORDER BY (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id) DESC NULLS LAST`,
      [req.userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/conversations - Start a conversation
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { userId: targetUserId } = req.body;

    if (!targetUserId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    // Check if conversation already exists between these two users
    const existing = await query(
      `SELECT c.id FROM conversations c
       JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.user_id = $1
       JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id = $2`,
      [req.userId, targetUserId]
    );

    if (existing.rows.length > 0) {
      res.json({ id: existing.rows[0].id, existing: true });
      return;
    }

    // Create new conversation
    const conv = await query('INSERT INTO conversations DEFAULT VALUES RETURNING id');
    const conversationId = conv.rows[0].id;

    await query(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
      [conversationId, req.userId, targetUserId]
    );

    res.status(201).json({ id: conversationId, existing: false });
  } catch (err) {
    console.error('Create conversation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/conversations/:id/messages - Get messages in a conversation
router.get('/:id/messages', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { before, limit = '50' } = req.query;

    // Verify user is a participant
    const participant = await query(
      'SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    if (participant.rows.length === 0) {
      res.status(403).json({ error: 'Not a participant in this conversation' });
      return;
    }

    let messagesQuery = `
      SELECT m.*, u.username, u.display_name, u.avatar_url
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
    `;
    const params: any[] = [req.params.id];

    if (before) {
      params.push(before);
      messagesQuery += ` AND m.created_at < $${params.length}`;
    }

    params.push(parseInt(limit as string));
    messagesQuery += ` ORDER BY m.created_at DESC LIMIT $${params.length}`;

    const result = await query(messagesQuery, params);

    // Mark messages as read
    await query(
      `UPDATE messages SET read_at = NOW()
       WHERE conversation_id = $1 AND sender_id != $2 AND read_at IS NULL`,
      [req.params.id, req.userId]
    );

    res.json(result.rows.reverse());
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
