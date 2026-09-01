-- Week 05 Security Lab — trust boundary schema for the Campus Parking Zones API
-- Adapts the lab's users / <resource> / api_clients model to this mini project.
-- Ownership model: an OPERATOR owns the zones they are responsible for.
-- Re-runnable: drops and recreates everything, then seeds demo identities.

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS api_clients;
DROP TABLE IF EXISTS zones;
DROP TABLE IF EXISTS users;

-- Part 1 — our own user record, keyed to the external identity provider subject
CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  external_sub TEXT NOT NULL UNIQUE,
  email        TEXT,
  role         TEXT NOT NULL DEFAULT 'viewer'
                 CHECK (role IN ('viewer', 'operator', 'admin')),
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Part 2 — ownership on the mini-project resource
CREATE TABLE zones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  capacity         INTEGER NOT NULL CHECK (capacity >= 0),
  free             INTEGER NOT NULL CHECK (free >= 0),
  permit_type      TEXT    NOT NULL DEFAULT 'student',
  -- the operator responsible for this zone == the owner
  operator_user_id INTEGER NOT NULL,
  -- private operational data: must NOT be exposed on the public availability feed
  operator_note    TEXT,
  created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (free <= capacity),
  FOREIGN KEY (operator_user_id) REFERENCES users(id)
);

-- Part 13 — machine credentials (hash only, never the raw key)
CREATE TABLE api_clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  key_hash    TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (external_sub, email, role) VALUES
  ('demo-alice', 'alice@mfu.ac.th', 'operator'),
  ('demo-bob',   'bob@mfu.ac.th',   'operator'),
  ('demo-admin', 'admin@mfu.ac.th', 'admin');

-- Alice operates zones 1 and 3; Bob operates zones 2 and 4.
INSERT INTO zones (name, capacity, free, permit_type, operator_user_id, operator_note) VALUES
  ('Zone A - Main Gate', 120,  45, 'student', 1, 'Gate 3 sensor intermittent; counts manually verified 08:00'),
  ('Zone B - Library',    80,   0, 'staff',   2, 'Closed section B2 for resurfacing until 25 Aug'),
  ('Zone C - Dorm',      200, 133, 'student', 1, 'Night shift only; barrier code rotates weekly'),
  ('Zone D - Admin',      40,  12, 'visitor', 2, 'Reserved bays 1-5 for university guests');
