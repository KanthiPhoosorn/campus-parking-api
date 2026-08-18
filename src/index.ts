import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

// D1 binding declared in wrangler.jsonc ("DB")
type Bindings = { DB: D1Database }

const app = new Hono<{ Bindings: Bindings }>()

// Allow browser calls (so the live JSON opens directly in a tab for screenshots)
app.use('/*', cors())

// ---------- Validation schemas ----------
const PERMITS = ['student', 'staff', 'visitor'] as const

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  capacity: z.number().int().min(0),
  free: z.number().int().min(0),
  permit_type: z.enum(PERMITS).default('student'),
})

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    capacity: z.number().int().min(0).optional(),
    free: z.number().int().min(0).optional(),
    permit_type: z.enum(PERMITS).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' })

// Return 400 (not 500) whenever a body fails validation
const onInvalid = (result: { success: boolean; error?: z.ZodError }, c: any) => {
  if (!result.success) {
    return c.json({ error: 'Validation failed', issues: result.error!.issues }, 400)
  }
}

// Numeric id guard
function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

interface Zone {
  id: number
  name: string
  capacity: number
  free: number
  permit_type: string
  created_at: string
  updated_at: string
}

// ---------- Health / info ----------
app.get('/', (c) =>
  c.json({
    name: 'Campus Parking Zones API',
    status: 'ok',
    resource: 'zones',
    endpoints: [
      'POST   /api/zones',
      'GET    /api/zones',
      'GET    /api/zones/:id',
      'PATCH  /api/zones/:id',
      'DELETE /api/zones/:id',
    ],
  })
)

// ---------- CREATE ----------
app.post('/api/zones', zValidator('json', createSchema, onInvalid), async (c) => {
  const b = c.req.valid('json')
  if (b.free > b.capacity) {
    return c.json({ error: 'free must be ≤ capacity', capacity: b.capacity, free: b.free }, 422)
  }
  const row = await c.env.DB.prepare(
    `INSERT INTO zones (name, capacity, free, permit_type)
     VALUES (?, ?, ?, ?) RETURNING *`
  )
    .bind(b.name, b.capacity, b.free, b.permit_type)
    .first<Zone>()
  return c.json(row, 201)
})

// ---------- READ ALL ----------
app.get('/api/zones', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM zones ORDER BY id').all<Zone>()
  return c.json({ count: results.length, data: results })
})

// ---------- READ ONE ----------
app.get('/api/zones/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'id must be a positive integer' }, 400)
  const row = await c.env.DB.prepare('SELECT * FROM zones WHERE id = ?').bind(id).first<Zone>()
  if (!row) return c.json({ error: 'Zone not found', id }, 404)
  return c.json(row)
})

// ---------- UPDATE (partial) ----------
app.patch('/api/zones/:id', zValidator('json', patchSchema, onInvalid), async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'id must be a positive integer' }, 400)
  const b = c.req.valid('json')

  const cur = await c.env.DB.prepare('SELECT * FROM zones WHERE id = ?').bind(id).first<Zone>()
  if (!cur) return c.json({ error: 'Zone not found', id }, 404)

  const next = {
    name: b.name ?? cur.name,
    capacity: b.capacity ?? cur.capacity,
    free: b.free ?? cur.free,
    permit_type: b.permit_type ?? cur.permit_type,
  }
  if (next.free > next.capacity) {
    return c.json({ error: 'free must be ≤ capacity', capacity: next.capacity, free: next.free }, 422)
  }

  const row = await c.env.DB.prepare(
    `UPDATE zones
       SET name = ?, capacity = ?, free = ?, permit_type = ?, updated_at = datetime('now')
     WHERE id = ? RETURNING *`
  )
    .bind(next.name, next.capacity, next.free, next.permit_type, id)
    .first<Zone>()
  return c.json(row)
})

// ---------- DELETE ----------
app.delete('/api/zones/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'id must be a positive integer' }, 400)
  const row = await c.env.DB.prepare('DELETE FROM zones WHERE id = ? RETURNING id').bind(id).first()
  if (!row) return c.json({ error: 'Zone not found', id }, 404)
  return c.json({ deleted: true, id })
})

// ---------- Fallbacks ----------
app.notFound((c) => c.json({ error: 'Route not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
