-- Enable trigram extension for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Venue categories lookup table
CREATE TABLE venue_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  icon VARCHAR(10),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed categories
INSERT INTO venue_categories (slug, name, icon, sort_order) VALUES
  ('restaurant', 'Restaurant', NULL, 1),
  ('cafe', 'Cafe', NULL, 2),
  ('bar', 'Bar', NULL, 3),
  ('pub', 'Pub', NULL, 4),
  ('nightclub', 'Nightclub', NULL, 5),
  ('fast_food', 'Fast Food', NULL, 6),
  ('bakery', 'Bakery', NULL, 7),
  ('ice_cream', 'Ice Cream', NULL, 8),
  ('brunch_spot', 'Brunch Spot', NULL, 9),
  ('coworking_space', 'Co-working', NULL, 10);

-- Venues table
CREATE TABLE venues (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  address VARCHAR(500),
  city VARCHAR(100),
  country VARCHAR(100),
  phone VARCHAR(50),
  email VARCHAR(255),
  website VARCHAR(500),
  category_id UUID REFERENCES venue_categories(id),
  cuisine VARCHAR(255),
  price_level INTEGER CHECK (price_level BETWEEN 1 AND 4),
  opening_hours JSONB,
  cover_image_url VARCHAR(500),

  -- External IDs for data linking
  google_place_id VARCHAR(255) UNIQUE,
  trustpilot_business_id VARCHAR(255),
  overpass_node_id BIGINT,

  -- Flags
  is_verified BOOLEAN DEFAULT false,
  is_featured BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,

  -- Denormalized ratings for fast reads
  ku_rating_avg NUMERIC(3,2) DEFAULT 0,
  ku_rating_count INTEGER DEFAULT 0,
  google_rating NUMERIC(3,2),
  google_rating_count INTEGER,
  trustpilot_rating NUMERIC(3,2),
  trustpilot_rating_count INTEGER,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Spatial index for nearby queries
CREATE INDEX idx_venues_location ON venues USING GIST(location);
CREATE INDEX idx_venues_category ON venues(category_id);
CREATE INDEX idx_venues_city ON venues(city);
CREATE INDEX idx_venues_google_place ON venues(google_place_id);
CREATE INDEX idx_venues_name_trgm ON venues USING GIN(name gin_trgm_ops);
CREATE INDEX idx_venues_active ON venues(is_active) WHERE is_active = true;
CREATE INDEX idx_venues_overpass ON venues(overpass_node_id);

-- Many-to-many: venue can belong to multiple categories
CREATE TABLE venue_category_map (
  venue_id UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES venue_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (venue_id, category_id)
);
