import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

type Bindings = { DB: D1Database }

const app = new Hono<{ Bindings: Bindings }>().basePath('/api')

app.use('/*', cors())

// ---------- Validation ----------
const bookingSchema = z.object({
  equipmentId: z.string().min(1),
  borrowerName: z.string().trim().min(1).max(100),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  purpose: z.string().max(500).default(''),
})
const patchSchema = bookingSchema.partial()

const onInvalid = (result: { success: boolean; error?: z.ZodError }, c: any) => {
  if (!result.success) return c.json({ error: result.error!.issues[0].message }, 400)
}

// API field names (camelCase) <- DB column names (snake_case)
const SELECT_BOOKING = `SELECT id, equipment_id AS equipmentId, borrower_name AS borrowerName,
  start_at AS startAt, end_at AS endAt, purpose, created_at AS createdAt, updated_at AS updatedAt
  FROM bookings`

// ---------- Equipment ----------
app.get('/equipment', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, location FROM equipment ORDER BY id').all()
  return c.json(results)
})

// ---------- Bookings ----------
app.get('/bookings', async (c) => {
  const { results } = await c.env.DB.prepare(`${SELECT_BOOKING} ORDER BY start_at`).all()
  return c.json(results)
})

app.get('/bookings/:id', async (c) => {
  const row = await c.env.DB.prepare(`${SELECT_BOOKING} WHERE id = ?`).bind(c.req.param('id')).first()
  if (!row) return c.json({ error: 'Booking not found' }, 404)
  return c.json(row)
})

app.post('/bookings', zValidator('json', bookingSchema, onInvalid), async (c) => {
  const b = c.req.valid('json')
  if (b.startAt >= b.endAt) return c.json({ error: 'startAt must be before endAt' }, 400)

  const eq = await c.env.DB.prepare('SELECT id FROM equipment WHERE id = ?').bind(b.equipmentId).first()
  if (!eq) return c.json({ error: 'equipmentId does not exist' }, 400)

  const clash = await c.env.DB.prepare(
    'SELECT id FROM bookings WHERE equipment_id = ? AND start_at < ? AND end_at > ?'
  )
    .bind(b.equipmentId, b.endAt, b.startAt)
    .first()
  if (clash) return c.json({ error: 'Booking overlaps an existing booking' }, 409)

  const { meta } = await c.env.DB.prepare(
    'INSERT INTO bookings (equipment_id, borrower_name, start_at, end_at, purpose) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(b.equipmentId, b.borrowerName, b.startAt, b.endAt, b.purpose)
    .run()
  const row = await c.env.DB.prepare(`${SELECT_BOOKING} WHERE id = ?`).bind(meta.last_row_id).first()
  return c.json(row, 201)
})

app.patch('/bookings/:id', zValidator('json', patchSchema, onInvalid), async (c) => {
  const id = c.req.param('id')
  const b = c.req.valid('json')
  const cur = await c.env.DB.prepare(`${SELECT_BOOKING} WHERE id = ?`).bind(id).first<any>()
  if (!cur) return c.json({ error: 'Booking not found' }, 404)

  const next = { ...cur, ...b }
  if (next.startAt >= next.endAt) return c.json({ error: 'startAt must be before endAt' }, 400)

  const eq = await c.env.DB.prepare('SELECT id FROM equipment WHERE id = ?').bind(next.equipmentId).first()
  if (!eq) return c.json({ error: 'equipmentId does not exist' }, 400)

  const clash = await c.env.DB.prepare(
    'SELECT id FROM bookings WHERE equipment_id = ? AND start_at < ? AND end_at > ? AND id != ?'
  )
    .bind(next.equipmentId, next.endAt, next.startAt, id)
    .first()
  if (clash) return c.json({ error: 'Booking overlaps an existing booking' }, 409)

  await c.env.DB.prepare(
    `UPDATE bookings SET equipment_id = ?, borrower_name = ?, start_at = ?, end_at = ?, purpose = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
  )
    .bind(next.equipmentId, next.borrowerName, next.startAt, next.endAt, next.purpose, id)
    .run()
  const row = await c.env.DB.prepare(`${SELECT_BOOKING} WHERE id = ?`).bind(id).first()
  return c.json(row)
})

app.delete('/bookings/:id', async (c) => {
  const { meta } = await c.env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(c.req.param('id')).run()
  if (meta.changes === 0) return c.json({ error: 'Booking not found' }, 404)
  return c.body(null, 204)
})

app.notFound((c) => c.json({ error: 'Route not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
