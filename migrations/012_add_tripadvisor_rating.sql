-- Add TripAdvisor rating columns (replaces Trustpilot as primary 3rd-party source)
-- Trustpilot columns kept for legacy/fallback local reviews
ALTER TABLE venues ADD COLUMN tripadvisor_rating NUMERIC(3,2);
ALTER TABLE venues ADD COLUMN tripadvisor_rating_count INTEGER;
ALTER TABLE venues ADD COLUMN tripadvisor_url VARCHAR(500);
