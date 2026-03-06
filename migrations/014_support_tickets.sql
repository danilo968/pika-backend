-- Support tickets for contact messages and bug reports
CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('contact', 'bug_report')),
  name VARCHAR(255),
  email VARCHAR(255),
  subject VARCHAR(500),
  message TEXT NOT NULL,
  bug_title VARCHAR(500),
  steps_to_reproduce TEXT,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_support_tickets_type ON support_tickets(type);
CREATE INDEX idx_support_tickets_status ON support_tickets(status);
