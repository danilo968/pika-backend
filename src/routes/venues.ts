import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, optionalAuthenticate, AuthRequest } from '../middleware/auth';
import { extractMenuForVenue } from '../services/menuExtractor';
import { searchVenues as typesenseSearch, upsertVenueById } from '../services/typesenseService';
import { sendRatingReceivedPush } from '../services/pushService';

const router = Router();

// GET /api/venues/categories - List all venue categories (smart-sorted)
router.get('/categories', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;

    if (userId) {
      // Authenticated: blended sort (40% global popularity + 60% personal)
      const result = await query(
        `SELECT vc.id, vc.slug, vc.name, vc.icon, vc.icon_name,
           COALESCE(cp.selection_count, 0)::int AS global_count,
           COALESCE(personal.cnt, 0)::int AS personal_count
         FROM venue_categories vc
         LEFT JOIN category_popularity cp ON cp.category_slug = vc.slug
         LEFT JOIN (
           SELECT category_slug, COUNT(*) AS cnt
           FROM category_selections
           WHERE user_id = $1 AND selected_at > NOW() - INTERVAL '30 days'
           GROUP BY category_slug
         ) personal ON personal.category_slug = vc.slug
         ORDER BY
           (0.4 * COALESCE(cp.selection_count, 0) + 0.6 * COALESCE(personal.cnt, 0)) DESC,
           vc.sort_order ASC`,
        [userId]
      );
      res.json(result.rows.map(({ global_count, personal_count, ...cat }) => cat));
    } else {
      // Unauthenticated: global popularity, fallback to sort_order
      const result = await query(
        `SELECT vc.id, vc.slug, vc.name, vc.icon, vc.icon_name
         FROM venue_categories vc
         LEFT JOIN category_popularity cp ON cp.category_slug = vc.slug
         ORDER BY COALESCE(cp.selection_count, 0) DESC, vc.sort_order ASC`
      );
      res.json(result.rows);
    }
  } catch (err) {
    console.error('Get categories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/venues/categories/select - Track category selection
router.post('/categories/select', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { slug } = req.body;
    if (!slug) {
      res.status(400).json({ error: 'Category slug is required' });
      return;
    }
    await query(
      'INSERT INTO category_selections (user_id, category_slug) VALUES ($1, $2)',
      [req.userId, slug]
    );
    // Refresh materialized view asynchronously (non-blocking)
    query('REFRESH MATERIALIZED VIEW CONCURRENTLY category_popularity').catch((err) => {
      console.error('Refresh category_popularity failed:', err);
    });
    res.json({ message: 'Selection tracked' });
  } catch (err) {
    console.error('Track category selection error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/search?q=term&city=cityname - Text search for venues
// Uses Typesense for fast, typo-tolerant search with PostgreSQL fallback
router.get('/search', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { q, city, lat, lng, radius, page, limit } = req.query;

    if (!q || (q as string).length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    const pageNum = parseInt((page as string) || '1', 10);
    const limitNum = Math.min(parseInt((limit as string) || '20', 10), 50);

    // Try Typesense first (fast, typo-tolerant)
    try {
      const results = await typesenseSearch({
        q: q as string,
        city: city as string | undefined,
        lat: lat ? parseFloat(lat as string) : undefined,
        lng: lng ? parseFloat(lng as string) : undefined,
        radiusKm: radius ? parseFloat(radius as string) / 1000 : undefined,
        page: pageNum,
        perPage: limitNum,
      });
      res.json(results);
      return;
    } catch (tsErr) {
      console.warn('Typesense search failed, falling back to PostgreSQL:', (tsErr as Error).message);
    }

    // Fallback: PostgreSQL trigram similarity search
    const offset = (pageNum - 1) * limitNum;
    let sql = `
      SELECT v.id, v.name, v.description, v.address, v.city, v.cuisine,
        v.price_level, v.cover_image_url, v.is_verified, v.is_featured,
        v.ku_rating_avg, v.ku_rating_count,
        v.google_rating, v.google_rating_count,
        v.tripadvisor_rating, v.tripadvisor_rating_count,
        v.trustpilot_rating, v.trustpilot_rating_count,
        ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
        vc.slug as category_slug, vc.name as category_name, vc.icon as category_icon,
        similarity(v.name, $1) as relevance
      FROM venues v
      LEFT JOIN venue_categories vc ON v.category_id = vc.id
      WHERE v.is_active = true
        AND (v.name ILIKE $2 OR v.city ILIKE $2 OR v.cuisine ILIKE $2)
    `;

    const params: any[] = [q as string, `%${q}%`];

    if (city) {
      params.push(city as string);
      sql += ` AND v.city ILIKE $${params.length}`;
    }

    sql += ` ORDER BY relevance DESC, v.ku_rating_count DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limitNum, offset);

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Search venues error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues?lat=X&lng=Y&radius=Z&category=slug&companion=tag&occasion=tag - Nearby venues
router.get('/', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, radius, category, q, companion, occasion, city, page, limit } = req.query;

    if (!lat || !lng) {
      res.status(400).json({ error: 'lat and lng query parameters are required' });
      return;
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lng as string);
    const searchRadius = parseFloat((radius as string) || '2000');
    const pageNum = parseInt((page as string) || '1', 10);
    const limitNum = Math.min(parseInt((limit as string) || '50', 10), 100);
    const offset = (pageNum - 1) * limitNum;

    let sql = `
      SELECT v.id, v.name, v.description, v.address, v.city, v.phone, v.website,
        v.cuisine, v.price_level, v.opening_hours, v.cover_image_url,
        v.is_verified, v.is_featured,
        v.ku_rating_avg, v.ku_rating_count,
        v.google_rating, v.google_rating_count,
        v.tripadvisor_rating, v.tripadvisor_rating_count,
        v.trustpilot_rating, v.trustpilot_rating_count,
        v.last_story_at,
        CASE WHEN v.last_story_at > NOW() - INTERVAL '24 hours' THEN true ELSE false END as has_recent_activity,
        ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
        vc.slug as category_slug, vc.name as category_name, vc.icon as category_icon,
        ST_Distance(v.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance
      FROM venues v
      LEFT JOIN venue_categories vc ON v.category_id = vc.id
      WHERE v.is_active = true
        AND ST_DWithin(v.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
    `;

    const params: any[] = [longitude, latitude, searchRadius];

    if (category) {
      params.push(category as string);
      sql += ` AND vc.slug = $${params.length}`;
    }

    if (q) {
      params.push(`%${q}%`);
      sql += ` AND v.name ILIKE $${params.length}`;
    }

    if (city) {
      params.push(city as string);
      sql += ` AND v.city ILIKE $${params.length}`;
    }

    // Filter by companion/occasion tags from Pika Ratings
    if (companion || occasion) {
      let subWhere = '';
      if (companion) {
        params.push([companion as string]);
        subWhere += ` AND kr.companion_tags && $${params.length}`;
      }
      if (occasion) {
        params.push([occasion as string]);
        subWhere += ` AND kr.occasion_tags && $${params.length}`;
      }
      sql += ` AND EXISTS (SELECT 1 FROM ku_ratings kr WHERE kr.venue_id = v.id${subWhere})`;
    }

    sql += ` ORDER BY distance ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limitNum, offset);

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get venues error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/:id - Full venue detail
router.get('/:id', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT v.*,
         ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
         vc.slug as category_slug, vc.name as category_name, vc.icon as category_icon,
         COALESCE(bp.subscription_tier, 'free') as business_tier
       FROM venues v
       LEFT JOIN venue_categories vc ON v.category_id = vc.id
       LEFT JOIN business_profiles bp ON bp.venue_id = v.id AND bp.status = 'approved'
       WHERE v.id = $1 AND v.is_active = true`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Venue not found' });
      return;
    }

    const venue = result.rows[0];

    // Get external ratings
    const extRatings = await query(
      'SELECT source, rating, rating_count FROM external_ratings WHERE venue_id = $1',
      [req.params.id]
    );

    // Check if menu exists
    const menuCheck = await query(
      'SELECT COUNT(*) as count FROM menu_sections WHERE venue_id = $1',
      [req.params.id]
    );

    venue.external_ratings = extRatings.rows;
    venue.has_menu = parseInt(menuCheck.rows[0].count) > 0;

    res.json(venue);
  } catch (err) {
    console.error('Get venue detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/:id/ratings - Paginated Pika Ratings
router.get('/:id/ratings', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { page, limit } = req.query;
    const pageNum = parseInt((page as string) || '1', 10);
    const limitNum = Math.min(parseInt((limit as string) || '20', 10), 50);
    const offset = (pageNum - 1) * limitNum;

    const result = await query(
      `SELECT kr.*, u.username, u.display_name, u.avatar_url
       FROM ku_ratings kr
       JOIN users u ON kr.user_id = u.id
       WHERE kr.venue_id = $1
       ORDER BY kr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, limitNum, offset]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get ratings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/venues/:id/ratings - Submit or update Pika Rating
router.post('/:id/ratings', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const venueId = req.params.id;
    const {
      overall_rating, food_rating, service_rating, ambiance_rating, value_rating,
      review_text, companion_tags, occasion_tags, media_urls,
    } = req.body;

    if (!overall_rating || overall_rating < 1 || overall_rating > 5) {
      res.status(400).json({ error: 'overall_rating (1-5) is required' });
      return;
    }

    // Check venue exists
    const venueCheck = await query('SELECT id FROM venues WHERE id = $1 AND is_active = true', [venueId]);
    if (venueCheck.rows.length === 0) {
      res.status(404).json({ error: 'Venue not found' });
      return;
    }

    // Upsert rating
    const result = await query(
      `INSERT INTO ku_ratings (venue_id, user_id, overall_rating, food_rating, service_rating,
        ambiance_rating, value_rating, review_text, companion_tags, occasion_tags, media_urls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (venue_id, user_id) DO UPDATE SET
         overall_rating = EXCLUDED.overall_rating,
         food_rating = EXCLUDED.food_rating,
         service_rating = EXCLUDED.service_rating,
         ambiance_rating = EXCLUDED.ambiance_rating,
         value_rating = EXCLUDED.value_rating,
         review_text = EXCLUDED.review_text,
         companion_tags = EXCLUDED.companion_tags,
         occasion_tags = EXCLUDED.occasion_tags,
         media_urls = EXCLUDED.media_urls,
         updated_at = NOW()
       RETURNING *`,
      [
        venueId, req.userId, overall_rating,
        food_rating || null, service_rating || null, ambiance_rating || null, value_rating || null,
        review_text || null,
        companion_tags || [], occasion_tags || [], media_urls || [],
      ]
    );

    // Recalculate venue average
    await query(
      `UPDATE venues SET
        ku_rating_avg = (SELECT COALESCE(AVG(overall_rating), 0) FROM ku_ratings WHERE venue_id = $1),
        ku_rating_count = (SELECT COUNT(*) FROM ku_ratings WHERE venue_id = $1),
        updated_at = NOW()
       WHERE id = $1`,
      [venueId]
    );

    // Sync updated rating data to Typesense (fire-and-forget)
    upsertVenueById(venueId as string).catch((err) => {
      console.error('Typesense sync after rating failed:', err);
    });

    // Notify business owner if venue has one (fire-and-forget)
    query(
      `SELECT bp.user_id, v.name as venue_name
       FROM business_profiles bp
       JOIN venues v ON v.id = bp.venue_id
       WHERE bp.venue_id = $1 AND bp.status = 'approved'`,
      [venueId]
    ).then((bpResult) => {
      if (bpResult.rows.length > 0 && bpResult.rows[0].user_id !== req.userId) {
        sendRatingReceivedPush(
          bpResult.rows[0].user_id,
          bpResult.rows[0].venue_name,
          overall_rating,
          venueId as string,
        ).catch((err) => console.error('Rating push failed:', err));
      }
    }).catch(() => {});

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Submit rating error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/:id/menu - Structured menu
router.get('/:id/menu', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const venueId = req.params.id as string;

    // Get manual menu sections + items
    const sections = await query(
      `SELECT ms.id, ms.name, ms.description, ms.sort_order
       FROM menu_sections ms
       WHERE ms.venue_id = $1
       ORDER BY ms.sort_order`,
      [venueId]
    );

    if (sections.rows.length > 0) {
      const items = await query(
        `SELECT mi.* FROM menu_items mi
         WHERE mi.venue_id = $1 AND mi.is_available = true
         ORDER BY mi.sort_order`,
        [venueId]
      );

      const menu = sections.rows.map((section: any) => ({
        ...section,
        items: items.rows.filter((item: any) => item.section_id === section.id),
      }));

      res.json(menu);
      return;
    }

    // Fallback to extracted menu
    const extracted = await query(
      `SELECT extracted_data FROM extracted_menus
       WHERE venue_id = $1 AND is_current = true
       ORDER BY extracted_at DESC LIMIT 1`,
      [venueId]
    );

    if (extracted.rows.length > 0 && extracted.rows[0].extracted_data) {
      res.json(extracted.rows[0].extracted_data);
      return;
    }

    // Auto-extract: if no menu at all, try to scrape the venue's website
    // Run in background so we don't block the response
    extractMenuForVenue(venueId).then((sections) => {
      if (sections.length > 0) {
        console.log(`Auto-extracted menu for venue ${venueId}: ${sections[0].items.length} items`);
      }
    }).catch((err) => {
      console.error(`Auto-extract menu failed for ${venueId}:`, err);
    });

    res.json([]);
  } catch (err) {
    console.error('Get menu error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/venues/:id/extract-menu - Manually trigger menu extraction from venue website
router.post('/:id/extract-menu', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const venueId = req.params.id as string;

    // Verify venue exists
    const venueCheck = await query(
      'SELECT id, name, website FROM venues WHERE id = $1 AND is_active = true',
      [venueId]
    );
    if (venueCheck.rows.length === 0) {
      res.status(404).json({ error: 'Venue not found' });
      return;
    }

    const venue = venueCheck.rows[0];
    if (!venue.website) {
      res.status(400).json({ error: 'Venue has no website to extract menu from' });
      return;
    }

    const sections = await extractMenuForVenue(venueId);

    if (sections.length === 0) {
      res.json({ success: false, message: 'No menu items could be extracted from the website', items: 0 });
      return;
    }

    const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
    res.json({
      success: true,
      message: `Extracted ${totalItems} menu items in ${sections.length} section(s)`,
      items: totalItems,
      sections,
    });
  } catch (err) {
    console.error('Extract menu error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
