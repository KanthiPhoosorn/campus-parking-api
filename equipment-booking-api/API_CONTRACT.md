# API Contract: Campus Equipment Booking API

**Base URL:** `{BASE_URL}` = `https://equipment-booking-api.kanthiphs.workers.dev/api` (live) or `http://localhost:8787/api` (local)

All requests and responses are JSON. Every error response has exactly this shape:

```json
{ "error": "A message understandable to a user or developer" }
```

## Endpoints

| Method | Path | Success | Errors | Purpose |
|---|---|---:|---|---|
| `GET` | `/equipment` | 200 | — | List equipment |
| `GET` | `/bookings` | 200 | — | List bookings, sorted by `startAt`. Optional filter: `?equipmentId=eq-1` |
| `GET` | `/bookings/:id` | 200 | 404 | Get one booking |
| `POST` | `/bookings` | 201 + `Location` header | 400, 409 | Create a booking |
| `PATCH` | `/bookings/:id` | 200 | 400, 404, 409 | Partial update: only the fields you send change |
| `DELETE` | `/bookings/:id` | 204 (empty body) | 404 | Delete a booking |
| any | unknown path | — | 404 | `{ "error": "Route not found: ..." }` |

### `GET /equipment` → 200
```json
[
  { "id": "eq-1", "name": "Projector A", "location": "Building 1" },
  { "id": "eq-2", "name": "Camera B", "location": "Building 2" },
  { "id": "eq-3", "name": "Meeting Room 301", "location": "Building 3" }
]
```

### Booking request body (`POST`; `PATCH` takes any non-empty subset)
```json
{
  "equipmentId": "eq-1",
  "borrowerName": "Somchai Jaidee",
  "startAt": "2026-10-20T09:00:00.000Z",
  "endAt": "2026-10-20T11:00:00.000Z",
  "purpose": "Class presentation"
}
```

| Field | Type | Rules |
|---|---|---|
| `equipmentId` | string | required; must be an existing equipment `id` |
| `borrowerName` | string | required; 1–100 characters after trimming |
| `startAt` | string | required; ISO 8601 date-time with `Z` or an offset (`+07:00`) |
| `endAt` | string | required; same format; **must be after `startAt`** |
| `purpose` | string | optional (defaults to `""`); max 500 characters |
| any other field | — | rejected with 400 (clients can't set `id`, `createdAt`, …) |

### Booking response (201 / 200)
```json
{
  "id": 1,
  "equipmentId": "eq-1",
  "borrowerName": "Somchai Jaidee",
  "startAt": "2026-10-20T09:00:00.000Z",
  "endAt": "2026-10-20T11:00:00.000Z",
  "purpose": "Class presentation",
  "createdAt": "2026-10-06T06:30:19.818Z",
  "updatedAt": "2026-10-06T06:30:19.818Z"
}
```
Times are always returned in UTC (`...Z`). For example, `2026-10-20T16:00:00+07:00` is stored and returned as `2026-10-20T09:00:00.000Z`.

## Status codes and why

| Code | When | Why this code |
|---|---|---|
| **400** Bad Request | Missing or invalid field, wrong type, bad date format, `startAt >= endAt`, `equipmentId` doesn't exist, unknown field, malformed JSON, empty PATCH, POST/PATCH without `Content-Type: application/json` | The **request data** is wrong, so the client must fix the body before retrying. A nonexistent `equipmentId` is a 400, not a 404, because the URL (`/bookings`) is valid; it's a value inside the body that's invalid. |
| **404** Not Found | `GET`/`PATCH`/`DELETE /bookings/:id` where the booking doesn't exist (including non-numeric ids such as `abc`); unknown route | The **resource named by the URL** doesn't exist. |
| **409** Conflict | The equipment already has a booking that overlaps the requested time (on create, and on update) | The data is valid, but it **conflicts with the current state** of the server. The same request could succeed later, for example after the other booking is deleted. |
| 500 | Unexpected server error | Generic message only; details are logged on the server, never sent to the client. |

## Business rules and assumptions

1. **Overlap rule:** two bookings for the **same equipment** overlap when `existing.startAt < new.endAt AND existing.endAt > new.startAt`.
   - Back-to-back bookings are **allowed** (09:00–11:00 and 11:00–12:00), because the end time is exclusive.
   - Different equipment at the same time is allowed.
   - On `PATCH`, the booking is not compared with itself.
2. The overlap check and the insert/update happen in **one SQL statement**, so two simultaneous requests can't both book the same slot.
3. Booking ids are auto-increment integers. Equipment ids are strings (`eq-1`), as in the contract.
4. Booking in the past is allowed, and there's no maximum duration (neither is specified in the brief).
5. There is no authentication; the brief doesn't require it. Anyone with the URL can create or delete bookings.
6. Equipment is seeded by `schema.sql` (3 records), and the API makes it read-only.
