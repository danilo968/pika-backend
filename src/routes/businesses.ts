import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import pool from '../config/database';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { isValidUUID } from '../utils/validation';

const router = Router();

const businessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/businesses - Register a business
router.post('/', authenticate, businessLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { business_name, business_email, business_phone, registration_number, venue_id } = req.body;

    if (!business_name || typeof business_name !== 'string') {
      res.status(400).json({ error: 'business_name is required and must be a string' });
      return;
    }
    if (business_name.length > 255) {
      res.status(400).json({ error: 'Business name must be 255 characters or less' });
      return;
    }
    if (business_email && (typeof business_email !== 'string' || business_email.length > 255)) {
      res.status(400).json({ error: 'Invalid business email' });
      return;
    }
    if (business_phone && (typeof business_phone !== 'string' || business_phone.length > 30)) {
      res.status(400).json({ error: 'Invalid business phone' });
      return;
    }
    if (registration_number && (typeof registration_number !== 'string' || registration_number.length > 50)) {
      res.status(400).json({ error: 'Invalid registration number' });
      return;
    }
    if (venue_id && !isValidUUID(venue_id)) {
      res.status(400).json({ error: 'Invalid venue ID format' });
      return;
    }

    // Check if user already has a business profile
    const existing = await query(
      'SELECT id FROM business_profiles WHERE user_id = $1',
      [req.userId]
    );

    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'You already have a business profile' });
      return;
    }

    // If venue_id provided, verify it exists and is not already claimed
    if (venue_id) {
      const venueCheck = await query(
        'SELECT id FROM venues WHERE id = $1 AND is_active = true',
        [venue_id]
      );
      if (venueCheck.rows.length === 0) {
        res.status(404).json({ error: 'Venue not found' });
        return;
      }

      const claimCheck = await query(
        "SELECT id FROM business_profiles WHERE venue_id = $1 AND status != 'rejected'",
        [venue_id]
      );
      if (claimCheck.rows.length > 0) {
        res.status(409).json({ error: 'This venue has already been claimed' });
        return;
      }
    }

    const result = await query(
      `INSERT INTO business_profiles (user_id, venue_id, business_name, business_email, business_phone, registration_number)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.userId, venue_id || null, business_name, business_email || null, business_phone || null, registration_number || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Register business error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/businesses/me - Get current user's business profile
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT bp.*, v.name as venue_name, v.address as venue_address
       FROM business_profiles bp
       LEFT JOIN venues v ON bp.venue_id = v.id
       WHERE bp.user_id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      res.json(null);
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get business profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/businesses/:id - Update business details
router.put('/:id', authenticate, businessLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.id)) {
      res.status(400).json({ error: 'Invalid business ID format' });
      return;
    }

    const { business_name, business_email, business_phone, registration_number } = req.body;

    // Validate optional fields if provided
    if (business_name !== undefined && (typeof business_name !== 'string' || business_name.length > 255)) {
      res.status(400).json({ error: 'Business name must be a string (max 255 chars)' });
      return;
    }
    if (business_email !== undefined && business_email !== null && (typeof business_email !== 'string' || business_email.length > 255)) {
      res.status(400).json({ error: 'Invalid business email' });
      return;
    }
    if (business_phone !== undefined && business_phone !== null && (typeof business_phone !== 'string' || business_phone.length > 30)) {
      res.status(400).json({ error: 'Invalid business phone' });
      return;
    }
    if (registration_number !== undefined && registration_number !== null && (typeof registration_number !== 'string' || registration_number.length > 50)) {
      res.status(400).json({ error: 'Invalid registration number' });
      return;
    }

    // Build SET clause dynamically — only update fields explicitly provided in the body
    // This allows setting fields to null (unlike COALESCE which preserves the old value)
    const setClauses: string[] = [];
    const params: unknown[] = [req.params.id, req.userId];

    if ('business_name' in req.body) {
      params.push(business_name);
      setClauses.push(`business_name = $${params.length}`);
    }
    if ('business_email' in req.body) {
      params.push(business_email ?? null);
      setClauses.push(`business_email = $${params.length}`);
    }
    if ('business_phone' in req.body) {
      params.push(business_phone ?? null);
      setClauses.push(`business_phone = $${params.length}`);
    }
    if ('registration_number' in req.body) {
      params.push(registration_number ?? null);
      setClauses.push(`registration_number = $${params.length}`);
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    setClauses.push('updated_at = NOW()');

    const result = await query(
      `UPDATE business_profiles SET ${setClauses.join(', ')}
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Business profile not found or not authorized' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update business error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/businesses/:id/menu - Upload/replace menu for linked venue
router.post('/:id/menu', authenticate, businessLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.id)) {
      res.status(400).json({ error: 'Invalid business ID format' });
      return;
    }

    const { sections } = req.body;

    if (!sections || !Array.isArray(sections)) {
      res.status(400).json({ error: 'sections array is required' });
      return;
    }

    // Limit sections and items per section to prevent abuse
    if (sections.length > 50) {
      res.status(400).json({ error: 'Maximum 50 menu sections allowed' });
      return;
    }
    for (const s of sections) {
      if (!s.name || typeof s.name !== 'string') {
        res.status(400).json({ error: 'Section name is required and must be a string' });
        return;
      }
      if (s.name.length > 255) {
        res.status(400).json({ error: 'Section name must be 255 characters or less' });
        return;
      }
      if (s.description !== undefined && s.description !== null && typeof s.description !== 'string') {
        res.status(400).json({ error: 'Section description must be a string' });
        return;
      }
      if (s.description && s.description.length > 1000) {
        res.status(400).json({ error: 'Section description must be 1000 characters or less' });
        return;
      }
      if (s.items && !Array.isArray(s.items)) {
        res.status(400).json({ error: 'Section items must be an array' });
        return;
      }
      if (s.items && s.items.length > 200) {
        res.status(400).json({ error: 'Maximum 200 items per section allowed' });
        return;
      }
    }

    // Verify ownership and approved status
    const bp = await query(
      "SELECT venue_id FROM business_profiles WHERE id = $1 AND user_id = $2 AND status = 'approved'",
      [req.params.id, req.userId]
    );

    if (bp.rows.length === 0) {
      res.status(403).json({ error: 'Business profile not found, not authorized, or not yet approved' });
      return;
    }

    const venueId = bp.rows[0].venue_id;
    if (!venueId) {
      res.status(400).json({ error: 'No venue linked to this business profile' });
      return;
    }

    // Validate ALL items BEFORE modifying DB to prevent partial writes
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (section.items && Array.isArray(section.items)) {
        for (let j = 0; j < section.items.length; j++) {
          const item = section.items[j];
          if (!item.name || typeof item.name !== 'string') {
            res.status(400).json({ error: `Section "${section.name}" item ${j + 1}: name is required and must be a string` });
            return;
          }
          if (item.name.length > 255) {
            res.status(400).json({ error: `Section "${section.name}" item "${item.name}": name must be 255 characters or less` });
            return;
          }
          if (item.description !== undefined && item.description !== null && typeof item.description !== 'string') {
            res.status(400).json({ error: `Item "${item.name}": description must be a string` });
            return;
          }
          if (item.description && item.description.length > 1000) {
            res.status(400).json({ error: `Item "${item.name}": description must be 1000 characters or less` });
            return;
          }
          if (item.price !== null && item.price !== undefined && (typeof item.price !== 'number' || !isFinite(item.price) || item.price < 0)) {
            res.status(400).json({ error: `Item "${item.name}": price must be a non-negative number` });
            return;
          }
          if (item.currency !== undefined && item.currency !== null && (typeof item.currency !== 'string' || item.currency.length > 10)) {
            res.status(400).json({ error: `Item "${item.name}": currency must be a string (max 10 chars)` });
            return;
          }
          if (item.image_url !== undefined && item.image_url !== null && (typeof item.image_url !== 'string' || item.image_url.length > 500)) {
            res.status(400).json({ error: `Item "${item.name}": image_url must be a string (max 500 chars)` });
            return;
          }
        }
      }
    }

    // Use a transaction to ensure atomic delete + insert (no partial menu on failure)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete existing menu
      await client.query('DELETE FROM menu_sections WHERE venue_id = $1', [venueId]);

      // Insert new sections and batch-insert items per section
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const sectionResult = await client.query(
          `INSERT INTO menu_sections (venue_id, name, description, sort_order)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [venueId, section.name, section.description || null, i]
        );

        const sectionId = sectionResult.rows[0].id;

        if (section.items && Array.isArray(section.items) && section.items.length > 0) {
          // Batch INSERT all items in ONE query (eliminates N queries per section)
          const values: unknown[] = [];
          const placeholders: string[] = [];
          let paramIdx = 1;

          for (let j = 0; j < section.items.length; j++) {
            const item = section.items[j];
            placeholders.push(
              `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
            );
            values.push(
              sectionId, venueId, item.name, item.description || null,
              item.price ?? null, item.currency || 'EUR', item.image_url || null,
              Boolean(item.is_vegetarian), Boolean(item.is_vegan), Boolean(item.is_gluten_free), j,
            );
          }

          await client.query(
            `INSERT INTO menu_items (section_id, venue_id, name, description, price, currency,
              image_url, is_vegetarian, is_vegan, is_gluten_free, sort_order)
             VALUES ${placeholders.join(', ')}`,
            values
          );
        }
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ message: 'Menu updated successfully' });
  } catch (err) {
    console.error('Upload menu error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
