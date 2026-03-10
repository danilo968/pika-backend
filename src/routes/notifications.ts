import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

// POST /api/notifications/register - Register push token
router.post('/register', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { token, deviceType } = req.body;
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      res.status(400).json({ error: 'token is required and must be a non-empty string' });
      return;
    }
    if (token.length > 500) {
      res.status(400).json({ error: 'Token too long' });
      return;
    }

    const validDeviceTypes = ['ios', 'android', 'web', 'unknown'];
    if (deviceType && !validDeviceTypes.includes(deviceType)) {
      res.status(400).json({ error: 'Invalid device type' });
      return;
    }

    await query(
      `INSERT INTO push_tokens (user_id, token, device_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, token) DO UPDATE SET
         is_active = true,
         device_type = EXCLUDED.device_type,
         updated_at = NOW()`,
      [req.userId, token, deviceType || 'unknown']
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Register push token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/notifications/unregister - Deactivate push token
router.post('/unregister', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'token is required and must be a string' });
      return;
    }

    await query(
      'UPDATE push_tokens SET is_active = false, updated_at = NOW() WHERE user_id = $1 AND token = $2',
      [req.userId, token]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Unregister push token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
