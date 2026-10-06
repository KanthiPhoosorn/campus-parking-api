# AI Log

**Tool:** Claude Code (AI coding assistant), used through the Claude app in a cloud session connected to my GitHub repo and my Cloudflare account.

> **Transparency:** the AI assistant compiled this log from the session history at my request ("Before you submit you do it"). The prompts below are what I actually typed. A box under "What I verified myself" is ticked only where the session shows I did that check.

## Important prompts and what I used

| # | My prompt (summary) | What the AI produced | What I used / changed |
|---|---|---|---|
| 1 | Before the test: "Prepare for these" + the list of exam topics | Hardened my earlier parking API, a test suite, and study notes (`PREP.md`) | Used it as revision material, not as exam code |
| 2 | "Use Cloudflare D1, I can't submit by localhost" | Steps for deploying to Workers + D1 | Used the deploy steps in the README |
| 3 | Uploaded `exam_brief_en.md` + `rubric_en.md` | Created the D1 database `equipment-booking`, wrote v1 (`src/index.ts`, `schema.sql`, `wrangler.jsonc`), and committed it as the pre-30-minute snapshot | Kept the structure: Hono routes, zod validation, parameter-bound SQL |
| 4 | (same session) Quality Gate review of v1 | Smoke-tested v1 with curl, found 6 issues, wrote v2, wrote `scripts/evidence.mjs`, and ran it against v1 (22/28) and v2 (28/28) | Kept all 6 fixes. Each one is written up in `QUALITY_GATE_REVIEW.md` |
| 5 | (same session) Documentation | Drafted `API_CONTRACT.md`, the README with ERD, `QUALITY_GATE_REVIEW.md`, and this log | Submitted as part of the work |
| 6 | Pasted my Windows terminal errors (`'git' is not recognized`, `npm ENOENT`) | Explained that Node.js and Git weren't installed and that I was in the wrong folder. Gave install steps, then a way to download the code as a ZIP without Git | Installed Node.js, downloaded the ZIP, deployed with `npm run deploy` |
| 7 | Pasted my live test output (28/28) | Checked the Cloudflare D1 database directly (3 equipment, 6 test bookings created and cleaned up). Saved my output as `evidence/v2-live-run.txt` and linked it in the docs | Live evidence is part of the submission |
| 8 | "Before you submit you do it" | Updated the evidence links and this log | — |

## Points where AI output was questioned rather than accepted

These checks were done in the session by running tests, not taken on trust:

- **400 vs 404 for an unknown `equipmentId`:** this could go either way. **400** was chosen because the URL is valid and the body value is wrong. The reason is in `API_CONTRACT.md`.
- **The race-condition claim:** the concurrency test passed on v1 too, because local D1 handles requests one at a time. That is recorded honestly instead of claiming the test proved the bug.
- **Overlap formula** `existing.start < new.end AND existing.end > new.start`: tested with back-to-back times (allowed, case 8), a booking inside another one (409, case 10), and the same time on other equipment (allowed, case 9).
- **Times stored as strings:** this is only safe because every time is normalised to the same UTC format first. Finding #1 is exactly the bug that happened in v1 without that step.

## What I verified myself

- [ ] Ran `npm run db:local && npm run dev`, then `node scripts/evidence.mjs http://localhost:8787/api`, and got 28/28 passing.
- [x] Deployed with `npm run deploy` on the lab PC and ran the evidence script against the live URL: **28/28 passed** (`evidence/v2-live-run.txt`).
- [ ] Ran several curl commands by hand (create, overlap → 409, bad dates → 400, delete → 204).
- [ ] Read `src/index.ts` line by line and can explain:
  - [ ] why the overlap SQL is `start_at < ?end AND end_at > ?start`
  - [ ] why `INSERT … SELECT … WHERE NOT EXISTS` is atomic and a separate SELECT-then-INSERT is not
  - [ ] why `.bind()` prevents SQL injection
  - [ ] why the PATCH schema has no defaults
  - [ ] why times are normalised with `toISOString()`
