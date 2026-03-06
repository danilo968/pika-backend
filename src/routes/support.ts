import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

// POST /api/support/contact - Submit a contact message
router.post('/contact', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!message || !message.trim()) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    const result = await query(
      `INSERT INTO support_tickets (user_id, type, name, email, subject, message)
       VALUES ($1, 'contact', $2, $3, $4, $5)
       RETURNING id, type, status, created_at`,
      [req.userId, name || null, email || null, subject || null, message.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Submit contact error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/support/bug-reports - Submit a bug report
router.post('/bug-reports', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, steps } = req.body;

    if (!title || !title.trim() || !description || !description.trim()) {
      res.status(400).json({ error: 'Title and description are required' });
      return;
    }

    const result = await query(
      `INSERT INTO support_tickets (user_id, type, bug_title, message, steps_to_reproduce)
       VALUES ($1, 'bug_report', $2, $3, $4)
       RETURNING id, type, status, created_at`,
      [req.userId, title.trim(), description.trim(), steps?.trim() || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Submit bug report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
