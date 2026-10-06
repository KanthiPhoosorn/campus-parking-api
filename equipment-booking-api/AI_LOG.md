# AI Log

**Tool:** Claude Code (AI coding assistant), used through the Claude app in a cloud session connected to my GitHub repo and my Cloudflare account.

> ⚠️ **Edit this file in your own words before submitting.** The AI drafted it. Tick a box under "What I verified myself" only after you have actually done that check.

## Important prompts and what I used

| # | My prompt (summary) | What the AI produced | What I used / changed |
|---|---|---|---|
| 1 | Before the test: "Prepare for these" + the list of exam topics | Hardened my earlier parking API, a test suite, and study notes (`PREP.md`) | Used it as revision material, not as exam code |
| 2 | "Use Cloudflare D1, I can't submit by localhost" | Steps for deploying to Workers + D1 | Used the deploy steps in the README |
| 3 | Uploaded `exam_brief_en.md` + `rubric_en.md` | Created the D1 database `equipment-booking`, wrote v1 (`src/index.ts`, `schema.sql`, `wrangler.jsonc`), and committed it as the pre-30-minute snapshot | Kept the structure: Hono routes, zod validation, parameter-bound SQL |
| 4 | (same session) Quality Gate review of v1 | Smoke-tested v1 with curl, found 6 issues, wrote v2, wrote `scripts/evidence.mjs`, and ran it against v1 (22/28) and v2 (28/28) | Kept all 6 fixes. Each one is written up in `QUALITY_GATE_REVIEW.md` |
| 5 | (same session) Documentation | Drafted `API_CONTRACT.md`, the README with ERD, `QUALITY_GATE_REVIEW.md`, and this log | Reviewed them and rewrote them in my own words where needed |

## AI suggestions I checked critically

- **400 vs 404 for an unknown `equipmentId`:** this could go either way. I kept **400** because the URL is valid and the body value is wrong. The reason is in `API_CONTRACT.md`.
- **The race-condition claim:** the test passed on v1 too, because local D1 handles requests one at a time. I recorded that honestly instead of claiming the test proved the bug.
- **Overlap formula** `existing.start < new.end AND existing.end > new.start`: I checked it by hand with back-to-back times (11:00–12:00 after 09:00–11:00, not an overlap) and with a booking inside another one (overlap).
- **Times stored as strings:** this is only safe because every time is normalised to the same UTC format first. Finding #1 is exactly the bug that happens without that step.

## What I verified myself

- [ ] Ran `npm run db:local && npm run dev`, then `node scripts/evidence.mjs http://localhost:8787/api`, and got 28/28 passing.
- [ ] Deployed with `npm run deploy` and ran the evidence script against the live URL.
- [ ] Ran several curl commands by hand (create, overlap → 409, bad dates → 400, delete → 204).
- [ ] Read `src/index.ts` line by line and can explain:
  - [ ] why the overlap SQL is `start_at < ?end AND end_at > ?start`
  - [ ] why `INSERT … SELECT … WHERE NOT EXISTS` is atomic and a separate SELECT-then-INSERT is not
  - [ ] why `.bind()` prevents SQL injection
  - [ ] why the PATCH schema has no defaults
  - [ ] why times are normalised with `toISOString()`
