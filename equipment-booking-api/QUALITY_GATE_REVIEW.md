# Quality Gate Review

- **Pre-30-minute snapshot (v1):** commit `2507d5b`, "Equipment booking API v1 (pre-Quality-Gate snapshot)"
- **After review (v2):** the commit after it on the same branch
- **Method:** I ran the same test script (`scripts/evidence.mjs`, 28 cases) against v1 and against v2. I also ran `npm run typecheck` and read the code line by line.

| | v1 (before) | v2 (after) |
|---|---|---|
| Test cases passing | **22 / 28** locally, see [`evidence/v1-before-quality-gate.txt`](evidence/v1-before-quality-gate.txt) | **28 / 28** locally ([`evidence/v2-after-quality-gate.txt`](evidence/v2-after-quality-gate.txt)) **and live** ([`EVIDENCE.md`](EVIDENCE.md)) |
| `tsc --noEmit` | 2 type errors | 0 errors |

Each finding is written as **what I found → how I fixed it → evidence**.

---

### 1. Reliability/Accuracy: a valid back-to-back booking was rejected (false 409), and `+07:00` times were rejected

- **Found:** v1 compared `start_at` and `end_at` as **strings** in whatever format the client sent. `"…T09:00:00Z"` and `"…T09:00:00.000Z"` are the same instant, but as strings `"Z"` sorts after `"."`. As a result, a booking from 08:00 to `09:00:00Z` was reported as overlapping one that starts at `09:00:00.000Z`. Separately, v1 rejected times with a timezone offset such as `2026-10-20T16:00:00+07:00` (400), which is a normal format in Thailand.
- **Fixed:** the API now accepts ISO 8601 with `Z` **or** an offset, then normalises it with `new Date(s).toISOString()` before validating or storing it. Every stored time has the same format, so comparing strings in SQL is the same as comparing times.
- **Evidence:**
  - "Back-to-back written without milliseconds" was a 409 in v1 and is a 201 in v2.
  - "Overlap using +07:00 offset (same instant)" was a 400 in v1 and is a 409 in v2.

### 2. Reliability/Accuracy: a PATCH that didn't mention `purpose` erased it

- **Found:** v1 built the PATCH schema as `bookingSchema.partial()`. That schema had `purpose: …default('')`, and `.partial()` **keeps the default**. So `PATCH {"borrowerName":"x"}` silently set `purpose` to `""`, which is data loss. I spotted it because a manual `PATCH {}` returned `"purpose": ""`.
- **Fixed:** the PATCH schema is now built from the plain field rules with **no defaults**. The update merges onto the current row, so fields that weren't sent keep their stored value.
- **Evidence:** "Update borrowerName only keeps purpose" fails in v1 (`purpose was changed to ""`) and passes in v2.

### 3. Reliability/Accuracy: two simultaneous requests could double-book (race condition)

- **Found:** v1 ran `SELECT` (is there an overlap?) and then a separate `INSERT`. Two requests arriving at the same moment can both pass the SELECT before either inserts, which creates two overlapping bookings. The same was true for PATCH.
- **Fixed:** the check and the write are now **one atomic SQL statement**: `INSERT … SELECT … WHERE EXISTS(equipment) AND NOT EXISTS(overlap) RETURNING id`, and the same pattern with `UPDATE … WHERE …` for PATCH. If no row comes back, the API checks why (the equipment is missing → 400, otherwise → 409).
- **Evidence:** "5 simultaneous requests for the same slot" gives exactly one 201 and four 409 (`201,409,409,409,409`).
  - Against the **live** Worker + Cloudflare D1 (`https://equipment-booking-api.kanthiphs.workers.dev/api`), v2 also gave exactly one 201 and four 409, and all 28 cases passed.
  - *Honest note:* this test also passed on v1 locally, because local D1 runs requests one after another, so the race doesn't show up in local testing. v1 was never deployed live. The fix rests on reasoning about the code. The test is a regression check, not proof that v1 failed.

### 4. Error handling: malformed JSON returned 500 instead of 400

- **Found:** sending `{"equipmentId": "eq-1",` (broken JSON) returned **500 Internal server error**. Hono throws an `HTTPException(400)`, but the v1 `onError` turned every error into a 500.
- **Fixed:** `onError` now checks for `HTTPException` and keeps its status, returning `400 { "error": "Request body is not valid JSON" }`.
- **Evidence:** "Malformed JSON" was a 500 in v1 and is a 400 in v2.

### 5. Security/Validation: unknown fields and empty updates were accepted

- **Found:**
  - `POST` with an extra `"id": 1` returned 201 and silently ignored the field, which risks mass assignment if the code changes later.
  - `PATCH {}` returned 200 and changed `updatedAt`, even though nothing was updated.
- **Fixed:**
  - `z.strictObject` rejects unknown keys with 400.
  - The PATCH schema has `.refine(…'Provide at least one field to update')`.
- **Evidence:**
  - "Unknown field": v1 201 → v2 400.
  - "PATCH with empty body": v1 200 → v2 400.

### 6. Reasoning/You Own It: code didn't typecheck, error messages were unclear, and the 400-vs-404 choice wasn't written down

- **Found:**
  - `npx tsc --noEmit` reported 2 errors in v1. The validation hook was typed for the zod v3 API, but the project uses zod v4. It ran only because Wrangler doesn't typecheck.
  - Validation errors said `"Invalid input: expected string, received undefined"` without naming the field.
  - I also hadn't decided or written down whether a nonexistent `equipmentId` should be a 400 or a 404.
- **Fixed:**
  - The hook is now typed correctly, so the generic `validateJson()` passes `tsc`.
  - Errors name each field (`"equipmentId: is required; endAt: is required"`).
  - I chose **400** for a missing `equipmentId` and wrote the reason in `API_CONTRACT.md`: 404 is for the resource in the URL, and here the URL `/bookings` is valid while a value in the body is wrong.
- **Evidence:**
  - `npm run typecheck`: 2 errors → 0.
  - "Missing required fields" now shows field names (see `EVIDENCE.md`).
  - `API_CONTRACT.md` has the "Status codes and why" table.

---

## What I would do next (not done in the time)

- Authentication, so only the borrower or an admin can change or delete a booking (401/403).
- Pagination for `GET /bookings`.
- Reject bookings in the past and set a maximum duration, if the faculty wants those rules.
