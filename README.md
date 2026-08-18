# Campus Parking Zones API

A small REST API that tracks live **parking-zone availability** on campus, built for MFU
*Platform Development (1305308)* Assignment #2. Same domain as my Team 11 group project
(Transport & Parking), reduced to one clean CRUD resource.

**Stack:** Cloudflare Workers · Hono · TypeScript · Cloudflare D1

- **Live API:** https://campus-parking-api.kanthiphs.workers.dev

## Resource — `zones`

| Field | Type | Notes |
|---|---|---|
| `id` | integer | auto |
| `name` | text | e.g. `Zone A - Main Gate` |
| `capacity` | integer | `>= 0` |
| `free` | integer | `>= 0` and `<= capacity` (enforced in app **and** DB) |
| `permit_type` | text | `student` \| `staff` \| `visitor` |
| `created_at` / `updated_at` | text | timestamps |

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/zones` | Create |
| `GET` | `/api/zones` | Read all |
| `GET` | `/api/zones/:id` | Read one |
| `PATCH` | `/api/zones/:id` | Update (partial) |
| `DELETE` | `/api/zones/:id` | Delete |

Status codes: `200/201` ok · `400` bad input · `404` not found · `422` `free > capacity`.

## Run locally

```bash
npm install
npm run db:local        # apply schema.sql to local D1
npm run dev             # http://localhost:8787
```

## Deploy

```bash
npx wrangler login      # one-time browser auth
npx wrangler d1 create campus-parking   # paste database_id into wrangler.jsonc
npm run db:remote       # seed the production D1
npm run deploy
```
