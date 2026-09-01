# Week 05 Lab — Trust Boundary Evidence

**Project:** Campus Parking Zones API (mini project) · **Student:** Kanthi Phoosorn 6731503004
**Branch:** `week5-security` · **Run:** local `wrangler dev`, local D1, `AUTH_MODE=demo`
**Resource used instead of `orders`:** `zones` (Part 0 permits substituting your own resource)

## Ownership model

An **operator** owns the zones they are responsible for. Zone records hold a private
`operator_note` (e.g. faulty sensors, closed sections) that must never reach the public feed.

| User | Token | Role | Owns |
|---|---|---|---|
| Alice | `demo-alice` | operator | zones 1, 3 |
| Bob | `demo-bob` | operator | zones 2, 4 |
| Admin | `demo-admin` | admin | — (may read any) |

Public availability stays **unauthenticated on purpose** (`GET /public/zones`) because that is the
product; it exposes no `operator_note` and no `operator_user_id`.

---

## Evidence 1 — Authentication (Checkpoint 1)

```
GET /api/me   no token                    -> 401  {"error":"Unauthorized"}
GET /api/me   Bearer demo-alice           -> 200  {"id":1,"email":"alice@mfu.ac.th","role":"operator"}
GET /api/me   Bearer demo-bob             -> 200  {"id":2,"email":"bob@mfu.ac.th","role":"operator"}
GET /api/me   Bearer demo-admin           -> 200  {"id":3,"email":"admin@mfu.ac.th","role":"admin"}
GET /api/me   Bearer i-am-alice-trust-me  -> 401  {"error":"Unauthorized"}

GET /public/zones   no token              -> 200  4 zones, NO operator_note / operator_user_id
```

---

## Evidence 2 — BOLA / IDOR attack (Parts 6–7)

Against `/lab/vulnerable/zones/:id` — authenticated, but **no ownership check**:

```
[1] Alice -> /lab/vulnerable/zones/1  (her own)   -> 200
    {"id":1,"name":"Zone A - Main Gate",...,"operator_user_id":1,
     "operator_note":"Gate 3 sensor intermittent; counts manually verified 08:00"}

[2] Alice -> /lab/vulnerable/zones/2  (BOB'S)     -> 200   <-- VULNERABILITY
    {"id":2,"name":"Zone B - Library",...,"operator_user_id":2,
     "operator_note":"Closed section B2 for resurfacing until 25 Aug"}

[3] Alice -> /lab/vulnerable/zones/4  (BOB'S)     -> 200   <-- enumerated
    {"id":4,"name":"Zone D - Admin",...,"operator_note":"Reserved bays 1-5 for university guests"}
```

Alice changed `1` to `2`. She did not break encryption, steal a password, bypass login, or touch
the database. **Authentication proved "this is Alice"; it never proved "Alice may read zone 2."**

---

## Evidence 3 — Ownership enforced (Checkpoint 2)

Against the fixed `/api/zones/:id`:

| Test | Expected | Actual | Pass |
|---|---|---|---|
| Alice → zone 1 (her own) | 200 | **200** | ✅ |
| Alice → zone 2 (Bob's) | 404 | **404** | ✅ |
| Bob → zone 2 (his own) | 200 | **200** | ✅ |
| No login → zone 1 | 401 | **401** | ✅ |
| Admin → zone 2 (role override) | 200 | **200** | ✅ |

### Attack 4 — information leakage

```
Alice -> /api/zones/2    (exists, not hers)  -> 404  {"error":"Not found"}
Alice -> /api/zones/999  (does not exist)    -> 404  {"error":"Not found"}
```

Identical status **and** identical body, so response differences cannot reveal which IDs exist.

---

## Evidence 4 — Role check (Part 9 / Attack 2)

```
Alice (operator) -> DELETE /api/admin/users/2        -> 403  {"error":"Forbidden"}
Alice (operator) -> POST   /api/admin/api-clients    -> 403  {"error":"Forbidden"}
```

Refused although Alice is fully authenticated; no UI involved — the server decides.

### Part 11 — client-supplied ownership rejected

Alice creates a zone while claiming `"operator_user_id": 2` (Bob):

```
POST /api/zones {"name":"Zone E - Injected","capacity":50,"free":50,"operator_user_id":2}
-> 201  {"id":5,...,"operator_user_id":1}      <-- taken from the TOKEN, body ignored
```

### Write ownership

```
Alice -> PATCH /api/zones/2  (Bob's)        -> 404
Alice -> PATCH /api/zones/1  (hers)         -> 200   free 45 -> 30, updated_at bumped
Alice -> PATCH /api/zones/1  free=999       -> 422   {"error":"free must be between 0 and capacity"}
```

---

## Evidence 5 — Machine identity (Checkpoint 3, Parts 13–17)

Credential: **`report-agent`**, declared scopes **`["read:zones"]`**. Raw key returned once only;
the database stores just the SHA-256 hash:

```
api_clients: id=1  name=report-agent  key_hash=789b51d71791cc2a34ede7e4...  scopes_json=["read:zones"]  revoked_at=null
```

| Test | Expected | Actual | Pass |
|---|---|---|---|
| `GET /machine/zones` (in scope `read:zones`) | 200 | **200** | ✅ |
| `POST /machine/zones` (needs `write:zones`) | 403 | **403** | ✅ |
| `GET /machine/zones` no credential | 401 | **401** | ✅ |
| `GET /machine/zones` forged key | 401 | **401** | ✅ |
| `GET /machine/zones` **after revoke** | 401 | **401** | ✅ |

Revoking `report-agent` disabled the agent **without** changing Alice's login, logging out the
admin, or breaking any other consumer.

---

## Evidence 6 — Authorisation regression test (Part 23)

`test/authz.test.ts`, 8 tests over `src/authz.ts`.

```
STEP 1  correct policy      ->  Test Files 1 passed | Tests 8 passed
STEP 2  canReadZone broken to `return true`
                            ->  Test Files 1 failed | Tests 2 failed | 6 passed
                                x "must reject an operator reading another operator's zone"
                                x "does not let a viewer read private zone records"
STEP 3  policy restored     ->  Test Files 1 passed | Tests 8 passed
```

The test provably fails when the trust boundary is widened — it is a real regression guard, not
decoration.

---

## Evidence 7 — Secrets (Parts 18–19)

```
.gitignore contains: node_modules/  .wrangler/  .dev.vars  dist/  *.log
git check-ignore .dev.vars            -> ignored
grep for raw wk_ machine keys         -> none found
grep for CLIENT_SECRET/password/keys  -> none found
```

Only demo tokens exist, and they authenticate **only** when `ENVIRONMENT=development` **and**
`AUTH_MODE=demo`.

### Vulnerable route cannot ship

With the default config (`ENABLE_INSECURE_LAB_DEMO=false`):

```
Alice -> /lab/vulnerable/zones/2   -> 404  {"error":"Insecure lab endpoint is disabled"}
Alice -> /api/zones/2  (secure)    -> 404  (ownership still enforced)
Alice -> /api/zones/1  (secure)    -> 200
```

---

## Trust boundary (Part 26)

```
  Identity Provider (OIDC)                    Machine / AI agent
  demo mode in dev                            Authorization: ApiKey wk_...
          | Bearer token                              |
          v                                           v
  +-------------------------------------------------------------+
  |                  Campus Parking Zones API                    |
  |                                                              |
  |  AuthN      verify token -> external_sub                     |
  |  Identity   external_sub -> users.id + role   (never client) |
  |  Role       hasRole(user, ['admin'])                         |
  |  Ownership  canReadZone / canWriteZone                       |
  |  Scope      hasScope(client, 'read:zones')                   |
  |  Revocation api_clients.revoked_at                           |
  +-------------------------------------------------------------+
          |                                     ^
          v                                     |
        D1 database                    GET /public/zones
                                       (no auth - availability only)
```

Decision order: **Authenticated? → correct user? → owns this object? → does this credential allow
this operation? → ALLOW / DENY.**

## Lab completion (Part 27)

- [x] Provider-based login works (demo mode), API identifies current user, `/api/me` works
- [x] Resource has an owner; owner can access it; another user cannot
- [x] An endpoint checks a role; lower-privileged user rejected
- [x] Machine credential exists, has explicit scope, in-scope succeeds, out-of-scope fails, revocable
- [x] No real secret committed; one BOLA attack attempted; regression test exists and passes

---

## Minimum Lab Completion Criteria — A4 evidence map

| Group | Criterion | Status | Where the evidence is |
|---|---|---|---|
| Human Identity | Provider login works | **Partial** | Demo-mode provider simulation tested (Evidence 1). Real OIDC path (`hono/jwk`: signature + `iss` + `aud`) is implemented in `src/index.ts` but never exercised — no provider is configured. |
| Human Identity | API identity mapping works | ✅ | Evidence 1 — `/api/me` maps `external_sub` → `users.id` + role for all three identities |
| Authorisation | Ownership enforced | ✅ | Evidence 3 — Checkpoint 2, all 4 rows (200 / 404 / 200 / 401) + admin override |
| Authorisation | Role rejection tested | ✅ | Evidence 4 — operator → `DELETE /api/admin/users/2` and `POST /api/admin/api-clients` both **403** |
| Machine Identity | Scoped credentials | ✅ | Evidence 5 — `report-agent` declared `["read:zones"]` only |
| Machine Identity | Credentials active | ✅ | Evidence 5 — in-scope `GET /machine/zones` → **200** while active |
| Machine Identity | Hashed storage verified | ✅ | Evidence 5 — D1 row shows `key_hash=789b51d7…`; raw key returned once, never stored |
| Machine Identity | Revocation tested | ✅ | Evidence 5 — after revoke, same key → **401** |
| Validation | Zero secrets in Git | ✅ | Evidence 7 — grep for `wk_` keys and client secrets: none; `.dev.vars` git-ignored |
| Validation | 1 BOLA attack documented | ✅ | Evidence 2 — Alice read Bob's `operator_note` via `1`→`2`, then enumerated zone 4 |
| Validation | 1 Regression test passing | ✅ | Evidence 6 — 8 tests; PASS → deliberately broken → FAIL (2) → restored → PASS |

**Score: 10 of 11 fully evidenced; 1 partial (real provider login).**

**Final mental model check** — every sensitive operation reaches its Allow/Deny decision *on the
server*: authentication in middleware, identity mapping in `getCurrentUser`, and role / ownership /
scope in `src/authz.ts`. No decision is delegated to a client, and the write path ignores
client-supplied `operator_user_id` entirely.
