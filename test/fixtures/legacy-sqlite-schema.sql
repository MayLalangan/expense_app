-- Final schema of the SQLite version of the app (before the move to Postgres).
-- Used only by test/import-sqlite.test.js.
CREATE TABLE schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 2 AND 40),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE memberships (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'approver', 'editor', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (group_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);
CREATE TABLE invitations (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'approver', 'editor', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_by INTEGER REFERENCES users(id),
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE INDEX invitations_group ON invitations(group_id);
CREATE TABLE budget_entries (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0 AND amount_minor <= 100000000000),
  received_date TEXT NOT NULL CHECK (received_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  
  group_id INTEGER NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  client_request_id TEXT CHECK (client_request_id IS NULL OR length(client_request_id) BETWEEN 8 AND 64),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  archived_by INTEGER REFERENCES users(id),
  archived_at TEXT,
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  UNIQUE (group_id, client_request_id)
);
CREATE INDEX budget_entries_group ON budget_entries(group_id, status);
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0 AND amount_minor <= 100000000000),
  expense_date TEXT NOT NULL CHECK (expense_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  category TEXT CHECK (category IS NULL OR length(category) BETWEEN 1 AND 60),
  
  group_id INTEGER NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  client_request_id TEXT CHECK (client_request_id IS NULL OR length(client_request_id) BETWEEN 8 AND 64),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  archived_by INTEGER REFERENCES users(id),
  archived_at TEXT,
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  UNIQUE (group_id, client_request_id)
);
CREATE INDEX expenses_group ON expenses(group_id, status);
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  record_type TEXT NOT NULL CHECK (record_type IN ('budget_entry', 'expense', 'suggested_purchase')),
  record_id INTEGER NOT NULL,
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  storage_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL,
  replaces_id INTEGER REFERENCES attachments(id),
  removed_by INTEGER REFERENCES users(id),
  removed_at TEXT
);
CREATE INDEX attachments_record ON attachments(record_type, record_id);
CREATE TABLE deletion_requests (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  record_type TEXT NOT NULL CHECK (record_type IN ('budget_entry', 'expense', 'suggested_purchase')),
  record_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) <= 1000),
  -- Defence in depth: nobody may approve or reject their own request.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX deletion_requests_one_pending
  ON deletion_requests(record_type, record_id) WHERE status = 'pending';
CREATE INDEX deletion_requests_group ON deletion_requests(group_id, status);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  group_id INTEGER REFERENCES groups(id),
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_log_record ON audit_log(record_type, record_id);
CREATE INDEX audit_log_group ON audit_log(group_id, id);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  message TEXT NOT NULL,
  link TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, read_at);
CREATE TABLE "groups" (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  currency TEXT NOT NULL CHECK (currency IN ('PHP', 'USD', 'EUR', 'SEK', 'GBP', 'NOK', 'DKK')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE "suggested_purchases" (
  id INTEGER PRIMARY KEY,
  item_name TEXT NOT NULL CHECK (length(item_name) BETWEEN 1 AND 200),
  expected_price_minor INTEGER CHECK (expected_price_minor IS NULL OR (typeof(expected_price_minor) = 'integer' AND expected_price_minor > 0 AND expected_price_minor <= 100000000000)),
  target_date TEXT CHECK (target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  product_url TEXT CHECK (product_url IS NULL OR (length(product_url) <= 2000 AND (product_url LIKE 'http://%' OR product_url LIKE 'https://%'))),
  purchase_status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (purchase_status IN ('suggested', 'approved', 'planned', 'purchased', 'cancelled')),
  expense_id INTEGER UNIQUE REFERENCES expenses(id),
  
  group_id INTEGER NOT NULL REFERENCES groups(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  client_request_id TEXT CHECK (client_request_id IS NULL OR length(client_request_id) BETWEEN 8 AND 64),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  archived_by INTEGER REFERENCES users(id),
  archived_at TEXT,
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  -- An item can be done (purchased) without an expense, but a linked expense implies done.
  CHECK (expense_id IS NULL OR purchase_status = 'purchased'),
  UNIQUE (group_id, client_request_id)
);
CREATE INDEX suggested_purchases_group ON suggested_purchases(group_id, status);
