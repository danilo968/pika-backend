-- Migration 024: Add hotel and brunch_spot venue categories for expanded OSM sync
-- These categories support tourism=hotel, tourism=guest_house from OSM

INSERT INTO venue_categories (slug, name, icon_name, sort_order) VALUES
  ('hotel',       'Hotel',        'hotel',       26),
  ('brunch_spot', 'Brunch Spot',  'brunch_spot', 27)
ON CONFLICT (slug) DO NOTHING;
