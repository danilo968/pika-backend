-- Migration 020: Venue content moderation
-- Adds uploader_type and status columns to stories table for venue content moderation.
-- Adds active_story_count to venues for efficient map rendering.

-- Venue story moderation columns
ALTER TABLE stories ADD COLUMN IF NOT EXISTS uploader_type VARCHAR(10) DEFAULT 'client'
  CHECK (uploader_type IN ('owner', 'client'));
ALTER TABLE stories ADD COLUMN IF NOT EXISTS status VARCHAR(10) DEFAULT 'approved'
  CHECK (status IN ('approved', 'pending', 'rejected'));

-- Denormalized count for map rendering (avoids JOINs in GET /api/venues)
ALTER TABLE venues ADD COLUMN IF NOT EXISTS active_story_count INTEGER DEFAULT 0;

-- Index for venue story queries (covers venue_id + status + expires_at for COUNT subquery)
CREATE INDEX IF NOT EXISTS idx_stories_venue_status ON stories(venue_id, status) WHERE venue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stories_venue_active ON stories(venue_id, status, expires_at) WHERE venue_id IS NOT NULL AND status = 'approved';

-- Existing venue-linked stories → set as owner-posted, approved
UPDATE stories SET uploader_type = 'owner', status = 'approved' WHERE venue_id IS NOT NULL;

-- Sync active_story_count for existing venues
UPDATE venues SET active_story_count = (
  SELECT COUNT(*) FROM stories
  WHERE stories.venue_id = venues.id
    AND stories.status = 'approved'
    AND stories.expires_at > NOW()
);
