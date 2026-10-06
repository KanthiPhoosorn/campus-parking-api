# Quality Gate Review

This review follows the instructor's `quality_gate.md`. It was used twice: after minute 30, and again as the final check before submission. The review and fixes were AI-assisted; see `AI_LOG.md`.

- **Pre-30-minute snapshot (v1):** commit `2507d5b`, "Equipment booking API v1 (pre-Quality-Gate snapshot)"
- **After the review:** the later commits on the same branch
- **Method:**
  - Ran the same 28-case test script (`scripts/evidence.mjs`) against v1 and against the reviewed version.
  - Ran the instructor's cURL Quick Test Guide with real `curl` (`scripts/curl-guide.mjs`).
  - Ran `npm run typecheck`.
  - Reviewed the code against each of the eight Quality Gate sections.

| | v1 (before) | After review |
|---|---|---|
| Test cases passing | **22 / 28** locally ([`evidence/v1-before-quality-gate.txt`](evidence/v1-before-quality-gate.txt)) | **28 / 28** locally ([`evidence/v2-after-quality-gate.txt`](evidence/v2-after-quality-gate.txt)) **and live** ([`evidence/v2-live-run.txt`](evidence/v2-live-run.txt)) |
| Instructor's cURL guide | — | **9 / 9** ([`evidence/curl-guide-local.txt`](evidence/curl-guide-local.txt); live: `evidence/curl-guide-live.txt`) |
| `tsc --noEmit` | 2 type errors | 0 errors |

## Quality Gate Review Record

| # | Quality Gate area | Finding | Action taken | Evidence |
|---|---|---|---|---|
| 1 | **Accuracy** | Times were compared as strings in whatever format was sent, so a valid back-to-back booking got a false **409** and `+07:00` times were rejected | Accept `Z` or an offset, and normalise every time to UTC with `toISOString()` before comparing or storing | "Back-to-back without milliseconds" 409 → 201. "+07:00 overlap" 400 → 409 |
| 2 | **Reliability** | `PATCH` without `purpose` **erased** the stored purpose (`.partial()` kept the `default('')`) | PATCH schema built with no defaults; fields that aren't sent keep their stored value | "Update borrowerName only keeps purpose" FAIL → PASS |
| 3 | **Reliability** | Separate SELECT-then-INSERT allowed two simultaneous requests to double-book | One atomic `INSERT/UPDATE … WHERE NOT EXISTS (overlap)` | 5 parallel requests → `201,409,409,409,409`, both locally and live |
| 4 | **Reliability** | Malformed JSON crashed into **500** | `onError` keeps `HTTPException` status → `400 {"error":"Request body is not valid JSON"}` | "Malformed JSON" 500 → 400 |
| 5 | **Accuracy** | Unknown fields (`"id": 1`) silently accepted; `PATCH {}` returned 200 | `z.strictObject` + "at least one field" rule | "Unknown field" 201 → 400. "PATCH empty body" 200 → 400 |
| 6 | **Reasoning** | Code didn't typecheck. Errors didn't name the field. The 400-vs-404 choice for an unknown `equipmentId` wasn't decided | Fixed types. Errors name each field. Chose **400** and wrote the reason in `API_CONTRACT.md` | `tsc` 2 errors → 0. "Status codes and why" table |
| 7 | **Delivery Quality** | CORS (`Access-Control-Allow-Origin: *`) was enabled, but no browser client is used. The Quality Gate says to include CORS only when using one | Removed the CORS middleware | `evidence/curl-guide-local.txt` headers no longer contain `Access-Control-Allow-Origin` |
| 8 | **Accuracy** | A POST/PATCH sent **without** `Content-Type: application/json` reported every field as "is required" even though the body had them. That's misleading, and it's easy to hit with curl on Windows | Check the Content-Type first → `400 {"error":"Content-Type must be application/json"}` | See finding 8 below |
| 9 | **Execution Value** | The submission hadn't yet been tested with the instructor's own cURL guide | Added `scripts/curl-guide.mjs`, which runs guide steps 1–9 with the real `curl` program and saves the raw `curl -i` output | 9/9 steps return the expected status (`evidence/curl-guide-*.txt`) |
| 10 | **Reliability** | Re-running the cURL guide on the **live** API failed step 5 (**409**, expected 200). Diagnosis: step 2 showed booking 20, left in the guide's fixed slot (eq-1, 2026-10-20 12:00–14:00) by an earlier run that never reached step 9's delete. The API was **correct** to refuse the overlapping update | Deleted the leftover row (only that row) from live D1. The script now keeps going if one `curl` call fails (so step 9 always cleans up), and it warns when leftover data is in the guide's time window | Live run 1: 8/9 (excerpt below). Same failure reproduced locally (8/9 with a leftover → 9/9 after deleting it). Live rerun: `evidence/curl-guide-live.txt` |

## Details

Each finding is written as **what was found → how it was fixed → evidence**.

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

### 7. Delivery Quality: CORS enabled with no browser client

- **Found:** every response carried `Access-Control-Allow-Origin: *`. Quality Gate section 7 says to include CORS configuration *only if I chose to use a browser-based client*, and this project is tested with curl and a Node script.
- **Fixed:** removed `cors()`. curl and server-to-server calls don't use CORS, so nothing else changes.
- **Evidence:** the raw headers in `evidence/curl-guide-local.txt` have no `Access-Control-Allow-Origin`, and all 28 cases still pass.

### 8. Accuracy: missing Content-Type gave a misleading error

- **Found:** `curl -X POST …/bookings -d '{"equipmentId":"eq-1"}'` (no header) returned `"equipmentId: is required; borrowerName: is required; …"`, even though `equipmentId` was in the body. Hono only parses the body as JSON when the header says so.
- **Fixed:** a small middleware on `/bookings` checks the header first for POST/PATCH. `application/json; charset=utf-8` is still accepted.
- **Evidence:**
  ```
  $ curl -X POST http://localhost:8787/api/bookings -d '{}'
  {"error":"Content-Type must be application/json"}        (400)
  ```

### 9. Execution Value: tested with the instructor's cURL guide

- **Found:** the evidence so far came from a Node `fetch` script. The brief asks for testing with `curl` or another HTTP client, and the instructor supplied a specific cURL guide.
- **Fixed:** `node scripts/curl-guide.mjs <BASE_URL>` runs guide steps 1–9 exactly as written (same payloads, `BOOKING_ID` taken from step 3, `/bookings/not-found` for 404) using the real `curl` binary. It works on Windows too, because it calls `curl.exe` directly and avoids PowerShell's quoting problems.
- **Evidence:** 9/9 locally (`evidence/curl-guide-local.txt`). The live run is saved as `evidence/curl-guide-live.txt`.

### 10. Reliability: the cURL guide failed on a re-run because of leftover test data

- **Found:** the first live run of the instructor's guide on the final version gave **8/9**. Excerpt from the raw output:
  ```
  ## 2. List bookings (expect 200) -> PASS
  [{"id":20,"equipmentId":"eq-1","borrowerName":"Somchai Jaidee","startAt":"2026-10-20T12:00:00.000Z","endAt":"2026-10-20T14:00:00.000Z","purpose":"Updated class presentation","createdAt":"2026-10-06T07:07:54.983Z","updatedAt":"2026-10-06T07:07:57.515Z"}]
  ## 5. Update a booking (expect 200) -> FAIL
  HTTP/1.1 409 Conflict
  {"error":"This equipment is already booked for an overlapping time"}
  ```
  Booking 20 is exactly what step 5 leaves behind. An earlier run must have stopped before step 9 (`DELETE`). So step 5 of the new run tried to move booking 21 onto booking 20's slot. The API was right to answer 409, and this incidentally shows that the overlap check on **update** works in production. The real risk was different: the instructor running the same guide against the live URL would also have got a 409 at step 5.
- **Action taken:**
  1. Deleted exactly that row from the live D1 database (`DELETE … WHERE id = 20 AND …` matching every column).
  2. `scripts/curl-guide.mjs` now catches a failed `curl` call and carries on, so step 9 always deletes the booking from step 3.
  3. After step 2 the script prints a warning if any booking already occupies eq-1 on 2026-10-20 09:00–14:00.
- **Evidence:**
  - Local reproduction: with a leftover booking, the run gives 8/9 plus the warning. After deleting it, 9/9.
  - Live database after cleanup: 0 bookings, 3 equipment.
  - Live rerun: `evidence/curl-guide-live.txt`.

## Quality Gate checklist: final pass

| Section | Status | Where to check |
|---|---|---|
| 1. Purpose | ✅ Routes, bodies, and status codes match the common contract. The only extras are an index at `/api` and an optional `?equipmentId=` filter | `API_CONTRACT.md` |
| 2. Reliability | ✅ Data persists in D1. Overlaps are blocked on create **and** update. `equipmentId` is checked. Invalid requests never give a 500 | Findings 2, 3, 4 |
| 3. Course Context | ✅ TypeScript + Hono + D1 as specified. AI use is recorded | `AI_LOG.md` |
| 4. Reasoning | ✅ 400/404/409 reasons, overlap formula, and assumptions are written down | `API_CONTRACT.md` |
| 5. Execution Value | ✅ README run steps. All endpoints work. Tested with curl | Finding 9, `EVIDENCE.md` |
| 6. Accuracy | ✅ `startAt < endAt` enforced. Every error is `{ "error": "..." }`. Parameter binding everywhere | Findings 1, 5, 8 |
| 7. Delivery Quality | ✅ README, contract, ERD, and evidence for 28 + 9 cases. No CORS without a browser client | Finding 7 |
| 8. You Own It | ⬜ **Student to confirm:** can explain every route, rule, query, and result in my own words | `AI_LOG.md` checklist |

**Submission decision:** **READY**, once I have confirmed section 8 (You Own It) myself.

## What I would do next (not done in the time)

- Authentication, so only the borrower or an admin can change or delete a booking (401/403).
- Pagination for `GET /bookings`.
- Reject bookings in the past and set a maximum duration, if the faculty wants those rules.
