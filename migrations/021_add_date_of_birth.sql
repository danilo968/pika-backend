-- Add date_of_birth to users table for age-based recommendations
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

-- Add min_age to venue_categories for age-gating
ALTER TABLE venue_categories ADD COLUMN IF NOT EXISTS min_age INTEGER DEFAULT 0;

-- Set age-restricted categories (Albanian law: 18+ for bars, clubs, pubs)
UPDATE venue_categories SET min_age = 18 WHERE slug IN ('nightclub', 'bar', 'pub');
