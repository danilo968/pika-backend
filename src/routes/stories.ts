import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, optionalAuthenticate, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { isValidUUID, safeUnlinkUpload } from '../utils/validation';
import { extractHashtags, linkHashtagsToStory, unlinkHashtagsFromStory } from '../utils/hashtags';

const router = Router();

const storyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 stories per minute
  message: { error: 'Too many stories. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/stories - Create a new story
router.post('/', authenticate, storyLimiter, upload.single('media'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Media file is required' });
      return;
    }

    const { caption, latitude, longitude, locationName, venueId } = req.body;

    if (!latitude || !longitude) {
      res.status(400).json({ error: 'Location (latitude, longitude) is required' });
      return;
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400).json({ error: 'Invalid coordinates' });
      return;
    }

    if (caption !== undefined && caption !== null && typeof caption !== 'string') {
      res.status(400).json({ error: 'Caption must be a string' });
      return;
    }
    if (caption && caption.trim().length === 0) {
      res.status(400).json({ error: 'Caption cannot be empty' });
      return;
    }
    if (caption && caption.length > 500) {
      res.status(400).json({ error: 'Caption must be 500 characters or less' });
      return;
    }
    if (locationName !== undefined && locationName !== null && typeof locationName !== 'string') {
      res.status(400).json({ error: 'Location name must be a string' });
      return;
    }
    if (locationName && typeof locationName === 'string' && locationName.trim().length === 0) {
      res.status(400).json({ error: 'Location name cannot be empty' });
      return;
    }
    if (locationName && locationName.length > 255) {
      res.status(400).json({ error: 'Location name too long' });
      return;
    }

    // If posting to a venue, verify GPS proximity (must be within 150m)
    let verifiedVenueId: string | null = null;
    let isVenueOwner = false;
    if (venueId) {
      if (!isValidUUID(venueId)) {
        res.status(400).json({ error: 'Invalid venue ID format' });
        return;
      }
      const venueResult = await query(
        `SELECT id, name, opening_hours,
           ST_Distance(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance
         FROM venues WHERE id = $3 AND is_active = true`,
        [lng, lat, venueId]
      );

      if (venueResult.rows.length === 0) {
        res.status(404).json({ error: 'Venue not found' });
        return;
      }

      const distance = venueResult.rows[0].distance;

      // Check if user is the verified business owner (bypass proximity)
      const businessCheck = await query(
        `SELECT id FROM business_profiles WHERE user_id = $1 AND venue_id = $2 AND status = 'approved'`,
        [req.userId, venueId]
      );
      isVenueOwner = businessCheck.rows.length > 0;

      if (!isVenueOwner && distance > 150) {
        res.status(403).json({
          error: 'You must be at the venue to post here',
          distance: Math.round(distance),
        });
        return;
      }

      // --- Rate limits ---
      if (isVenueOwner) {
        // Venue owners: max 30 ACTIVE (non-expired) stories at the venue at any time
        const ownerActiveCheck = await query(
          `SELECT COUNT(*) as cnt FROM stories
           WHERE venue_id = $1 AND uploader_type = 'owner' AND expires_at > NOW()`,
          [venueId]
        );
        if (parseInt(ownerActiveCheck.rows[0].cnt) >= 30) {
          res.status(429).json({
            error: 'Your venue has 30 active stories — wait for one to expire (24h) or delete one to free a slot.',
            active: parseInt(ownerActiveCheck.rows[0].cnt),
            limit: 30,
          });
          return;
        }
      } else {
        // Clients: max 3 stories per user per venue per hour
        const userHourlyCheck = await query(
          `SELECT COUNT(*) as cnt FROM stories
           WHERE user_id = $1 AND venue_id = $2 AND created_at > NOW() - INTERVAL '1 hour'`,
          [req.userId, venueId]
        );
        if (parseInt(userHourlyCheck.rows[0].cnt) >= 3) {
          res.status(429).json({ error: 'Max 3 stories per venue per hour. Try again later.' });
          return;
        }

        // Clients: max 12 stories per user per venue per day
        const userDailyCheck = await query(
          `SELECT COUNT(*) as cnt FROM stories
           WHERE user_id = $1 AND venue_id = $2 AND created_at > NOW() - INTERVAL '24 hours'`,
          [req.userId, venueId]
        );
        if (parseInt(userDailyCheck.rows[0].cnt) >= 12) {
          res.status(429).json({ error: 'Max 12 stories per venue per day. Try again tomorrow.' });
          return;
        }
      }

      verifiedVenueId = venueId;
    }

    const mediaUrl = `/uploads/${req.file.filename}`;
    const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Owner posts are auto-approved; client posts go to moderation queue
    // During business hours: auto-approve after 5 min if venue doesn't act
    // After hours: only venue admins can approve
    const uploaderType = verifiedVenueId && isVenueOwner ? 'owner' : 'client';
    const storyStatus = verifiedVenueId && !isVenueOwner ? 'pending' : 'approved';
    const autoApproveAt = verifiedVenueId && !isVenueOwner
      ? new Date(Date.now() + 10 * 60 * 1000) // 10 minutes from now
      : null;

    const result = await query(
      `INSERT INTO stories (user_id, media_url, media_type, caption, location, location_name, expires_at, venue_id, uploader_type, status, auto_approve_at)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8, $9, $10, $11, $12)
       RETURNING id, user_id, media_url, media_type, caption,
         ST_Y(location::geometry) as latitude, ST_X(location::geometry) as longitude,
         location_name, expires_at, view_count, venue_id, uploader_type, status, auto_approve_at, created_at`,
      [req.userId, mediaUrl, mediaType, caption || null, lng, lat, locationName || null, expiresAt, verifiedVenueId, uploaderType, storyStatus, autoApproveAt]
    );

    // Extract and link hashtags from caption
    if (caption) {
      const tags = extractHashtags(caption);
      if (tags.length > 0 && result.rows[0]?.id) {
        await linkHashtagsToStory(result.rows[0].id, tags);
      }
    }

    // Update venue's last_story_at and active_story_count (only for approved stories)
    if (verifiedVenueId && storyStatus === 'approved') {
      await query(
        `UPDATE venues SET
           last_story_at = NOW(),
           active_story_count = (SELECT COUNT(*) FROM stories WHERE venue_id = $1 AND status = 'approved' AND expires_at > NOW())
         WHERE id = $1`,
        [verifiedVenueId]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    // Clean up orphaned file on failure (safe: logs + ignores unlink errors)
    if (req.file?.path) {
      safeUnlinkUpload(`/uploads/${req.file.filename}`);
    }
    console.error('Create story error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stories?lat=X&lng=Y&radius=Z - Get stories near location
router.get('/', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { lat, lng, radius } = req.query;

    if (!lat || !lng) {
      res.status(400).json({ error: 'lat and lng query parameters are required' });
      return;
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lng as string);
    const searchRadius = Math.min(parseFloat((radius as string) || '5000'), 50000); // Default 5km, max 50km

    if (isNaN(latitude) || isNaN(longitude) || isNaN(searchRadius) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || searchRadius < 0) {
      res.status(400).json({ error: 'Invalid location parameters' });
      return;
    }

    // Auto-approve stories that passed the 5-minute window without venue action
    await query(
      `UPDATE stories SET status = 'approved'
       WHERE status = 'pending' AND auto_approve_at IS NOT NULL AND auto_approve_at <= NOW()
         AND expires_at > NOW()`
    );

    const result = await query(
      `SELECT s.id, s.user_id, s.media_url, s.media_type, s.caption,
         ST_Y(s.location::geometry) as latitude, ST_X(s.location::geometry) as longitude,
         s.location_name, s.expires_at, s.view_count, s.created_at,
         u.username, u.display_name, u.avatar_url,
         ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance
       FROM stories s
       JOIN users u ON s.user_id = u.id
       WHERE s.expires_at > NOW()
         AND s.status = 'approved'
         AND ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
       ORDER BY s.created_at DESC
       LIMIT 200`,
      [longitude, latitude, searchRadius]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get stories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Hashtag endpoints ──

// GET /api/stories/hashtags/search?q=brunch — Search/autocomplete hashtags
router.get('/hashtags/search', async (req: AuthRequest, res: Response) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== 'string' || q.length < 1) {
      res.status(400).json({ error: 'Query parameter q is required (min 1 char)' });
      return;
    }

    const tag = q.toLowerCase().replace(/^#/, '');
    const result = await query(
      `SELECT tag, story_count, post_count, last_used_at
       FROM hashtags
       WHERE tag LIKE $1
       ORDER BY story_count + post_count DESC
       LIMIT 20`,
      [`${tag}%`]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Hashtag search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stories/hashtags/trending — Top trending hashtags
router.get('/hashtags/trending', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT tag, story_count, post_count, last_used_at
       FROM hashtags
       WHERE last_used_at > NOW() - INTERVAL '7 days'
       ORDER BY story_count + post_count DESC
       LIMIT 30`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Trending hashtags error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stories/hashtags/:tag — Get stories for a hashtag
router.get('/hashtags/:tag', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    const tag = (req.params.tag as string).toLowerCase().replace(/^#/, '');

    const result = await query(
      `SELECT s.id, s.user_id, s.media_url, s.media_type, s.caption,
         ST_Y(s.location::geometry) as latitude, ST_X(s.location::geometry) as longitude,
         s.location_name, s.expires_at, s.view_count, s.created_at,
         u.username, u.display_name, u.avatar_url
       FROM stories s
       JOIN users u ON s.user_id = u.id
       JOIN story_hashtags sh ON s.id = sh.story_id
       JOIN hashtags h ON sh.hashtag_id = h.id
       WHERE h.tag = $1 AND s.expires_at > NOW() AND s.status = 'approved'
       ORDER BY s.created_at DESC
       LIMIT 50`,
      [tag]
    );

    // Also get hashtag metadata
    const hashtagInfo = await query(
      `SELECT tag, story_count, post_count, last_used_at FROM hashtags WHERE tag = $1`,
      [tag]
    );

    res.json({
      hashtag: hashtagInfo.rows[0] || { tag, story_count: 0, post_count: 0 },
      stories: result.rows,
    });
  } catch (err) {
    console.error('Get hashtag stories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// GET /api/stories/venue/:venueId/pending - Get pending stories for venue owner moderation
router.get('/venue/:venueId/pending', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { venueId } = req.params;
    if (!isValidUUID(venueId)) {
      res.status(400).json({ error: 'Invalid venue ID' });
      return;
    }

    // Verify user is venue owner
    const ownerCheck = await query(
      `SELECT id FROM business_profiles WHERE user_id = $1 AND venue_id = $2 AND status = 'approved'`,
      [req.userId, venueId]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not authorized — you must be the venue owner' });
      return;
    }

    const result = await query(
      `SELECT s.id, s.user_id, s.media_url, s.media_type, s.caption,
         ST_Y(s.location::geometry) as latitude, ST_X(s.location::geometry) as longitude,
         s.location_name, s.expires_at, s.view_count, s.auto_approve_at, s.created_at,
         u.username, u.display_name, u.avatar_url
       FROM stories s
       JOIN users u ON s.user_id = u.id
       WHERE s.venue_id = $1 AND s.status = 'pending' AND s.expires_at > NOW()
       ORDER BY s.created_at ASC`,
      [venueId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Get pending stories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stories/:id - Get a single story
router.get('/:id', optionalAuthenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.id)) {
      res.status(400).json({ error: 'Invalid story ID format' });
      return;
    }

    const result = await query(
      `SELECT s.*, u.username, u.display_name, u.avatar_url,
         ST_Y(s.location::geometry) as latitude, ST_X(s.location::geometry) as longitude
       FROM stories s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND s.expires_at > NOW() AND s.status = 'approved'`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get story error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/stories/:id/view - Mark story as viewed
router.post('/:id/view', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.id)) {
      res.status(400).json({ error: 'Invalid story ID format' });
      return;
    }

    // Atomic: INSERT view + increment count in a single statement
    await query(
      `WITH new_view AS (
        INSERT INTO story_views (story_id, user_id) VALUES ($1, $2)
        ON CONFLICT (story_id, user_id) DO NOTHING
        RETURNING 1
      )
      UPDATE stories SET view_count = view_count + 1
      WHERE id = $1 AND EXISTS (SELECT 1 FROM new_view)`,
      [req.params.id, req.userId]
    );

    res.json({ message: 'Story viewed' });
  } catch (err) {
    console.error('View story error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/stories/:id/moderate - Venue owner approves or declines a story
router.patch('/:id/moderate', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'approve' or 'decline'

    if (!isValidUUID(id)) {
      res.status(400).json({ error: 'Invalid story ID' });
      return;
    }
    if (!['approve', 'decline'].includes(action)) {
      res.status(400).json({ error: 'Action must be "approve" or "decline"' });
      return;
    }

    // Get the story and its venue
    const storyResult = await query(
      `SELECT s.id, s.venue_id, s.status, s.media_url FROM stories s WHERE s.id = $1`,
      [id]
    );
    if (storyResult.rows.length === 0) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    const story = storyResult.rows[0];
    if (!story.venue_id) {
      res.status(400).json({ error: 'This story is not linked to a venue' });
      return;
    }
    if (story.status !== 'pending') {
      res.status(400).json({ error: `Story is already ${story.status}` });
      return;
    }

    // Verify user is venue owner
    const ownerCheck = await query(
      `SELECT id FROM business_profiles WHERE user_id = $1 AND venue_id = $2 AND status = 'approved'`,
      [req.userId, story.venue_id]
    );
    if (ownerCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not authorized — you must be the venue owner' });
      return;
    }

    if (action === 'approve') {
      await query(`UPDATE stories SET status = 'approved', auto_approve_at = NULL WHERE id = $1`, [id]);
      // Update venue story count
      await query(
        `UPDATE venues SET
           last_story_at = NOW(),
           active_story_count = (SELECT COUNT(*) FROM stories WHERE venue_id = $1 AND status = 'approved' AND expires_at > NOW())
         WHERE id = $1`,
        [story.venue_id]
      );
      res.json({ message: 'Story approved', status: 'approved' });
    } else {
      // Decline: clean up hashtags, delete the story and clean up media
      await unlinkHashtagsFromStory(id);
      await query(`DELETE FROM stories WHERE id = $1`, [id]);
      if (story.media_url) {
        safeUnlinkUpload(story.media_url);
      }
      res.json({ message: 'Story declined and removed', status: 'declined' });
    }
  } catch (err) {
    console.error('Moderate story error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/stories/:id - Delete own story
router.delete('/:id', authenticate, storyLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.id)) {
      res.status(400).json({ error: 'Invalid story ID format' });
      return;
    }

    const result = await query(
      'DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING id, media_url, venue_id',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Story not found or not authorized' });
      return;
    }

    // Clean up hashtag links
    await unlinkHashtagsFromStory(req.params.id);

    // Clean up media file from disk (with path traversal protection)
    const mediaUrl = result.rows[0].media_url;
    if (mediaUrl) {
      safeUnlinkUpload(mediaUrl);
    }

    // Update venue story count if linked to a venue
    const venueId = result.rows[0].venue_id;
    if (venueId) {
      await query(
        `UPDATE venues SET active_story_count = (SELECT COUNT(*) FROM stories WHERE venue_id = $1 AND status = 'approved' AND expires_at > NOW()) WHERE id = $1`,
        [venueId]
      );
    }

    res.json({ message: 'Story deleted' });
  } catch (err) {
    console.error('Delete story error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Story view analytics (venue owners) ──

// GET /api/stories/:id/viewers — Who viewed a story (owner only)
router.get('/:id/viewers', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!isValidUUID(req.params.id)) {
      res.status(400).json({ error: 'Invalid story ID' });
      return;
    }

    // Verify the user owns this story
    const storyCheck = await query(
      `SELECT s.id, s.user_id, s.venue_id, s.view_count FROM stories s WHERE s.id = $1`,
      [req.params.id]
    );
    if (storyCheck.rows.length === 0) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }

    const story = storyCheck.rows[0];
    const isOwner = story.user_id === req.userId;

    // Check if venue owner
    let isVenueOwner = false;
    if (story.venue_id) {
      const bpCheck = await query(
        `SELECT id FROM business_profiles WHERE user_id = $1 AND venue_id = $2 AND status = 'approved'`,
        [req.userId, story.venue_id]
      );
      isVenueOwner = bpCheck.rows.length > 0;
    }

    if (!isOwner && !isVenueOwner) {
      // Regular users only get their own story's view count
      res.status(403).json({ error: 'Only story owners and venue owners can see viewer details' });
      return;
    }

    // Venue owners get full viewer list; regular users get count only
    if (isVenueOwner) {
      const viewers = await query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, sv.viewed_at
         FROM story_views sv
         JOIN users u ON sv.user_id = u.id
         WHERE sv.story_id = $1
         ORDER BY sv.viewed_at DESC
         LIMIT 100`,
        [req.params.id]
      );
      res.json({
        view_count: story.view_count,
        viewers: viewers.rows,
        detailed: true,
      });
    } else {
      // Story owner gets count only
      res.json({
        view_count: story.view_count,
        viewers: [],
        detailed: false,
      });
    }
  } catch (err) {
    console.error('Story viewers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
