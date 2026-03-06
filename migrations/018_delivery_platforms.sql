-- Migration 018: Add delivery platforms to venues

ALTER TABLE venues ADD COLUMN IF NOT EXISTS delivery_platforms JSONB DEFAULT '[]';

COMMENT ON COLUMN venues.delivery_platforms IS 'Array of delivery service slugs: wolt, uber_eats, glovo, doordash, lieferando, bolt_food';
