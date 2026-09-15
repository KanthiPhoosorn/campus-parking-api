# A5 — Team 11 Integration Evidence

**Course:** 1305308 Platform Development · **Assignment 5:** Interface between Groups
**Team 11 — Campus Transport & Parking** · submitted by Kanthi Phoosorn (6731503004)
**Integration worker:** https://campus-parking-integration.kanthiphs.workers.dev
**Source:** `KanthiPhoosorn/campus-parking-api`, branch `a5-integration`
**Evidence run:** `20260915T081341Z` (UTC) — full raw transcript in `evidence/a5/run-20260915T081341Z.txt`, produced by `scripts/a5-evidence.sh`

Everything below was captured against the deployed worker and its remote D1 database, not a local dev server. Timestamps are ISO-8601 UTC as printed by the run; `CF-RAY` values are Cloudflare's own request IDs and can be matched against the Workers log.

---

## What we built

The A2 parking-zones API gained a partner-facing surface. It is deployed as a **separate worker and separate D1 database** from the graded A2 submission so that submission's URL and data stay untouched.

| Proof | Route / mechanism | Evidence table |
|---|---|---|
| 2 Provider | `GET /partner/zones`, machine credential with `partner:read` | `request_log` |
| 5 Idempotency | `POST /partner/zones` + `Idempotency-Key`, `partner:write` | `idempotency_keys`, `zones` |
| 3 Webhook receiver | `POST /webhooks/partner`, HMAC-SHA256 over `t.body`, 300 s replay window | `webhook_inbox` |
| 4 Webhook sender | `zone.created` / `zone.updated` → signed POST to partner | `webhook_outbox` |
| 1 Consumer | `GET /integration/partner/zones` → partner API, 3 s timeout | `integration_log`, `partner_cache` |
| 6 Degradation | same route: on failure serve last-good cache, flag `degraded`, log `recovered` on first success | `integration_log` |

Machine credentials reuse the Week 05 model: the key is shown once, only its SHA-256 is stored, scopes are explicit, revocation is server-side.

### Partner status — read this first

At the time of this run our partner team's endpoints were not yet available, so the two outbound targets point at **external public HTTP services as stand-ins**: the consumer calls `https://jsonplaceholder.typicode.com/users?_limit=2` and the webhook sender delivers to `https://httpbin.org/post` (which echoes the request back, so the delivered signature header is visible). They are real, third-party HTTP origins with real latency and real failure modes; nothing is mocked in-process.

Switching to the real partner is three vars and one secret, then re-running the script:

```
wrangler.jsonc  PARTNER_BASE_URL, PARTNER_ZONES_PATH, PARTNER_WEBHOOK_URL
wrangler secret put PARTNER_API_KEY            # the credential they issue us
wrangler secret put OUTBOUND_WEBHOOK_SECRET    # the secret they give us to sign with
```

One finding worth recording: a Worker **cannot** `fetch()` another `*.workers.dev` worker in the same Cloudflare account — every such call returns HTTP 404 with body `error code: 1042`. Our first evidence run hit this when we tried to use our own A2 API as the stand-in. A partner team on their own account is unaffected.

---

## 1. Consumer Proof

**Partner URL:** `https://jsonplaceholder.typicode.com/users?_limit=2` (stand-in, see above)
**Request:** `2026-09-15T08:14:11.609Z` `GET https://campus-parking-integration.kanthiphs.workers.dev/integration/partner/zones` · `CF-RAY a3b62d2feae20425-HKG`
**Response:** HTTP 200 in 0.69 s

```json
{
  "degraded": false,
  "source": "partner",
  "partner_url": "https://jsonplaceholder.typicode.com/users?_limit=2",
  "requested_at": "2026-09-15T08:14:12.473Z",
  "latency_ms": 198,
  "recovered": false,
  "data": [
    { "id": 1, "name": "Leanne Graham", "username": "Bret", "email": "Sincere@april.biz", "…": "…" },
    { "id": 2, "name": "Ervin Howell", "username": "Antonette", "email": "Shanna@melissa.tv", "…": "…" }
  ]
}
```

**Internal log** (`integration_log`):

```
id | at                       | partner_url                                        | outcome | http_status | latency_ms
 1 | 2026-09-15T08:14:12.696Z | https://jsonplaceholder.typicode.com/users?_limit=2 | ok      | 200         | 198
```

---

## 2. Provider Proof

**Our endpoint:** `https://campus-parking-integration.kanthiphs.workers.dev/partner/zones`

Credential issued to the partner (admin action, key redacted — the server only holds its hash):

```
POST /api/admin/api-clients   2026-09-15T08:13:41.826Z   HTTP 201
{ "id": 1, "name": "partner-team-20260915T081341Z", "scopes": ["partner:read","partner:write"], "api_key": "wk_Pgql…" }

api_clients: 1 | partner-team-20260915T081341Z | key_hash 6409b95ed1ba… | ["partner:read","partner:write"] | 2026-09-15 08:13:42
```

Partner request with the credential — `2026-09-15T08:13:44.384Z` `GET /partner/zones` `Authorization: ApiKey wk_…` · `CF-RAY a3b62c84e9d8c8a7-HKG` → **HTTP 200**:

```json
{
  "provider": "team11-campus-parking",
  "served_at": "2026-09-15T08:13:45.200Z",
  "zones": [
    { "id": 1, "name": "Zone A - Main Gate", "capacity": 120, "free": 45,  "permit_type": "student", "updated_at": "2026-09-15 08:06:33" },
    { "id": 2, "name": "Zone B - Library",   "capacity": 80,  "free": 0,   "permit_type": "staff",   "updated_at": "2026-09-15 08:06:33" },
    { "id": 3, "name": "Zone C - Dorm",      "capacity": 200, "free": 133, "permit_type": "student", "updated_at": "2026-09-15 08:06:33" },
    { "id": 4, "name": "Zone D - Admin",     "capacity": 40,  "free": 12,  "permit_type": "visitor", "updated_at": "2026-09-15 08:06:33" }
  ]
}
```

Same request without a credential — `2026-09-15T08:13:44.853Z` → **HTTP 401** `{"error":"Invalid machine credential"}`.

**Internal request log** (`request_log`, every `/partner/*` call, written server-side):

```
id | received_at              | method | path           | client_name                   | status | cf_ray               | latency_ms
 2 | 2026-09-15T08:13:45.538Z | GET    | /partner/zones | NULL                          | 401    | a3b62c87788dfe10     | 0
 1 | 2026-09-15T08:13:45.221Z | GET    | /partner/zones | partner-team-20260915T081341Z | 200    | a3b62c84e9d8c8a7     | 83
```

**Partner confirmation:** the server-side half is above — `request_log` row 1 records the partner credential (`client_name`), the status our server returned, and Cloudflare's own request id `a3b62c84e9d8c8a7`, which the caller sees in their `CF-RAY` response header. The client-side half — the partner's screenshot of that same `CF-RAY` — will be pasted here by the partner team once they have run the call with their key; that is the only line in this document a provider cannot produce alone.

---

## 3. Webhook Receiver

**Endpoint:** `POST https://campus-parking-integration.kanthiphs.workers.dev/webhooks/partner`
**Contract:** header `X-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` using the shared secret; deliveries older than 300 s are refused. Every delivery is stored, accepted or not.

**Incoming payload** (as the partner would send it):

```json
{"event":"slot.reserved","source":"partner-team","data":{"reservation_id":"R-1001","zone_id":1,"plate":"กข 1234"}}
```

| Case | Sent | Signature | Result |
|---|---|---|---|
| a) correctly signed | `08:14:08.115Z` | `t=1789460048,v1=cdb0b727…3af2f` | **200** `{"accepted":true,"inbox_id":1,"received_at":"2026-09-15T08:14:08.861Z","event":"slot.reserved"}` |
| b) forged (wrong secret) | `08:14:08.556Z` | `t=…,v1=deadbeef` | **401** `{"accepted":false,"reason":"signature mismatch","inbox_id":2}` |
| c) replayed (signed 10 min ago) | `08:14:08.952Z` | valid HMAC, stale `t` | **401** `{"accepted":false,"reason":"timestamp outside 300s replay window","inbox_id":3}` |

**Stored log** (`webhook_inbox`):

```
id | received_at              | event_type    | signature_valid | reason
 3 | 2026-09-15T08:14:09.755Z | slot.reserved | 0               | timestamp outside 300s replay window
 2 | 2026-09-15T08:14:09.224Z | slot.reserved | 0               | signature mismatch
 1 | 2026-09-15T08:14:08.861Z | slot.reserved | 1               | NULL
```

Signature verification is unit-tested (`test/integration.test.ts`: tampered body, wrong secret, stale timestamp, missing/malformed header — 8 tests, all passing).

---

## 4. Webhook Sender

**Internal trigger action:** the partner's `POST /partner/zones` in section 5 created zone 6, which fires `zone.created`. (`PATCH /api/zones/:id` fires `zone.updated` the same way.) The outbox row is written *before* the HTTP call and completed after, so a partner outage would still leave a record.

**Outgoing payload** and signature (`webhook_outbox` id 1, created `2026-09-15T08:13:54.732Z`):

```json
{"event":"zone.created","source":"team11-campus-parking","sent_at":"2026-09-15T08:13:54.674Z","data":{"id":6,"name":"Zone I-20260915T081341Z","capacity":40,"free":40,"permit_type":"visitor","updated_at":"2026-09-15 08:13:54"}}
```
```
X-Webhook-Signature: t=1789460034,v1=948b84d1a545da4acd5e9105cb47abe06767f3f1daad926d6efac630dd347d12
```

**Partner response log:** target `https://httpbin.org/post` → **HTTP 200**, completed `2026-09-15T08:13:55.825Z`. The partner's echo shows exactly what arrived — our body, our `User-Agent`, and the signature header:

```json
{
  "data": "{\"event\":\"zone.created\",\"source\":\"team11-campus-parking\",\"sent_at\":\"2026-09-15T08:13:54.674Z\",\"data\":{\"id\":6,…}}",
  "headers": {
    "Cf-Worker": "kanthiphs.workers.dev",
    "Content-Type": "application/json",
    "User-Agent": "team11-campus-parking-webhook/1.0",
    "X-Webhook-Signature": "t=1789460034,v1=948b84d1a545da4acd5e9105cb47abe06767f3f1daad926d6efac630dd347d12"
  }
}
```

```
webhook_outbox: 1 | 2026-09-15T08:13:54.732Z | zone.created | https://httpbin.org/post | 200 | 2026-09-15T08:13:55.825Z | error NULL
```

---

## 5. Idempotency Proof

`Idempotency-Key: a5-20260915T081341Z-booking-42` — three requests to `POST /partner/zones`.

**Request 1** `2026-09-15T08:13:53.681Z` · body `{"name":"Zone I-20260915T081341Z","capacity":40,"free":40,"permit_type":"visitor"}` · `CF-RAY a3b62cbf7a1c0721-HKG`
→ **HTTP 201** · `Idempotent-Replayed: false`

```json
{"created":true,"zone":{"id":6,"name":"Zone I-20260915T081341Z","capacity":40,"free":40,"permit_type":"visitor","updated_at":"2026-09-15 08:13:54"}}
```

**Request 2** `2026-09-15T08:13:54.375Z` · byte-identical body and key · `CF-RAY a3b62cc39ad484d3-HKG`
→ **HTTP 201** · `Idempotent-Replayed: true` · identical body, same `"id": 6` — no second zone.

**Request 3** `2026-09-15T08:13:54.946Z` · same key, body changed to `"free":1`
→ **HTTP 409** `{"error":"Idempotency-Key was already used with a different payload"}`

**DB proof of single creation:**

```
SELECT COUNT(*) AS rows_created, name FROM zones WHERE name = 'Zone I-20260915T081341Z'
rows_created | name
 1           | Zone I-20260915T081341Z

idempotency_keys
client_name                   | key                            | request_hash      | response_status | created_at
partner-team-20260915T081341Z | a5-20260915T081341Z-booking-42 | 94549e36ee2560fc… | 201             | 2026-09-15T08:13:54.582Z
```

How it holds under concurrency: the key is claimed with `INSERT OR IGNORE` into `idempotency_keys` (primary key `client_name, key`) *before* the zone insert, so two simultaneous identical requests race on that primary key, not on the `zones` table; the loser reads the winner's stored response. The request hash is over a canonical JSON form, so key order or whitespace can't split one logical request into two.

---

## 6. Degradation Proof

The consumer was broken for real — the worker was redeployed with `PARTNER_BASE_URL` pointing at a non-existent host — then restored. No code changed between the three calls.

**Breakage timestamp:** `2026-09-15T08:14:14.769Z` (deploy version `a3ab447f-…`)

**Fallback JSON** — `2026-09-15T08:14:35.833Z` `GET /integration/partner/zones` · `CF-RAY a3b62dc66fa2ff7e-SIN` → **HTTP 200** (a usable answer, clearly labelled, not a 5xx):

```json
{
  "degraded": true,
  "source": "cache",
  "partner_url": "https://partner-is-down.invalid/users?_limit=2",
  "requested_at": "2026-09-15T08:14:36.553Z",
  "partner_error": "partner responded 530: error code: 1016",
  "cache_fetched_at": "2026-09-15T08:14:12.473Z",
  "data": [ { "id": 1, "name": "Leanne Graham", "…": "…" }, { "id": 2, "name": "Ervin Howell", "…": "…" } ]
}
```

`data` is the snapshot fetched at `08:14:12.473Z` in section 1 — the last good partner response, served from `partner_cache`.

**Recovery:** redeployed with the real URL at `2026-09-15T08:14:36.283Z` (version `7e9137ea-…`). First call afterwards — `2026-09-15T08:14:56.700Z` → **HTTP 200**, `"degraded": false, "source": "partner", "recovered": true, "latency_ms": 38`.

**Automatic recovery log** (`integration_log`):

```
id | at                       | outcome   | http_status | latency_ms | error
 3 | 2026-09-15T08:14:57.608Z | recovered | 200         | 38         | NULL
 2 | 2026-09-15T08:14:36.602Z | degraded  | NULL        | 24         | partner responded 530: error code: 1016
 1 | 2026-09-15T08:14:12.696Z | ok        | 200         | 198        | NULL
```

`recovered` is written by the server itself: on a successful call it checks whether the previous log row was `degraded`. Nobody flips a flag by hand.

---

## Reproduce

```bash
git checkout a5-integration
npm test                              # 16 unit tests (authz + integration)
bash scripts/a5-evidence.sh           # ~90 s; two redeploys for the outage; writes evidence/a5/run-<ts>.txt
```

Needs `wrangler login`, and `.dev.vars` with `INBOUND_WEBHOOK_SECRET` (the same value stored as the worker secret).

## For the partner team

**We give you:** an `ApiKey` credential (scopes `partner:read`, `partner:write`), the webhook secret to sign with, and this contract:

- `GET /partner/zones` — `Authorization: ApiKey wk_…`
- `POST /partner/zones` — same header plus `Idempotency-Key: <your unique id>`; body `{ "name", "capacity", "free", "permit_type"? }`; replays return the original response with `Idempotent-Replayed: true`
- `POST /webhooks/partner` — JSON body with an `event` field; header `X-Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`; sign the exact bytes you send

**We need from you:** your base URL and zones path, the credential we should call with, your webhook receiver URL, and the secret you want our webhooks signed with.
