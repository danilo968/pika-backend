import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

// POST /api/businesses - Register a business
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { business_name, business_email, business_phone, registration_number, venue_id } = req.body;

    if (!business_name) {
      res.status(400).json({ error: 'business_name is required' });
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
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { business_name, business_email, business_phone, registration_number } = req.body;

    const result = await query(
      `UPDATE business_profiles SET
        business_name = COALESCE($3, business_name),
        business_email = COALESCE($4, business_email),
        business_phone = COALESCE($5, business_phone),
        registration_number = COALESCE($6, registration_number),
        updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.userId, business_name, business_email, business_phone, registration_number]
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
router.post('/:id/menu', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { sections } = req.body;

    if (!sections || !Array.isArray(sections)) {
      res.status(400).json({ error: 'sections array is required' });
      return;
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

    // Delete existing menu
    await query('DELETE FROM menu_sections WHERE venue_id = $1', [venueId]);

    // Insert new sections and items
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const sectionResult = await query(
        `INSERT INTO menu_sections (venue_id, name, description, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [venueId, section.name, section.description || null, i]
      );

      const sectionId = sectionResult.rows[0].id;

      if (section.items && Array.isArray(section.items)) {
        for (let j = 0; j < section.items.length; j++) {
          const item = section.items[j];
          await query(
            `INSERT INTO menu_items (section_id, venue_id, name, description, price, currency,
              image_url, is_vegetarian, is_vegan, is_gluten_free, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              sectionId, venueId, item.name, item.description || null,
              item.price || null, item.currency || 'EUR', item.image_url || null,
              item.is_vegetarian || false, item.is_vegan || false, item.is_gluten_free || false, j,
            ]
          );
        }
      }
    }

    res.json({ message: 'Menu updated successfully' });
  } catch (err) {
    console.error('Upload menu error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
