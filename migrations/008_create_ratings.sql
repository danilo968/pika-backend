-- KuRatings: native rating system
CREATE TABLE ku_ratings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Quick rating (required)
  overall_rating INTEGER NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),

  -- Optional detailed ratings
  food_rating INTEGER CHECK (food_rating BETWEEN 1 AND 5),
  service_rating INTEGER CHECK (service_rating BETWEEN 1 AND 5),
  ambiance_rating INTEGER CHECK (ambiance_rating BETWEEN 1 AND 5),
  value_rating INTEGER CHECK (value_rating BETWEEN 1 AND 5),

  -- Optional review text
  review_text TEXT,

  -- Context tags for filter matching
  companion_tags TEXT[] DEFAULT '{}',
  occasion_tags TEXT[] DEFAULT '{}',

  -- Media attached to review
  media_urls TEXT[] DEFAULT '{}',

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- One rating per user per venue
  UNIQUE(venue_id, user_id)
);

CREATE INDEX idx_ku_ratings_venue ON ku_ratings(venue_id);
CREATE INDEX idx_ku_ratings_user ON ku_ratings(user_id);
CREATE INDEX idx_ku_ratings_companion ON ku_ratings USING GIN(companion_tags);
CREATE INDEX idx_ku_ratings_occasion ON ku_ratings USING GIN(occasion_tags);
CREATE INDEX idx_ku_ratings_review_text ON ku_ratings USING GIN(to_tsvector('english', COALESCE(review_text, '')));

-- External ratings cache (Google, TrustPilot)
CREATE TABLE external_ratings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  source VARCHAR(50) NOT NULL,
  rating NUMERIC(3,2),
  rating_count INTEGER,
  review_data JSONB,
  last_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(venue_id, source)
);
