import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

const supportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 tickets per window
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Basic email format validation
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/support/contact - Submit a contact message
router.post('/contact', authenticate, supportLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'Message is required and must be a string' });
      return;
    }
    if (name !== undefined && name !== null && typeof name !== 'string') {
      res.status(400).json({ error: 'Name must be a string' });
      return;
    }
    if (email !== undefined && email !== null && typeof email !== 'string') {
      res.status(400).json({ error: 'Email must be a string' });
      return;
    }
    if (subject !== undefined && subject !== null && typeof subject !== 'string') {
      res.status(400).json({ error: 'Subject must be a string' });
      return;
    }
    if (message.length > 5000 || (name && name.length > 255) || (email && email.length > 255) || (subject && subject.length > 500)) {
      res.status(400).json({ error: 'Input exceeds maximum length' });
      return;
    }
    if (email && !EMAIL_REGEX.test(email)) {
      res.status(400).json({ error: 'Invalid email format' });
      return;
    }

    const result = await query(
      `INSERT INTO support_tickets (user_id, type, name, email, subject, message)
       VALUES ($1, 'contact', $2, $3, $4, $5)
       RETURNING id, type, status, created_at`,
      [req.userId, name?.slice(0, 255) || null, email?.slice(0, 255) || null, subject?.slice(0, 500) || null, message.trim().slice(0, 5000)]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Submit contact error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/support/bug-reports - Submit a bug report
router.post('/bug-reports', authenticate, supportLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, steps } = req.body;

    if (!title || typeof title !== 'string' || !title.trim() || !description || typeof description !== 'string' || !description.trim()) {
      res.status(400).json({ error: 'Title and description are required and must be strings' });
      return;
    }
    if (steps !== undefined && steps !== null && typeof steps !== 'string') {
      res.status(400).json({ error: 'Steps must be a string' });
      return;
    }
    if (title.length > 500 || description.length > 5000 || (steps && steps.length > 5000)) {
      res.status(400).json({ error: 'Input exceeds maximum length' });
      return;
    }

    const result = await query(
      `INSERT INTO support_tickets (user_id, type, bug_title, message, steps_to_reproduce)
       VALUES ($1, 'bug_report', $2, $3, $4)
       RETURNING id, type, status, created_at`,
      [req.userId, title.trim().slice(0, 500), description.trim().slice(0, 5000), steps?.trim().slice(0, 5000) || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Submit bug report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
