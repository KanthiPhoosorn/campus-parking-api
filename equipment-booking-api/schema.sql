-- Campus Equipment Booking — D1 (SQLite) schema + seed
-- Safe to re-run: creates tables only if missing, seeds equipment only if missing.

CREATE TABLE IF NOT EXISTS equipment (
  id       TEXT PRIMARY KEY,            -- e.g. 'eq-1' (matches the contract)
  name     TEXT NOT NULL,
  location TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id  TEXT NOT NULL REFERENCES equipment(id),
  borrower_name TEXT NOT NULL,
  start_at      TEXT NOT NULL,          -- ISO 8601 UTC, e.g. 2026-10-20T09:00:00.000Z
  end_at        TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (start_at < end_at)
);

-- overlap check looks up bookings by equipment + time
CREATE INDEX IF NOT EXISTS idx_bookings_equipment_time ON bookings (equipment_id, start_at, end_at);

INSERT OR IGNORE INTO equipment (id, name, location) VALUES
  ('eq-1', 'Projector A',      'Building 1'),
  ('eq-2', 'Camera B',         'Building 2'),
  ('eq-3', 'Meeting Room 301', 'Building 3');
