-- Add venue_id to stories for venue-linked content
ALTER TABLE stories ADD COLUMN venue_id UUID REFERENCES venues(id) ON DELETE SET NULL;
CREATE INDEX idx_stories_venue ON stories(venue_id) WHERE venue_id IS NOT NULL;

-- Track last activity on venues for "active" highlighting
ALTER TABLE venues ADD COLUMN last_story_at TIMESTAMP WITH TIME ZONE;
CREATE INDEX idx_venues_last_story ON venues(last_story_at) WHERE last_story_at IS NOT NULL;
