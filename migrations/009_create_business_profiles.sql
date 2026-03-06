-- Business profiles (venue owners / managers)
CREATE TABLE business_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id UUID REFERENCES venues(id) ON DELETE SET NULL,

  business_name VARCHAR(255) NOT NULL,
  business_email VARCHAR(255),
  business_phone VARCHAR(50),
  registration_number VARCHAR(100),

  -- Verification status
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_business_profiles_user ON business_profiles(user_id);
CREATE INDEX idx_business_profiles_venue ON business_profiles(venue_id);
CREATE INDEX idx_business_profiles_status ON business_profiles(status);
