import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';
import { isValidUUID } from '../utils/validation';

const router = Router();

// ── Event Tracking ──

// POST /api/interactions/event — Log an interaction event (fire-and-forget)
router.post('/event', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { event_type, venue_id, metadata } = req.body;

    const validTypes = [
      'venue_view', 'venue_click_from_assistant', 'search_query',
      'assistant_result_click', 'assistant_result_skip',
      'assistant_session', 'bookmark_add', 'bookmark_remove', 'navigate_to',
    ];

    if (!event_type || !validTypes.includes(event_type)) {
      res.status(400).json({ error: 'Invalid event_type' });
      return;
    }

    // Validate metadata type and size
    if (metadata !== undefined && metadata !== null) {
      if (typeof metadata !== 'object' || Array.isArray(metadata)) {
        res.status(400).json({ error: 'Metadata must be a JSON object' });
        return;
      }
      if (JSON.stringify(metadata).length > 5000) {
        res.status(400).json({ error: 'Metadata exceeds maximum size' });
        return;
      }
    }

    // Validate venue_id format if provided
    if (venue_id && !isValidUUID(venue_id)) {
      res.status(400).json({ error: 'Invalid venue ID format' });
      return;
    }

    await query(
      `INSERT INTO interaction_events (user_id, event_type, venue_id, metadata)
       VALUES ($1, $2, $3, $4)`,
      [req.userId, event_type, venue_id || null, metadata || {}]
    );

    res.json({ message: 'Event tracked' });
  } catch (err) {
    console.error('Track interaction error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Assistant Sessions ──

// POST /api/interactions/assistant-session — Log a complete assistant session
router.post('/assistant-session', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { answers, query_text, result_venue_ids, result_count } = req.body;

    // Validate answers type and size
    if (answers !== undefined && answers !== null) {
      if (typeof answers !== 'object' || Array.isArray(answers)) {
        res.status(400).json({ error: 'Answers must be a JSON object' });
        return;
      }
      if (JSON.stringify(answers).length > 5000) {
        res.status(400).json({ error: 'Answers data exceeds maximum size' });
        return;
      }
    }
    if (result_venue_ids !== undefined && result_venue_ids !== null) {
      if (!Array.isArray(result_venue_ids)) {
        res.status(400).json({ error: 'result_venue_ids must be an array' });
        return;
      }
      if (result_venue_ids.length > 100) {
        res.status(400).json({ error: 'Too many venue IDs' });
        return;
      }
      if (!result_venue_ids.every((id: unknown) => typeof id === 'string' && isValidUUID(id as string))) {
        res.status(400).json({ error: 'Each venue ID must be a valid UUID' });
        return;
      }
    }
    if (query_text && query_text.length > 1000) {
      res.status(400).json({ error: 'Query text too long' });
      return;
    }
    // Validate result_count is a non-negative finite number
    const safeResultCount = (typeof result_count === 'number' && Number.isFinite(result_count) && result_count >= 0)
      ? result_count : 0;

    const result = await query(
      `INSERT INTO assistant_sessions (user_id, answers, query_text, result_venue_ids, result_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.userId, answers || {}, query_text || null, result_venue_ids || [], safeResultCount]
    );

    res.json({ session_id: result.rows[0].id });
  } catch (err) {
    console.error('Log assistant session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/interactions/assistant-session/:id/click — Record venue click from results
router.post('/assistant-session/:id/click', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.id)) {
      res.status(400).json({ error: 'Invalid session ID format' });
      return;
    }

    const { venue_id } = req.body;
    if (venue_id && !isValidUUID(venue_id)) {
      res.status(400).json({ error: 'Invalid venue ID format' });
      return;
    }

    await query(
      `UPDATE assistant_sessions
       SET clicked_venue_ids = CASE
         WHEN $2 = ANY(clicked_venue_ids) THEN clicked_venue_ids
         WHEN array_length(clicked_venue_ids, 1) >= 50 THEN clicked_venue_ids
         ELSE array_append(clicked_venue_ids, $2)
       END
       WHERE id = $1 AND user_id = $3`,
      [req.params.id, venue_id, req.userId]
    );
    res.json({ message: 'Click tracked' });
  } catch (err) {
    console.error('Track assistant click error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Preferences ──

// GET /api/interactions/preferences — Get computed preferences for current user
router.get('/preferences', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      res.json({
        preferred_companions: [],
        preferred_vibes: [],
        preferred_occasions: [],
        preferred_budget: null,
        preferred_categories: [],
        total_interactions: 0,
        total_ratings: 0,
        peak_hour: null,
        peak_day_of_week: null,
      });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get preferences error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Assistant Memory ──

// GET /api/interactions/assistant-memory — Contextual data for smart assistant
router.get('/assistant-memory', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    // Run all 4 independent queries in parallel (saves ~3x latency)
    const [recentSessions, recentClicks, prefs, bookmarkCount] = await Promise.all([
      // 1. Last 3 assistant sessions
      query(
        `SELECT answers, query_text, result_count, created_at
         FROM assistant_sessions WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 3`,
        [req.userId]
      ),
      // 2. Last 5 venues clicked from assistant results
      query(
        `SELECT DISTINCT ON (v.id) v.id, v.name, v.city, vc.slug as category_slug
         FROM assistant_sessions s
         CROSS JOIN LATERAL unnest(s.clicked_venue_ids) AS cid
         JOIN venues v ON v.id = cid
         LEFT JOIN venue_categories vc ON v.category_id = vc.id
         WHERE s.user_id = $1
         ORDER BY v.id
         LIMIT 5`,
        [req.userId]
      ),
      // 3. User preferences summary
      query(
        `SELECT preferred_companions, preferred_vibes, preferred_occasions,
                preferred_budget, preferred_categories,
                taste_food_weight, taste_service_weight,
                taste_ambiance_weight, taste_value_weight,
                peak_hour, peak_day_of_week, total_interactions, total_ratings
         FROM user_preferences WHERE user_id = $1`,
        [req.userId]
      ),
      // 4. Bookmark count
      query(
        'SELECT COUNT(*)::int as cnt FROM bookmarks WHERE user_id = $1',
        [req.userId]
      ),
    ]);

    res.json({
      recent_sessions: recentSessions.rows,
      recent_venue_clicks: recentClicks.rows,
      preferences: prefs.rows[0] || null,
      bookmark_count: bookmarkCount.rows[0]?.cnt || 0,
    });
  } catch (err) {
    console.error('Get assistant memory error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Bookmarks ──

// POST /api/interactions/bookmarks/:venueId — Toggle bookmark
router.post('/bookmarks/:venueId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.venueId)) {
      res.status(400).json({ error: 'Invalid venue ID format' });
      return;
    }

    // Atomic toggle: try INSERT, if conflict (already exists) then DELETE instead
    const insertResult = await query(
      `INSERT INTO bookmarks (user_id, venue_id) VALUES ($1, $2)
       ON CONFLICT (user_id, venue_id) DO NOTHING
       RETURNING id`,
      [req.userId, req.params.venueId]
    );

    if (insertResult.rowCount && insertResult.rowCount > 0) {
      // INSERT succeeded → newly bookmarked
      res.json({ bookmarked: true });
    } else {
      // Conflict → already existed, so remove it
      await query('DELETE FROM bookmarks WHERE user_id = $1 AND venue_id = $2',
        [req.userId, req.params.venueId]);
      res.json({ bookmarked: false });
    }
  } catch (err) {
    console.error('Toggle bookmark error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/interactions/bookmarks — List bookmarked venues
router.get('/bookmarks', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT v.id, v.name, v.description, v.address, v.city, v.cuisine,
        v.price_level, v.cover_image_url, v.is_verified, v.is_featured,
        v.ku_rating_avg, v.ku_rating_count,
        ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
        vc.slug as category_slug, vc.name as category_name, vc.icon as category_icon,
        b.created_at as bookmarked_at
       FROM bookmarks b
       JOIN venues v ON v.id = b.venue_id AND v.is_active = true
       LEFT JOIN venue_categories vc ON v.category_id = vc.id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC
       LIMIT 100`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get bookmarks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
