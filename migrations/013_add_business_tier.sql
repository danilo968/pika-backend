-- Add subscription tier to business profiles for premium features
ALTER TABLE business_profiles ADD COLUMN subscription_tier VARCHAR(20) DEFAULT 'free';
-- Values: 'free', 'plus', 'pro'

-- Add gallery images array for Pro tier venues
ALTER TABLE venues ADD COLUMN gallery_images TEXT[] DEFAULT '{}';
