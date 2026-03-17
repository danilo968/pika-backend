-- Migration 026: Venue Vibes — "What's the vibe today?"
-- Venue owners can set the current vibe for their venue (resets daily)

-- Predefined vibe tags stored as an array on the venue
ALTER TABLE venues ADD COLUMN IF NOT EXISTS current_vibes TEXT[] DEFAULT '{}';
ALTER TABLE venues ADD COLUMN IF NOT EXISTS vibe_set_at TIMESTAMPTZ DEFAULT NULL;

-- Index for querying venues by vibe
CREATE INDEX IF NOT EXISTS idx_venues_current_vibes ON venues USING GIN (current_vibes) WHERE current_vibes != '{}';

-- Vibe options reference (not enforced at DB level, enforced in app):
-- chill, relaxed, hyped, foody, romantic, cozy, live-music, packed,
-- happy-hour, family, quiet, artsy, sporty, business, outdoor, late-night
