-- Migration 027: Hashtags — discoverable content tags
-- Extracted from story/post captions, searchable in the Search tab

CREATE TABLE IF NOT EXISTS hashtags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag TEXT NOT NULL UNIQUE,           -- lowercase, without #
  story_count INT DEFAULT 0,
  post_count INT DEFAULT 0,
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS story_hashtags (
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, hashtag_id)
);

CREATE TABLE IF NOT EXISTS post_hashtags (
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON hashtags (tag);
CREATE INDEX IF NOT EXISTS idx_hashtags_story_count ON hashtags (story_count DESC);
CREATE INDEX IF NOT EXISTS idx_story_hashtags_hashtag ON story_hashtags (hashtag_id);
CREATE INDEX IF NOT EXISTS idx_post_hashtags_hashtag ON post_hashtags (hashtag_id);

-- Story views: add viewer details tracking for venue owner analytics
-- The story_views table already exists (story_id, user_id unique constraint)
-- Add timestamp if not already there
ALTER TABLE story_views ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ DEFAULT NOW();
