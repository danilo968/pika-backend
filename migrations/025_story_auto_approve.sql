-- Migration 025: Story auto-approval & moderation enhancements
-- Adds auto_approve_at column for time-based auto-approval of pending venue stories
-- During business hours: auto-approve after 10 minutes if venue doesn't act
-- After hours: venue admins must manually approve

ALTER TABLE stories ADD COLUMN IF NOT EXISTS auto_approve_at TIMESTAMPTZ DEFAULT NULL;

-- Index for efficient auto-approve queries (find pending stories past their window)
CREATE INDEX IF NOT EXISTS idx_stories_auto_approve
  ON stories (auto_approve_at)
  WHERE status = 'pending' AND auto_approve_at IS NOT NULL;

-- Index for rate-limit checks (stories per venue per hour)
CREATE INDEX IF NOT EXISTS idx_stories_venue_created
  ON stories (venue_id, created_at)
  WHERE venue_id IS NOT NULL;

-- Index for per-user per-venue rate-limit checks
CREATE INDEX IF NOT EXISTS idx_stories_user_venue_created
  ON stories (user_id, venue_id, created_at)
  WHERE venue_id IS NOT NULL;
