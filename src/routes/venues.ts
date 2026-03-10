import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, optionalAuthenticate, AuthRequest } from '../middleware/auth';
import { extractMenuForVenue } from '../services/menuExtractor';
import { searchVenues as typesenseSearch, upsertVenueById } from '../services/typesenseService';
import { recomputePreferences } from '../services/preferenceEngine';
import { sendRatingReceivedPush } from '../services/pushService';
import { isValidUUID, escapeILIKE, isValidCoordinates as isValidCoords } from '../utils/validation';

const router = Router();

// Throttle materialized view refresh to at most once per 5 minutes
let lastCategoryPopularityRefresh = 0;
const CATEGORY_POPULARITY_REFRESH_INTERVAL = 5 * 60 * 1000;

const categorySelectLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 selections per minute
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

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
router.post('/categories/select', authenticate, categorySelectLimiter, async (req: AuthRequest, res: Response) => {
  try {
    const { slug } = req.body;
    if (!slug || typeof slug !== 'string' || slug.length > 50 || !/^[a-z0-9_-]+$/.test(slug)) {
      res.status(400).json({ error: 'Category slug is required and must be a lowercase alphanumeric string (max 50 chars)' });
      return;
    }
    // Verify the category actually exists before tracking selection
    const categoryExists = await query('SELECT 1 FROM venue_categories WHERE slug = $1', [slug]);
    if (categoryExists.rows.length === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    await query(
      'INSERT INTO category_selections (user_id, category_slug) VALUES ($1, $2)',
      [req.userId, slug]
    );
    // Throttle materialized view refresh to at most once per 5 minutes
    const now = Date.now();
    if (now - lastCategoryPopularityRefresh > CATEGORY_POPULARITY_REFRESH_INTERVAL) {
      lastCategoryPopularityRefresh = now;
      query('REFRESH MATERIALIZED VIEW CONCURRENTLY category_popularity').catch((err) => {
        console.error('Refresh category_popularity failed:', err);
      });
    }
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

    if (!q || (q as string).length < 2 || (q as string).length > 100) {
      res.status(400).json({ error: 'Search query must be 2-100 characters' });
      return;
    }

    const pageNum = Math.min(Math.max(1, parseInt((page as string) || '1', 10) || 1), 10000);
    const limitNum = Math.min(Math.max(1, parseInt((limit as string) || '20', 10) || 20), 50);

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

    const params: any[] = [q as string, `%${escapeILIKE(q as string)}%`];

    if (city) {
      if ((city as string).length > 100) {
        res.status(400).json({ error: 'City name too long' });
        return;
      }
      params.push(`%${escapeILIKE(city as string)}%`);
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

// GET /api/venues/trending?lat=X&lng=Y&city=name - Trending venues in area
router.get('/trending', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, city, limit } = req.query;
    const limitNum = Math.min(Math.max(1, parseInt((limit as string) || '10', 10) || 10), 20);

    // Build trending score query
    // Score = weighted combination of: active stories, ratings, recent activity, featured status
    // Use LEFT JOIN with pre-aggregated story stats (eliminates 3 correlated subqueries per row)
    let sql = `
      SELECT v.id, v.name, v.description, v.address, v.city, v.cuisine,
        v.price_level, v.cover_image_url, v.is_verified, v.is_featured,
        v.ku_rating_avg, v.ku_rating_count,
        v.google_rating, v.google_rating_count,
        v.last_story_at,
        CASE WHEN v.last_story_at > NOW() - INTERVAL '24 hours' THEN true ELSE false END as has_recent_activity,
        COALESCE(ss.active_story_count, 0)::integer AS active_story_count,
        ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
        vc.slug as category_slug, vc.name as category_name, vc.icon as category_icon,
        -- Trending score calculation (uses pre-aggregated story stats)
        (
          COALESCE(ss.active_story_count, 0) * 5 +
          COALESCE(v.ku_rating_count, 0) * 3 +
          CASE WHEN v.last_story_at > NOW() - INTERVAL '24 hours' THEN 10 ELSE 0 END +
          CASE WHEN v.is_featured THEN 8 ELSE 0 END +
          COALESCE(ss.total_views, 0) * 0.5 +
          COALESCE(v.ku_rating_avg, 0) * 2
        ) as trending_score
    `;

    const params: any[] = [];

    // Add distance if lat/lng provided
    if (lat && lng) {
      const latitude = parseFloat(lat as string);
      const longitude = parseFloat(lng as string);
      if (!isValidCoords(latitude, longitude)) {
        res.status(400).json({ error: 'Invalid coordinates' });
        return;
      }
      sql += `,
        ST_Distance(v.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance`;
      params.push(longitude, latitude);
    }

    sql += `
      FROM venues v
      LEFT JOIN venue_categories vc ON v.category_id = vc.id
      LEFT JOIN (
        SELECT venue_id,
          COUNT(*) as active_story_count,
          COALESCE(SUM(view_count), 0) as total_views
        FROM stories
        WHERE status = 'approved' AND expires_at > NOW()
        GROUP BY venue_id
      ) ss ON ss.venue_id = v.id
      WHERE v.is_active = true
    `;

    // Filter by city if provided
    if (city) {
      params.push(`%${escapeILIKE(city as string)}%`);
      sql += ` AND v.city ILIKE $${params.length}`;
    }

    // Filter by radius if lat/lng provided (50km radius for trending)
    if (lat && lng) {
      sql += ` AND ST_DWithin(v.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 50000)`;
    }

    // Only include venues with some activity (at least 1 rating or story)
    sql += ` AND (v.ku_rating_count > 0 OR v.last_story_at IS NOT NULL OR v.is_featured = true)`;

    sql += ` ORDER BY trending_score DESC`;
    params.push(limitNum);
    sql += ` LIMIT $${params.length}`;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get trending venues error:', err);
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
    const searchRadius = Math.min(parseFloat((radius as string) || '5000'), 100000);

    if (!isValidCoords(latitude, longitude) || !isFinite(searchRadius) || searchRadius < 0) {
      res.status(400).json({ error: 'Invalid coordinates or radius' });
      return;
    }

    const pageNum = Math.min(Math.max(1, parseInt((page as string) || '1', 10) || 1), 10000);
    const limitNum = Math.min(Math.max(1, parseInt((limit as string) || '200', 10) || 200), 200);
    const offset = (pageNum - 1) * limitNum;

    // Use LEFT JOIN with pre-aggregated story stats (eliminates correlated subquery per row)
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
        COALESCE(ss.active_story_count, 0)::integer AS active_story_count,
        ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
        vc.slug as category_slug, vc.name as category_name, vc.icon as category_icon,
        ST_Distance(v.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance
      FROM venues v
      LEFT JOIN venue_categories vc ON v.category_id = vc.id
      LEFT JOIN (
        SELECT venue_id, COUNT(*) as active_story_count
        FROM stories WHERE status = 'approved' AND expires_at > NOW()
        GROUP BY venue_id
      ) ss ON ss.venue_id = v.id
      WHERE v.is_active = true
        AND ST_DWithin(v.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
    `;

    const params: any[] = [longitude, latitude, searchRadius];

    if (category) {
      if (typeof category !== 'string' || (category as string).length > 50) {
        res.status(400).json({ error: 'Category slug must be a string (max 50 chars)' });
        return;
      }
      params.push(category as string);
      sql += ` AND vc.slug = $${params.length}`;
    }

    if (q) {
      if (typeof q !== 'string' || q.length > 100) {
        res.status(400).json({ error: 'Search query must be a string (max 100 chars)' });
        return;
      }
      params.push(`%${escapeILIKE(q as string)}%`);
      sql += ` AND v.name ILIKE $${params.length}`;
    }

    if (city) {
      if (typeof city !== 'string' || city.length > 100) {
        res.status(400).json({ error: 'City name must be a string (max 100 chars)' });
        return;
      }
      params.push(`%${escapeILIKE(city as string)}%`);
      sql += ` AND v.city ILIKE $${params.length}`;
    }

    // Age-based filtering: exclude age-restricted venues for underage users
    if (req.userId) {
      try {
        const userResult = await query('SELECT date_of_birth FROM users WHERE id = $1', [req.userId]);
        const dob = userResult.rows[0]?.date_of_birth;
        if (dob) {
          const birth = new Date(dob);
          const today = new Date();
          let userAge = today.getFullYear() - birth.getFullYear();
          const md = today.getMonth() - birth.getMonth();
          if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) userAge--;
          params.push(userAge);
          sql += ` AND (vc.min_age IS NULL OR vc.min_age <= $${params.length})`;
        }
      } catch (ageErr) { console.warn('Age filter skipped:', ageErr); }
    }

    // Filter by companion/occasion tags from Pika Ratings
    if (companion || occasion) {
      let subWhere = '';
      if (companion) {
        if (typeof companion !== 'string' || (companion as string).length > 100) {
          res.status(400).json({ error: 'Companion tag must be a string (max 100 chars)' });
          return;
        }
        params.push([companion as string]);
        subWhere += ` AND kr.companion_tags && $${params.length}::text[]`;
      }
      if (occasion) {
        if (typeof occasion !== 'string' || (occasion as string).length > 100) {
          res.status(400).json({ error: 'Occasion tag must be a string (max 100 chars)' });
          return;
        }
        params.push([occasion as string]);
        subWhere += ` AND kr.occasion_tags && $${params.length}::text[]`;
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

// ── Pika Learning AI Endpoints ──

// GET /api/venues/personalized — Venues ranked by user affinity score
router.get('/personalized', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, radius, companion, vibe, occasion, budget, category, city, limit: limitQ } = req.query;

    if (!lat || !lng) {
      res.status(400).json({ error: 'lat and lng are required' });
      return;
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lng as string);
    const searchRadius = Math.min(parseFloat((radius as string) || '5000'), 100000);

    if (!isValidCoords(latitude, longitude) || !isFinite(searchRadius) || searchRadius < 0) {
      res.status(400).json({ error: 'Invalid coordinates or radius' });
      return;
    }

    const limitNum = Math.min(parseInt((limitQ as string) || '20', 10) || 20, 200);

    // Fetch user preferences
    const prefResult = await query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [req.userId]
    );
    const prefs = prefResult.rows[0];

    // Base venue query with scoring
    let sql = `
      SELECT v.id, v.name, v.description, v.address, v.city, v.cuisine,
        v.price_level, v.cover_image_url, v.is_verified, v.is_featured,
        v.ku_rating_avg, v.ku_rating_count,
        v.google_rating, v.google_rating_count,
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
      if (typeof category !== 'string' || (category as string).length > 50) {
        res.status(400).json({ error: 'Category slug must be a string (max 50 chars)' });
        return;
      }
      params.push(category as string);
      sql += ` AND vc.slug = $${params.length}`;
    }
    if (city) {
      params.push(`%${escapeILIKE(city as string)}%`);
      sql += ` AND v.city ILIKE $${params.length}`;
    }
    if (companion) {
      params.push([companion]);
      sql += ` AND EXISTS (SELECT 1 FROM ku_ratings kr WHERE kr.venue_id = v.id AND kr.companion_tags && $${params.length}::text[])`;
    }
    if (occasion) {
      params.push([occasion]);
      sql += ` AND EXISTS (SELECT 1 FROM ku_ratings kr WHERE kr.venue_id = v.id AND kr.occasion_tags && $${params.length}::text[])`;
    }

    // Affinity scoring: base quality + preference match + featured
    sql += ` ORDER BY (
      COALESCE(v.ku_rating_avg, 0) * 2 +
      CASE WHEN v.is_featured THEN 5 ELSE 0 END +
      LEAST(COALESCE(v.ku_rating_count, 0), 10)`;

    // Add preference-based scoring if user has preferences
    if (prefs) {
      const prefCategories = prefs.preferred_categories || [];
      for (const cat of prefCategories.slice(0, 3)) {
        const w = Number(cat.weight) || 0;
        if (!isFinite(w)) continue;
        params.push(cat.value);
        sql += ` + CASE WHEN vc.slug = $${params.length} THEN ${Math.round(w * 8)} ELSE 0 END`;
      }
      if (prefs.preferred_budget) {
        params.push(prefs.preferred_budget);
        sql += ` + CASE WHEN v.price_level IS NOT NULL THEN GREATEST(0, 3 - ABS(COALESCE(v.price_level, 2) - $${params.length})) ELSE 0 END`;
      }
    }

    // Slight distance penalty
    sql += ` - (ST_Distance(v.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) / 1000.0)`;
    sql += `) DESC`;

    params.push(limitNum);
    sql += ` LIMIT $${params.length}`;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Personalized venues error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/recommended — "Users like you also liked" (collaborative filtering)
router.get('/recommended', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, limit: limitQ } = req.query;
    const limitNum = Math.min(parseInt((limitQ as string) || '10', 10) || 10, 20);

    // Item-based collaborative filtering:
    // 1. Find venues I rated 4+
    // 2. Find other users who also rated those venues 4+
    // 3. Find OTHER venues those users liked that I haven't visited
    // 4. Rank by how many similar users liked it
    const params: any[] = [req.userId];
    let distSelect = '';
    let distWhere = '';

    if (lat && lng) {
      const parsedLat = parseFloat(lat as string);
      const parsedLng = parseFloat(lng as string);
      if (!isValidCoords(parsedLat, parsedLng)) {
        res.status(400).json({ error: 'Invalid coordinates' });
        return;
      }
      params.push(parsedLng, parsedLat);
      distSelect = `, ST_Distance(v.location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) as distance`;
      distWhere = ` AND ST_DWithin(v.location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 50000)`;
    }

    params.push(limitNum);

    const sql = `
      WITH my_liked_venues AS (
        SELECT venue_id FROM ku_ratings
        WHERE user_id = $1 AND overall_rating >= 4
      ),
      similar_users AS (
        SELECT DISTINCT kr.user_id
        FROM ku_ratings kr
        JOIN my_liked_venues mlv ON kr.venue_id = mlv.venue_id
        WHERE kr.user_id != $1 AND kr.overall_rating >= 4
        LIMIT 50
      ),
      recommended AS (
        SELECT kr.venue_id, COUNT(DISTINCT kr.user_id) as supporter_count,
               AVG(kr.overall_rating) as avg_rec_rating
        FROM ku_ratings kr
        JOIN similar_users su ON kr.user_id = su.user_id
        WHERE kr.overall_rating >= 4
          AND kr.venue_id NOT IN (SELECT venue_id FROM ku_ratings WHERE user_id = $1)
        GROUP BY kr.venue_id
        HAVING COUNT(DISTINCT kr.user_id) >= 2
      )
      SELECT v.id, v.name, v.description, v.address, v.city, v.cuisine,
        v.price_level, v.cover_image_url, v.is_verified, v.is_featured,
        v.ku_rating_avg, v.ku_rating_count,
        ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
        vc.slug as category_slug, vc.name as category_name, vc.icon as category_icon,
        r.supporter_count, r.avg_rec_rating
        ${distSelect}
      FROM recommended r
      JOIN venues v ON v.id = r.venue_id AND v.is_active = true
      LEFT JOIN venue_categories vc ON v.category_id = vc.id
      WHERE true ${distWhere}
      ORDER BY r.supporter_count DESC, r.avg_rec_rating DESC
      LIMIT $${params.length}
    `;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Recommended venues error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/friend-picks — Venues your friends rated highly
router.get('/friend-picks', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, limit: limitQ } = req.query;
    const limitNum = Math.min(parseInt((limitQ as string) || '10', 10) || 10, 20);

    const params: any[] = [req.userId];
    let distSelect = '';
    let distWhere = '';

    if (lat && lng) {
      const parsedLat = parseFloat(lat as string);
      const parsedLng = parseFloat(lng as string);
      if (!isValidCoords(parsedLat, parsedLng)) {
        res.status(400).json({ error: 'Invalid coordinates' });
        return;
      }
      params.push(parsedLng, parsedLat);
      distSelect = `, ST_Distance(v.location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) as distance`;
      distWhere = ` AND ST_DWithin(v.location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 50000)`;
    }

    params.push(limitNum);

    const sql = `
      WITH my_friends AS (
        SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END as friend_id
        FROM friendships
        WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'
      )
      SELECT v.id, v.name, v.description, v.address, v.city, v.cuisine,
        v.price_level, v.cover_image_url, v.is_verified, v.is_featured,
        v.ku_rating_avg, v.ku_rating_count,
        ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
        vc.slug as category_slug, vc.name as category_name, vc.icon as category_icon,
        kr.overall_rating as friend_rating,
        u.username as friend_name, u.avatar_url as friend_avatar
        ${distSelect}
      FROM ku_ratings kr
      JOIN my_friends mf ON kr.user_id = mf.friend_id
      JOIN venues v ON v.id = kr.venue_id AND v.is_active = true
      JOIN users u ON u.id = kr.user_id
      LEFT JOIN venue_categories vc ON v.category_id = vc.id
      WHERE kr.overall_rating >= 4
        AND kr.venue_id NOT IN (SELECT venue_id FROM ku_ratings WHERE user_id = $1)
        ${distWhere}
      ORDER BY kr.overall_rating DESC, kr.created_at DESC
      LIMIT $${params.length}
    `;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Friend picks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/trending/personalized — Trending in YOUR preferred categories
router.get('/trending/personalized', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, city, limit: limitQ } = req.query;
    const limitNum = Math.min(parseInt((limitQ as string) || '10', 10) || 10, 20);

    // Get user's preferred categories for boost
    const prefResult = await query(
      'SELECT preferred_categories FROM user_preferences WHERE user_id = $1',
      [req.userId]
    );
    const prefCategories: Array<{ value: string; weight: number }> =
      prefResult.rows[0]?.preferred_categories || [];

    const params: any[] = [];

    // Build the category boost SQL fragment
    let categoryBoostParts: string[] = [];
    for (const cat of prefCategories.slice(0, 5)) {
      const w = Number(cat.weight) || 0;
      if (!isFinite(w)) continue;
      params.push(cat.value);
      categoryBoostParts.push(`WHEN vc.slug = $${params.length} THEN ${Math.round(w * 15)}`);
    }
    const categoryBoost = categoryBoostParts.length > 0
      ? `+ CASE ${categoryBoostParts.join(' ')} ELSE 0 END`
      : '';

    let distSelect = '';
    let distWhere = '';
    if (lat && lng) {
      const parsedLat = parseFloat(lat as string);
      const parsedLng = parseFloat(lng as string);
      if (!isValidCoords(parsedLat, parsedLng)) {
        res.status(400).json({ error: 'Invalid coordinates' });
        return;
      }
      params.push(parsedLng, parsedLat);
      const lngIdx = params.length - 1;
      const latIdx = params.length;
      distSelect = `, ST_Distance(v.location, ST_SetSRID(ST_MakePoint($${lngIdx}, $${latIdx}), 4326)::geography) as distance`;
      distWhere = ` AND ST_DWithin(v.location, ST_SetSRID(ST_MakePoint($${lngIdx}, $${latIdx}), 4326)::geography, 50000)`;
    }

    let cityWhere = '';
    if (city) {
      params.push(`%${escapeILIKE(city as string)}%`);
      cityWhere = ` AND v.city ILIKE $${params.length}`;
    }

    params.push(limitNum);

    const sql = `
      SELECT v.id, v.name, v.description, v.address, v.city, v.cuisine,
        v.price_level, v.cover_image_url, v.is_verified, v.is_featured,
        v.ku_rating_avg, v.ku_rating_count,
        v.last_story_at,
        ST_Y(v.location::geometry) as latitude, ST_X(v.location::geometry) as longitude,
        vc.slug as category_slug, vc.name as category_name, vc.icon as category_icon,
        (
          COALESCE(ss.active_story_count, 0) * 5 +
          COALESCE(v.ku_rating_count, 0) * 3 +
          CASE WHEN v.last_story_at > NOW() - INTERVAL '24 hours' THEN 10 ELSE 0 END +
          CASE WHEN v.is_featured THEN 8 ELSE 0 END +
          COALESCE(v.ku_rating_avg, 0) * 2
          ${categoryBoost}
        ) as trending_score
        ${distSelect}
      FROM venues v
      LEFT JOIN venue_categories vc ON v.category_id = vc.id
      LEFT JOIN (
        SELECT venue_id, COUNT(*) as active_story_count
        FROM stories WHERE status = 'approved' AND expires_at > NOW()
        GROUP BY venue_id
      ) ss ON ss.venue_id = v.id
      WHERE v.is_active = true
        AND (v.ku_rating_count > 0 OR v.last_story_at IS NOT NULL OR v.is_featured = true)
        ${distWhere}
        ${cityWhere}
      ORDER BY trending_score DESC
      LIMIT $${params.length}
    `;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Personalized trending error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/:id - Full venue detail
router.get('/:id', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  if (!isValidUUID(req.params.id)) {
    res.status(400).json({ error: 'Invalid venue ID format' });
    return;
  }
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

    // Run external ratings + menu check in parallel (saves one sequential query)
    const [extRatings, menuCheck] = await Promise.all([
      query('SELECT source, rating, rating_count FROM external_ratings WHERE venue_id = $1', [req.params.id]),
      query('SELECT COUNT(*) as count FROM menu_sections WHERE venue_id = $1', [req.params.id]),
    ]);

    venue.external_ratings = extRatings.rows;
    venue.has_menu = Number(menuCheck.rows[0]?.count ?? 0) > 0;

    res.json(venue);
  } catch (err) {
    console.error('Get venue detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/:id/ratings - Paginated Pika Ratings
router.get('/:id/ratings', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  if (!isValidUUID(req.params.id)) { res.status(400).json({ error: 'Invalid venue ID format' }); return; }
  try {
    const { page, limit } = req.query;
    const pageNum = Math.min(Math.max(1, parseInt((page as string) || '1', 10) || 1), 10000);
    const limitNum = Math.min(Math.max(1, parseInt((limit as string) || '20', 10) || 20), 50);
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

const ratingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many rating submissions. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const menuExtractionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many menu extraction requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/venues/:id/ratings - Submit or update Pika Rating
router.post('/:id/ratings', authenticate, ratingLimiter, async (req: AuthRequest, res: Response) => {
  if (!isValidUUID(req.params.id)) { res.status(400).json({ error: 'Invalid venue ID format' }); return; }
  try {
    const venueId = req.params.id;
    const {
      overall_rating, food_rating, service_rating, ambiance_rating, value_rating,
      review_text, companion_tags, occasion_tags, media_urls,
    } = req.body;

    if (typeof overall_rating !== 'number' || !Number.isInteger(overall_rating) || overall_rating < 1 || overall_rating > 5) {
      res.status(400).json({ error: 'overall_rating (1-5) is required and must be an integer' });
      return;
    }

    // Validate sub-ratings range (1-5 integer or null) with type check
    const subRatings = [food_rating, service_rating, ambiance_rating, value_rating];
    for (const r of subRatings) {
      if (r != null && (typeof r !== 'number' || !Number.isInteger(r) || r < 1 || r > 5)) {
        res.status(400).json({ error: 'Sub-ratings must be integers between 1 and 5' });
        return;
      }
    }

    // Validate review text type and length
    if (review_text !== undefined && review_text !== null) {
      if (typeof review_text !== 'string') {
        res.status(400).json({ error: 'Review text must be a string' });
        return;
      }
      const trimmedReview = review_text.trim();
      if (trimmedReview.length > 5000) {
        res.status(400).json({ error: 'Review text must be 5000 characters or less' });
        return;
      }
    }

    // Validate tag arrays (non-empty strings, max 100 chars, max 10 tags)
    if (companion_tags !== undefined && companion_tags !== null) {
      if (!Array.isArray(companion_tags) || companion_tags.length > 10 ||
          !companion_tags.every((t: unknown) => typeof t === 'string' && (t as string).trim().length > 0 && (t as string).length <= 100)) {
        res.status(400).json({ error: 'companion_tags must be an array of non-empty strings (max 100 chars each, max 10 tags)' });
        return;
      }
    }
    if (occasion_tags !== undefined && occasion_tags !== null) {
      if (!Array.isArray(occasion_tags) || occasion_tags.length > 10 ||
          !occasion_tags.every((t: unknown) => typeof t === 'string' && (t as string).trim().length > 0 && (t as string).length <= 100)) {
        res.status(400).json({ error: 'occasion_tags must be an array of non-empty strings (max 100 chars each, max 10 tags)' });
        return;
      }
    }
    if (media_urls !== undefined && media_urls !== null) {
      if (!Array.isArray(media_urls) || !media_urls.every((u: unknown) => typeof u === 'string' && u.length <= 500)) {
        res.status(400).json({ error: 'media_urls must be an array of URL strings' });
        return;
      }
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

    // Background tasks after rating — errors are logged but don't fail the response.
    // Wrapped in Promise.allSettled so partial failures are isolated and visible.
    Promise.allSettled([
      // Sync updated rating data to Typesense
      upsertVenueById(venueId as string),
      // Recompute user preferences
      recomputePreferences(req.userId as string),
      // Notify business owner if venue has one
      query(
        `SELECT bp.user_id, v.name as venue_name
         FROM business_profiles bp
         JOIN venues v ON v.id = bp.venue_id
         WHERE bp.venue_id = $1 AND bp.status = 'approved'`,
        [venueId]
      ).then((bpResult) => {
        if (bpResult.rows.length > 0 && bpResult.rows[0].user_id !== req.userId) {
          return sendRatingReceivedPush(
            bpResult.rows[0].user_id,
            bpResult.rows[0].venue_name,
            overall_rating,
            venueId as string,
          );
        }
      }),
    ]).then((results) => {
      const labels = ['Typesense sync', 'Preference recompute', 'Rating push'];
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.error(`[post-rating] ${labels[i]} failed:`, r.reason);
        }
      });
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Submit rating error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/:id/menu - Structured menu
router.get('/:id/menu', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  if (!isValidUUID(req.params.id)) { res.status(400).json({ error: 'Invalid venue ID format' }); return; }
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
router.post('/:id/extract-menu', authenticate, menuExtractionLimiter, async (req: AuthRequest, res: Response) => {
  if (!isValidUUID(req.params.id)) { res.status(400).json({ error: 'Invalid venue ID format' }); return; }
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

// GET /api/venues/:id/stories - Approved venue stories (non-expired)
router.get('/:id/stories', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  if (!isValidUUID(req.params.id)) { res.status(400).json({ error: 'Invalid venue ID format' }); return; }
  try {
    const result = await query(
      `SELECT s.id, s.user_id AS uploader_id, s.media_url, s.media_type,
         s.caption, s.venue_id, s.expires_at, s.created_at,
         s.uploader_type, s.status,
         u.username AS uploader_name, u.avatar_url AS uploader_avatar
       FROM stories s
       JOIN users u ON s.user_id = u.id
       WHERE s.venue_id = $1
         AND s.status = 'approved'
         AND s.expires_at > NOW()
       ORDER BY s.created_at DESC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get venue stories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/venues/:id/content-submissions - Pending content for venue owner moderation
router.get('/:id/content-submissions', authenticate, async (req: AuthRequest, res: Response) => {
  if (!isValidUUID(req.params.id)) { res.status(400).json({ error: 'Invalid venue ID format' }); return; }
  try {
    // Verify caller is the venue owner
    const ownerCheck = await query(
      `SELECT id FROM business_profiles WHERE user_id = $1 AND venue_id = $2 AND status = 'approved'`,
      [req.userId, req.params.id]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not the venue owner' });
      return;
    }

    const result = await query(
      `SELECT s.id, s.venue_id, s.user_id, s.media_url, s.media_type,
         s.caption, s.status, s.created_at,
         u.username, u.display_name, u.avatar_url
       FROM stories s
       JOIN users u ON s.user_id = u.id
       WHERE s.venue_id = $1 AND s.status = 'pending'
       ORDER BY s.created_at DESC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get content submissions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/venues/:id/content-submissions/:submissionId/approve
router.post('/:id/content-submissions/:submissionId/approve', authenticate, async (req: AuthRequest, res: Response) => {
  if (!isValidUUID(req.params.id) || !isValidUUID(req.params.submissionId)) { res.status(400).json({ error: 'Invalid ID format' }); return; }
  try {
    // Verify caller is the venue owner
    const ownerCheck = await query(
      `SELECT id FROM business_profiles WHERE user_id = $1 AND venue_id = $2 AND status = 'approved'`,
      [req.userId, req.params.id]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not the venue owner' });
      return;
    }

    // Approve the story — set status and give it a 24h expiry from now
    const result = await query(
      `UPDATE stories SET status = 'approved', expires_at = NOW() + INTERVAL '24 hours'
       WHERE id = $1 AND venue_id = $2 AND status = 'pending'
       RETURNING id`,
      [req.params.submissionId, req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Submission not found or already processed' });
      return;
    }

    // Update venue story count and last_story_at
    await query(
      `UPDATE venues SET
         active_story_count = (SELECT COUNT(*) FROM stories WHERE venue_id = $1 AND status = 'approved' AND expires_at > NOW()),
         last_story_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({ message: 'Content approved' });
  } catch (err) {
    console.error('Approve content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/venues/:id/content-submissions/:submissionId/reject
router.post('/:id/content-submissions/:submissionId/reject', authenticate, async (req: AuthRequest, res: Response) => {
  if (!isValidUUID(req.params.id) || !isValidUUID(req.params.submissionId)) { res.status(400).json({ error: 'Invalid ID format' }); return; }
  try {
    // Verify caller is the venue owner
    const ownerCheck = await query(
      `SELECT id FROM business_profiles WHERE user_id = $1 AND venue_id = $2 AND status = 'approved'`,
      [req.userId, req.params.id]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not the venue owner' });
      return;
    }

    const result = await query(
      `UPDATE stories SET status = 'rejected'
       WHERE id = $1 AND venue_id = $2 AND status = 'pending'
       RETURNING id`,
      [req.params.submissionId, req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Submission not found or already processed' });
      return;
    }

    res.json({ message: 'Content rejected' });
  } catch (err) {
    console.error('Reject content error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
