import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

type Bindings = { DB: D1Database }

// root serves "/", app serves everything under "/api" (they share one router)
const root = new Hono<{ Bindings: Bindings }>({ strict: false }) // "/api/" == "/api"
const app = root.basePath('/api')

// Only needed for a browser-based client; curl ignores CORS
app.use('/*', cors())

// ---------- Validation ----------

// Accept ISO 8601 with "Z" or an offset (e.g. +07:00), then store as one UTC format
// (2026-10-20T09:00:00.000Z) so string comparison in SQL equals time comparison.
const required = (iss: { input?: unknown }) => (iss.input === undefined ? 'is required' : undefined)
const isoDateTime = z.iso
  .datetime({
    offset: true,
    error: (iss) => required(iss) ?? 'must be an ISO 8601 date-time, e.g. 2026-10-20T09:00:00.000Z',
  })
  .transform((s) => new Date(s).toISOString())

const fields = {
  equipmentId: z.string({ error: required }).trim().min(1, 'is required'),
  borrowerName: z.string({ error: required }).trim().min(1, 'is required').max(100),
  startAt: isoDateTime,
  endAt: isoDateTime,
  purpose: z.string().trim().max(500),
}

// strictObject: unknown fields (e.g. "id") -> 400 instead of being silently ignored
const createSchema = z.strictObject({ ...fields, purpose: fields.purpose.default('') })
// PATCH: every field optional and NO defaults (a default would overwrite stored data)
const patchSchema = z
  .strictObject(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update')

// Every validation failure -> 400 { "error": "<field>: <problem>; ..." }
const validateJson = <T extends z.ZodType>(schema: T) =>
  zValidator('json', schema, (result, c) => {
    if (!result.success) {
      const msg = result.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ')
      return c.json({ error: msg }, 400)
    }
  })

// ---------- Helpers ----------
interface Booking {
  id: number
  equipmentId: string
  borrowerName: string
  startAt: string
  endAt: string
  purpose: string
  createdAt: string
  updatedAt: string
}

// API field names (camelCase) <- DB column names (snake_case)
const SELECT_BOOKING = `SELECT id, equipment_id AS equipmentId, borrower_name AS borrowerName,
  start_at AS startAt, end_at AS endAt, purpose, created_at AS createdAt, updated_at AS updatedAt
  FROM bookings`

// Two bookings overlap when existing.start < new.end AND existing.end > new.start.
// Touching ends (10:00-11:00 then 11:00-12:00) do NOT overlap.
const OVERLAP = `SELECT 1 FROM bookings o
  WHERE o.equipment_id = ?1 AND o.start_at < ?3 AND o.end_at > ?2 AND o.id IS NOT ?4`

const bookingNotFound = (c: Context) => c.json({ error: 'Booking not found' }, 404)
const parseId = (raw: string) => (/^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null)

async function equipmentExists(db: D1Database, id: string) {
  return (await db.prepare('SELECT 1 FROM equipment WHERE id = ?').bind(id).first()) !== null
}

// After an INSERT/UPDATE guarded by the checks below wrote nothing, explain why
async function rejectReason(c: Context<{ Bindings: Bindings }>, equipmentId: string) {
  if (!(await equipmentExists(c.env.DB, equipmentId))) {
    return c.json({ error: `equipmentId '${equipmentId}' does not exist` }, 400)
  }
  return c.json({ error: 'This equipment is already booked for an overlapping time' }, 409)
}

// ---------- Index: so opening the Base URL in a browser shows what the API offers ----------
const index = (c: Context) =>
  c.json({
    name: 'Campus Equipment Booking API',
    status: 'ok',
    baseUrl: '/api',
    endpoints: [
      'GET    /api/equipment',
      'GET    /api/bookings?equipmentId=',
      'GET    /api/bookings/:id',
      'POST   /api/bookings',
      'PATCH  /api/bookings/:id',
      'DELETE /api/bookings/:id',
    ],
  })
root.get('/', index)
app.get('/', index)

// ---------- Equipment ----------
app.get('/equipment', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, location FROM equipment ORDER BY id').all()
  return c.json(results)
})

// ---------- Bookings ----------
app.get('/bookings', async (c) => {
  const equipmentId = c.req.query('equipmentId')
  const stmt = equipmentId
    ? c.env.DB.prepare(`${SELECT_BOOKING} WHERE equipment_id = ? ORDER BY start_at`).bind(equipmentId)
    : c.env.DB.prepare(`${SELECT_BOOKING} ORDER BY start_at`)
  const { results } = await stmt.all<Booking>()
  return c.json(results)
})

app.get('/bookings/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return bookingNotFound(c)
  const row = await c.env.DB.prepare(`${SELECT_BOOKING} WHERE id = ?`).bind(id).first<Booking>()
  if (!row) return bookingNotFound(c)
  return c.json(row)
})

app.post('/bookings', validateJson(createSchema), async (c) => {
  const b = c.req.valid('json')
  if (b.startAt >= b.endAt) return c.json({ error: 'startAt must be before endAt' }, 400)

  // One atomic statement: insert ONLY IF the equipment exists AND no overlap exists.
  // (A separate SELECT-then-INSERT lets two simultaneous requests both pass the check.)
  const created = await c.env.DB.prepare(
    `INSERT INTO bookings (equipment_id, borrower_name, start_at, end_at, purpose)
     SELECT ?1, ?5, ?2, ?3, ?6
     WHERE EXISTS (SELECT 1 FROM equipment WHERE id = ?1)
       AND NOT EXISTS (${OVERLAP})
     RETURNING id`
  )
    .bind(b.equipmentId, b.startAt, b.endAt, null, b.borrowerName, b.purpose)
    .first<{ id: number }>()
  if (!created) return rejectReason(c, b.equipmentId)

  const row = await c.env.DB.prepare(`${SELECT_BOOKING} WHERE id = ?`).bind(created.id).first<Booking>()
  c.header('Location', `/api/bookings/${created.id}`)
  return c.json(row, 201)
})

app.patch('/bookings/:id', validateJson(patchSchema), async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return bookingNotFound(c)
  const cur = await c.env.DB.prepare(`${SELECT_BOOKING} WHERE id = ?`).bind(id).first<Booking>()
  if (!cur) return bookingNotFound(c)

  // Merge: fields not sent keep their current value
  const next = { ...cur, ...c.req.valid('json') }
  if (next.startAt >= next.endAt) return c.json({ error: 'startAt must be before endAt' }, 400)

  // Same atomic guard as POST, excluding this booking itself from the overlap check (?4)
  const updated = await c.env.DB.prepare(
    `UPDATE bookings
        SET equipment_id = ?1, start_at = ?2, end_at = ?3, borrower_name = ?5, purpose = ?6,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?4
        AND EXISTS (SELECT 1 FROM equipment WHERE id = ?1)
        AND NOT EXISTS (${OVERLAP})
      RETURNING id`
  )
    .bind(next.equipmentId, next.startAt, next.endAt, id, next.borrowerName, next.purpose)
    .first<{ id: number }>()
  if (!updated) {
    // deleted by someone else in the meantime?
    const still = await c.env.DB.prepare('SELECT 1 FROM bookings WHERE id = ?').bind(id).first()
    if (!still) return bookingNotFound(c)
    return rejectReason(c, next.equipmentId)
  }

  const row = await c.env.DB.prepare(`${SELECT_BOOKING} WHERE id = ?`).bind(id).first<Booking>()
  return c.json(row)
})

app.delete('/bookings/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return bookingNotFound(c)
  const { meta } = await c.env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(id).run()
  if (meta.changes === 0) return bookingNotFound(c)
  return c.body(null, 204)
})

// ---------- Fallbacks: every error is JSON { "error": "..." } ----------
root.notFound((c) => c.json({ error: `Route not found: ${c.req.method} ${c.req.path}` }, 404))

root.onError((err, c) => {
  // e.g. malformed JSON body -> Hono throws HTTPException(400)
  if (err instanceof HTTPException) {
    return c.json({ error: err.status === 400 ? 'Request body is not valid JSON' : err.message }, err.status)
  }
  // DB constraint as a last line of defence (should already be caught above)
  if (String(err?.message).includes('CHECK constraint failed')) {
    return c.json({ error: 'startAt must be before endAt' }, 400)
  }
  console.error(err) // details stay in the server log, never in the response
  return c.json({ error: 'Internal server error' }, 500)
})

export default root
