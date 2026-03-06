-- Seed test venues in Prishtina, Kosovo for development/testing
-- Uses real venue names and approximate locations

INSERT INTO venues (name, description, location, address, city, country, category_id, cuisine, price_level, is_active, is_verified, is_featured, ku_rating_avg, ku_rating_count, google_rating, google_rating_count)
SELECT
  v.name, v.description,
  ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)::geography,
  v.address, 'Prishtina', 'Kosovo',
  vc.id, v.cuisine, v.price_level, true, v.is_verified, v.is_featured,
  v.ku_rating, v.ku_count, v.google_rating, v.google_count
FROM (VALUES
  ('Dit e Nat', 'Popular restaurant and bar in the heart of Prishtina', 21.1622, 42.6631, 'Rr. Garibaldi', 'restaurant', 'Mediterranean, Albanian', 3, true, true, 4.3, 28, 4.5, 312),
  ('Prince Coffee House', 'Trendy cafe with great espresso', 21.1648, 42.6625, 'Bulevardi Nene Tereza', 'cafe', 'Coffee, Pastries', 2, true, false, 4.1, 15, 4.3, 189),
  ('Soma Book Station', 'Bookstore cafe with literary vibes', 21.1595, 42.6618, 'Rr. Agim Ramadani', 'cafe', 'Coffee, Smoothies', 2, false, false, 4.5, 22, 4.6, 245),
  ('Liburnia', 'Classic Albanian restaurant with terrace', 21.1670, 42.6640, 'Rr. Luan Haradinaj', 'restaurant', 'Albanian, Grilled', 3, true, false, 4.0, 12, 4.2, 178),
  ('Baresha', 'Modern fusion restaurant', 21.1610, 42.6605, 'Rr. Fehmi Agani', 'restaurant', 'Fusion, International', 4, false, true, 4.6, 35, 4.7, 420),
  ('Home Bar', 'Lively nightlife spot', 21.1635, 42.6620, 'Rr. Garibaldi', 'bar', 'Cocktails, Wine', 2, false, false, 3.8, 8, 4.1, 156),
  ('Brewery Prishtina', 'Craft beer pub with local brews', 21.1655, 42.6645, 'Rr. Rexhep Luci', 'pub', 'Craft Beer, Pub Food', 2, true, false, 4.2, 18, 4.4, 201),
  ('Urban Burger', 'Best burgers in Prishtina', 21.1580, 42.6635, 'Rr. Agim Ramadani', 'fast_food', 'Burgers, American', 1, false, false, 3.9, 10, 4.0, 134),
  ('Pishat', 'Rooftop lounge with city views', 21.1640, 42.6650, 'Sheshi Skenderbeu', 'nightclub', 'Cocktails, DJ', 3, false, true, 4.4, 25, 4.5, 289),
  ('Swiss Diamond Brasserie', 'Fine dining in Hotel Swiss Diamond', 21.1660, 42.6615, 'Sheshi Nena Tereze', 'fine_dining', 'European, Fine Dining', 4, true, true, 4.7, 40, 4.8, 510),
  ('Te Hamami', 'Traditional bakery and pastries', 21.1625, 42.6628, 'Rr. Mujo Ulqinaku', 'bakery', 'Bakery, Pastries', 1, false, false, 4.0, 6, 4.2, 98),
  ('Gelateria Italiana', 'Authentic Italian gelato', 21.1650, 42.6632, 'Bulevardi Nene Tereza', 'ice_cream', 'Gelato, Desserts', 1, false, false, 4.3, 14, 4.5, 167),
  ('Bon Vivant', 'Brunch and breakfast spot', 21.1600, 42.6642, 'Rr. Fehmi Agani', 'brunch_spot', 'Brunch, Breakfast', 2, false, false, 4.1, 9, 4.3, 145),
  ('Innovation Hub', 'Coworking space with cafe', 21.1575, 42.6610, 'Rr. Rexhep Luci', 'coworking_space', 'Coffee, Snacks', 2, false, false, 3.7, 4, 4.0, 56),
  ('Pizza Pronto', 'Wood-fired Neapolitan pizza', 21.1615, 42.6652, 'Rr. Garibaldi', 'pizza', 'Pizza, Italian', 2, false, false, 4.2, 11, 4.4, 198)
) AS v(name, description, lng, lat, address, cat_slug, cuisine, price_level, is_verified, is_featured, ku_rating, ku_count, google_rating, google_count)
JOIN venue_categories vc ON vc.slug = v.cat_slug
ON CONFLICT DO NOTHING;

-- Also add a few venues in Tirana, Albania (default fallback location)
INSERT INTO venues (name, description, location, address, city, country, category_id, cuisine, price_level, is_active, is_verified, is_featured, ku_rating_avg, ku_rating_count, google_rating, google_rating_count)
SELECT
  v.name, v.description,
  ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)::geography,
  v.address, 'Tirana', 'Albania',
  vc.id, v.cuisine, v.price_level, true, v.is_verified, v.is_featured,
  v.ku_rating, v.ku_count, v.google_rating, v.google_count
FROM (VALUES
  ('Mulliri Vjeter', 'Traditional Albanian cuisine in a historic mill', 19.8195, 41.3280, 'Rr. Ismail Qemali', 'restaurant', 'Albanian, Traditional', 3, true, true, 4.5, 32, 4.6, 480),
  ('Mon Cheri', 'Chic cafe on the main boulevard', 19.8175, 41.3265, 'Bulevardi Deshmoret', 'cafe', 'Coffee, Desserts', 2, true, false, 4.2, 18, 4.4, 256),
  ('Radio Bar', 'Iconic nightlife venue', 19.8210, 41.3290, 'Rr. Ismail Qemali', 'bar', 'Cocktails, Music', 2, false, false, 4.0, 14, 4.2, 189),
  ('Colonial', 'Upscale restaurant near the park', 19.8160, 41.3272, 'Rr. Ibrahim Rugova', 'restaurant', 'International, European', 4, true, true, 4.6, 45, 4.7, 560),
  ('Uka Farm', 'Farm-to-table restaurant', 19.8230, 41.3300, 'Rr. Themistokli Germenji', 'restaurant', 'Farm-to-table, Albanian', 3, true, false, 4.4, 28, 4.5, 340),
  ('Blloku Cafe', 'Trendy spot in the Blloku district', 19.8185, 41.3260, 'Rr. Pjeter Bogdani', 'cafe', 'Coffee, Brunch', 2, false, false, 3.9, 8, 4.1, 145),
  ('Era Vila', 'Wine bar with Albanian wines', 19.8200, 41.3275, 'Rr. Sami Frasheri', 'wine_bar', 'Wine, Tapas', 3, false, true, 4.3, 20, 4.5, 267),
  ('Street Food Tirana', 'Quick bites and street food', 19.8170, 41.3285, 'Rr. Myslym Shyri', 'street_food', 'Street Food, Wraps', 1, false, false, 3.8, 6, 4.0, 112),
  ('Serendipity Sushi', 'Japanese fusion restaurant', 19.8190, 41.3268, 'Rr. Ibrahim Rugova', 'sushi', 'Sushi, Japanese', 3, false, false, 4.1, 12, 4.3, 178),
  ('Rooftop Tirana', 'Panoramic rooftop bar', 19.8180, 41.3295, 'Rr. Barrikadave', 'rooftop', 'Cocktails, Lounge', 3, false, true, 4.4, 22, 4.5, 298)
) AS v(name, description, lng, lat, address, cat_slug, cuisine, price_level, is_verified, is_featured, ku_rating, ku_count, google_rating, google_count)
JOIN venue_categories vc ON vc.slug = v.cat_slug
ON CONFLICT DO NOTHING;
