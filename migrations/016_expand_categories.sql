-- Migration 016: Expand venue categories with icon_name and 15 new categories

ALTER TABLE venue_categories ADD COLUMN IF NOT EXISTS icon_name VARCHAR(50);

-- Update existing categories with icon names
UPDATE venue_categories SET icon_name = slug WHERE icon_name IS NULL;

-- Insert new categories (sort_order continues from existing 10)
INSERT INTO venue_categories (slug, name, icon_name, sort_order) VALUES
  ('pizza',        'Pizza',          'pizza',        11),
  ('sushi',        'Sushi',          'sushi',        12),
  ('steakhouse',   'Steakhouse',     'steakhouse',   13),
  ('seafood',      'Seafood',        'seafood',      14),
  ('vegan',        'Vegan',          'vegan',        15),
  ('dessert',      'Desserts',       'dessert',      16),
  ('food_truck',   'Food Truck',     'food_truck',   17),
  ('wine_bar',     'Wine Bar',       'wine_bar',     18),
  ('cocktail_bar', 'Cocktail Bar',   'cocktail_bar', 19),
  ('brewery',      'Brewery',        'brewery',      20),
  ('rooftop',      'Rooftop',        'rooftop',      21),
  ('hookah',       'Hookah Lounge',  'hookah',       22),
  ('buffet',       'Buffet',         'buffet',       23),
  ('fine_dining',  'Fine Dining',    'fine_dining',  24),
  ('street_food',  'Street Food',    'street_food',  25)
ON CONFLICT (slug) DO NOTHING;
