-- Migration 022: Interaction tracking & user preferences for Pika Learning AI
-- Enables preference computation, session memory, bookmarks, and venue affinity scoring

-- ── Table 1: interaction_events ──
-- Logs every meaningful user action for preference computation
CREATE TABLE IF NOT EXISTS interaction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(30) NOT NULL,
    -- event types:
    -- 'venue_view'                - user viewed a venue profile
    -- 'venue_click_from_assistant'- user clicked a venue from assistant results
    -- 'search_query'              - user ran a search
    -- 'assistant_result_click'    - user clicked a result from assistant
    -- 'assistant_session'         - assistant Q&A completed
    -- 'bookmark_add'              - user bookmarked a venue
    -- 'bookmark_remove'           - user removed a bookmark
    -- 'navigate_to'               - user navigated to a venue
  venue_id UUID REFERENCES venues(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
    -- flexible payload per event_type:
    --   venue_view: { source: 'map'|'search'|'assistant'|'trending', dwell_time_ms: number }
    --   search_query: { query: string, result_count: number, filters: {...} }
    --   assistant_session: { answers: {companion,vibe,occasion,budget}, result_count: number }
    --   assistant_result_click: { position: number, total_results: number }
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interaction_user ON interaction_events(user_id);
CREATE INDEX IF NOT EXISTS idx_interaction_type ON interaction_events(event_type);
CREATE INDEX IF NOT EXISTS idx_interaction_venue ON interaction_events(venue_id) WHERE venue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interaction_time ON interaction_events(created_at);
-- Composite index for preference computation queries
CREATE INDEX IF NOT EXISTS idx_interaction_user_type_time ON interaction_events(user_id, event_type, created_at DESC);

-- ── Table 2: user_preferences ──
-- Computed preference profile, recomputed from interaction_events + ku_ratings + assistant_sessions
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Top preferences (JSON arrays ordered by weight, max 5 each)
  -- Format: [{"value":"casual","weight":0.72}, {"value":"fine_dining","weight":0.28}]
  preferred_companions JSONB DEFAULT '[]',
  preferred_vibes JSONB DEFAULT '[]',
  preferred_occasions JSONB DEFAULT '[]',
  preferred_budget INTEGER,  -- most common budget level (1/2/3)
  preferred_categories JSONB DEFAULT '[]',  -- [{"value":"restaurant","weight":0.9}, ...]

  -- Taste profile from ratings (engagement with each sub-rating dimension)
  taste_food_weight NUMERIC(3,2) DEFAULT 0,     -- how often they rate food (0-1)
  taste_service_weight NUMERIC(3,2) DEFAULT 0,
  taste_ambiance_weight NUMERIC(3,2) DEFAULT 0,
  taste_value_weight NUMERIC(3,2) DEFAULT 0,

  -- Usage patterns
  peak_hour INTEGER,            -- most common hour of day (0-23)
  peak_day_of_week INTEGER,     -- most common day (0=Sun, 6=Sat)
  total_interactions INTEGER DEFAULT 0,
  total_ratings INTEGER DEFAULT 0,

  -- Metadata
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  version INTEGER DEFAULT 1
);

-- ── Table 3: bookmarks ──
-- Explicit signal: user saved a venue for later
CREATE TABLE IF NOT EXISTS bookmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, venue_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_venue ON bookmarks(venue_id);

-- ── Table 4: assistant_sessions ──
-- Complete record of each assistant conversation for memory and learning
CREATE TABLE IF NOT EXISTS assistant_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers JSONB NOT NULL DEFAULT '{}',
    -- { "companion": "partner", "vibe": "casual", "occasion": "dinner", "budget": "2" }
  query_text TEXT,             -- if natural language quick search was used
  result_venue_ids UUID[] DEFAULT '{}',
  clicked_venue_ids UUID[] DEFAULT '{}',
  result_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assistant_sessions_user ON assistant_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_time ON assistant_sessions(created_at DESC);

-- ── Materialized View: venue_preference_stats ──
-- Per-venue aggregate stats for affinity scoring
CREATE MATERIALIZED VIEW IF NOT EXISTS venue_preference_stats AS
  SELECT
    v.id as venue_id,
    v.category_id,
    -- Companion distribution from ratings
    COALESCE(
      (SELECT jsonb_object_agg(tag, cnt) FROM (
        SELECT unnest(kr.companion_tags) as tag, COUNT(*) as cnt
        FROM ku_ratings kr WHERE kr.venue_id = v.id
        GROUP BY tag
      ) t),
      '{}'::jsonb
    ) as companion_distribution,
    -- Occasion distribution from ratings
    COALESCE(
      (SELECT jsonb_object_agg(tag, cnt) FROM (
        SELECT unnest(kr.occasion_tags) as tag, COUNT(*) as cnt
        FROM ku_ratings kr WHERE kr.venue_id = v.id
        GROUP BY tag
      ) t),
      '{}'::jsonb
    ) as occasion_distribution,
    -- Average sub-ratings
    COALESCE(AVG(kr.food_rating), 0) as avg_food,
    COALESCE(AVG(kr.service_rating), 0) as avg_service,
    COALESCE(AVG(kr.ambiance_rating), 0) as avg_ambiance,
    COALESCE(AVG(kr.value_rating), 0) as avg_value,
    COUNT(DISTINCT kr.user_id) as unique_raters,
    -- Recent popularity (views in last 7 days)
    COALESCE(
      (SELECT COUNT(*) FROM interaction_events ie
       WHERE ie.venue_id = v.id AND ie.event_type = 'venue_view'
       AND ie.created_at > NOW() - INTERVAL '7 days'),
      0
    ) as recent_views
  FROM venues v
  LEFT JOIN ku_ratings kr ON kr.venue_id = v.id
  WHERE v.is_active = true
  GROUP BY v.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_venue_pref_stats_id ON venue_preference_stats(venue_id);
