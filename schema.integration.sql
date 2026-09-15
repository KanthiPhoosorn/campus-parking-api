-- Assignment 5 - interface between groups.
-- Additive on top of schema.security.sql. Every table here exists to produce
-- EVIDENCE: each row is a timestamped record of one integration event.
-- Re-runnable: uses IF NOT EXISTS so it can be applied on top of live data.

-- 2. Provider proof - one row per request a partner makes to /partner/*.
CREATE TABLE IF NOT EXISTS request_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  method          TEXT    NOT NULL,
  path            TEXT    NOT NULL,
  client_name     TEXT,                       -- NULL when authentication failed
  status          INTEGER NOT NULL,
  idempotency_key TEXT,
  cf_ray          TEXT,
  latency_ms      INTEGER
);

-- 5. Idempotency proof - a key is claimed BEFORE the write happens, so two
-- concurrent identical requests race on this primary key, not on the zones table.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  client_name     TEXT    NOT NULL,
  key             TEXT    NOT NULL,
  request_hash    TEXT    NOT NULL,
  response_status INTEGER,                    -- NULL while the first request is in flight
  response_body   TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (client_name, key)
);

-- 3. Webhook receiver - EVERY delivery is stored, valid or not, so a forged or
-- replayed call leaves evidence instead of vanishing.
CREATE TABLE IF NOT EXISTS webhook_inbox (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_type       TEXT,
  raw_body         TEXT    NOT NULL,
  signature_header TEXT,
  signature_valid  INTEGER NOT NULL,          -- 1 accepted, 0 rejected
  reason           TEXT                       -- why it was rejected
);

-- 4. Webhook sender - the row is written before the HTTP call and completed
-- after, so a partner outage still leaves a record of what we tried to send.
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  trigger_action  TEXT    NOT NULL,           -- e.g. zone.created
  target_url      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  signature       TEXT    NOT NULL,
  response_status INTEGER,
  response_body   TEXT,
  error           TEXT,
  completed_at    TEXT
);

-- 1./6. Consumer + degradation proof - one row per call we make to the partner.
CREATE TABLE IF NOT EXISTS integration_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  partner_url TEXT    NOT NULL,
  outcome     TEXT    NOT NULL CHECK (outcome IN ('ok', 'degraded', 'recovered')),
  http_status INTEGER,
  latency_ms  INTEGER,
  error       TEXT
);

-- Last known-good partner response, served while the partner is down.
CREATE TABLE IF NOT EXISTS partner_cache (
  cache_key  TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
