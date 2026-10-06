-- Campus Parking Zones — D1 (SQLite) schema + seed
-- One main resource: zones. Re-runnable (drops + recreates + reseeds).

DROP TABLE IF EXISTS zones;

CREATE TABLE zones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,          -- duplicate name -> 409
  capacity    INTEGER NOT NULL CHECK (capacity >= 0),
  free        INTEGER NOT NULL CHECK (free >= 0),
  permit_type TEXT    NOT NULL DEFAULT 'student'
              CHECK (permit_type IN ('student', 'staff', 'visitor')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- domain invariant: a zone can never show more free spaces than it has
  CHECK (free <= capacity)
);

-- speeds up GET /api/zones?permit_type=...
CREATE INDEX idx_zones_permit_type ON zones (permit_type);

INSERT INTO zones (name, capacity, free, permit_type) VALUES
  ('Zone A - Main Gate', 120, 45,  'student'),
  ('Zone B - Library',    80,  0,  'staff'),
  ('Zone C - Dorm',      200, 133, 'student'),
  ('Zone D - Admin',      40, 12,  'visitor');
