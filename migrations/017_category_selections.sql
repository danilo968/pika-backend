-- Migration 017: Track category selections for smart sorting

CREATE TABLE IF NOT EXISTS category_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  category_slug VARCHAR(50) NOT NULL,
  selected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catsel_user ON category_selections(user_id);
CREATE INDEX IF NOT EXISTS idx_catsel_slug ON category_selections(category_slug);
CREATE INDEX IF NOT EXISTS idx_catsel_time ON category_selections(selected_at);

-- Materialized view: global category popularity (refreshed periodically)
CREATE MATERIALIZED VIEW IF NOT EXISTS category_popularity AS
  SELECT category_slug, COUNT(*) AS selection_count
  FROM category_selections
  WHERE selected_at > NOW() - INTERVAL '30 days'
  GROUP BY category_slug;

CREATE UNIQUE INDEX IF NOT EXISTS idx_catpop_slug ON category_popularity(category_slug);
