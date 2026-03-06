-- Stories table
CREATE TABLE stories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_url VARCHAR(500) NOT NULL,
  media_type VARCHAR(10) NOT NULL DEFAULT 'photo' CHECK (media_type IN ('photo', 'video')),
  caption VARCHAR(500),
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  location_name VARCHAR(255),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Spatial index for location queries
CREATE INDEX idx_stories_location ON stories USING GIST(location);
CREATE INDEX idx_stories_user ON stories(user_id);
CREATE INDEX idx_stories_expires ON stories(expires_at);

-- Story views table
CREATE TABLE story_views (
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (story_id, user_id)
);
