import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../config/database';
import { authenticate, optionalAuthenticate, AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { isValidUUID, safeUnlinkUpload } from '../utils/validation';

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
        `SELECT id, name,
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

      verifiedVenueId = venueId;
    }

    const mediaUrl = `/uploads/${req.file.filename}`;
    const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'photo';
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Owner posts are auto-approved; client posts require owner moderation
    const uploaderType = verifiedVenueId && isVenueOwner ? 'owner' : 'client';
    const storyStatus = verifiedVenueId && !isVenueOwner ? 'pending' : 'approved';

    const result = await query(
      `INSERT INTO stories (user_id, media_url, media_type, caption, location, location_name, expires_at, venue_id, uploader_type, status)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8, $9, $10, $11)
       RETURNING id, user_id, media_url, media_type, caption,
         ST_Y(location::geometry) as latitude, ST_X(location::geometry) as longitude,
         location_name, expires_at, view_count, venue_id, uploader_type, status, created_at`,
      [req.userId, mediaUrl, mediaType, caption || null, lng, lat, locationName || null, expiresAt, verifiedVenueId, uploaderType, storyStatus]
    );

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

export default router;
