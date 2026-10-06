import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

// D1 binding + vars declared in wrangler.jsonc
type Bindings = {
  DB: D1Database
  CORS_ORIGINS?: string // comma-separated allowlist, or "*" for any origin
}

const app = new Hono<{ Bindings: Bindings }>()

// ---------- Middleware ----------

// CORS: only origins in CORS_ORIGINS may call the API from a browser.
// Origin is decided per request so the list can change without a code edit.
app.use('/*', async (c, next) => {
  const allowed = (c.env.CORS_ORIGINS ?? '*').split(',').map((o) => o.trim())
  return cors({
    origin: (origin) => (allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 600,
  })(c, next)
})

// Basic hardening headers (X-Content-Type-Options, X-Frame-Options, ...)
app.use('/*', secureHeaders())

// Reject oversized bodies before parsing them -> 413
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 10 * 1024,
    onError: (c) => c.json({ error: 'Request body too large (max 10 KB)' }, 413),
  })
)

// Writes must send JSON -> 415 otherwise
app.use('/api/*', async (c, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(c.req.method)) {
    const type = c.req.header('content-type') ?? ''
    if (!type.toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 415)
    }
  }
  await next()
})

// ---------- Validation schemas ----------
const PERMITS = ['student', 'staff', 'visitor'] as const

// strictObject: unknown keys (e.g. "id", "created_at", "is_admin") -> 400, not silently ignored
const createSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  capacity: z.number().int().min(0).max(10_000),
  free: z.number().int().min(0).max(10_000),
  permit_type: z.enum(PERMITS).default('student'),
})

const patchSchema = createSchema
  .partial()
  .extend({ permit_type: z.enum(PERMITS).optional() }) // no default on PATCH
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' })

const idSchema = z.object({
  id: z.string().regex(/^[1-9]\d{0,9}$/, 'id must be a positive integer').transform(Number),
})

const listQuerySchema = z.object({
  permit_type: z.enum(PERMITS).optional(),
  available: z.enum(['true', 'false']).optional(), // true -> free > 0
  q: z.string().trim().min(1).max(80).optional(), // name contains
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

// One place that turns any validation failure into a 400 with readable details
const validate = <T extends z.ZodType, Target extends 'json' | 'param' | 'query'>(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ field: i.path.join('.') || target, message: i.message }))
      return c.json({ error: 'Validation failed', details }, 400)
    }
  })

interface Zone {
  id: number
  name: string
  capacity: number
  free: number
  permit_type: string
  created_at: string
  updated_at: string
}

const notFound = (c: Context, id: number) => c.json({ error: 'Zone not found', id }, 404)
const freeTooHigh = (c: Context, capacity: number, free: number) =>
  c.json({ error: 'free must be <= capacity', capacity, free }, 422)

// ---------- Health / info ----------
app.get('/', (c) =>
  c.json({
    name: 'Campus Parking Zones API',
    status: 'ok',
    resource: 'zones',
    endpoints: [
      'POST   /api/zones',
      'GET    /api/zones?permit_type=&available=&q=&limit=&offset=',
      'GET    /api/zones/:id',
      'PATCH  /api/zones/:id',
      'DELETE /api/zones/:id',
    ],
  })
)

// ---------- CREATE ----------
app.post('/api/zones', validate('json', createSchema), async (c) => {
  const b = c.req.valid('json')
  if (b.free > b.capacity) return freeTooHigh(c, b.capacity, b.free)

  // Parameter binding: values travel separately from the SQL text -> no SQL injection
  const row = await c.env.DB.prepare(
    `INSERT INTO zones (name, capacity, free, permit_type)
     VALUES (?, ?, ?, ?) RETURNING *`
  )
    .bind(b.name, b.capacity, b.free, b.permit_type)
    .first<Zone>()
  c.header('Location', `/api/zones/${row!.id}`)
  return c.json(row, 201)
})

// ---------- READ ALL (filter + paginate) ----------
app.get('/api/zones', validate('query', listQuerySchema), async (c) => {
  const q = c.req.valid('query')

  // Build WHERE from fixed SQL fragments only; user values go through bind()
  const where: string[] = []
  const params: (string | number)[] = []
  if (q.permit_type) {
    where.push('permit_type = ?')
    params.push(q.permit_type)
  }
  if (q.available) where.push(q.available === 'true' ? 'free > 0' : 'free = 0')
  if (q.q) {
    where.push("name LIKE ? ESCAPE '\\'")
    params.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { results } = await c.env.DB.prepare(`SELECT * FROM zones ${whereSql} ORDER BY id LIMIT ? OFFSET ?`)
    .bind(...params, q.limit, q.offset)
    .all<Zone>()
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM zones ${whereSql}`)
    .bind(...params)
    .first<number>('n')

  return c.json({ count: results.length, total, limit: q.limit, offset: q.offset, data: results })
})

// ---------- READ ONE ----------
app.get('/api/zones/:id', validate('param', idSchema), async (c) => {
  const { id } = c.req.valid('param')
  const row = await c.env.DB.prepare('SELECT * FROM zones WHERE id = ?').bind(id).first<Zone>()
  if (!row) return notFound(c, id)
  return c.json(row)
})

// ---------- UPDATE (partial) ----------
app.patch('/api/zones/:id', validate('param', idSchema), validate('json', patchSchema), async (c) => {
  const { id } = c.req.valid('param')
  const b = c.req.valid('json')

  const cur = await c.env.DB.prepare('SELECT * FROM zones WHERE id = ?').bind(id).first<Zone>()
  if (!cur) return notFound(c, id)

  const next = {
    name: b.name ?? cur.name,
    capacity: b.capacity ?? cur.capacity,
    free: b.free ?? cur.free,
    permit_type: b.permit_type ?? cur.permit_type,
  }
  if (next.free > next.capacity) return freeTooHigh(c, next.capacity, next.free)

  const row = await c.env.DB.prepare(
    `UPDATE zones
       SET name = ?, capacity = ?, free = ?, permit_type = ?, updated_at = datetime('now')
     WHERE id = ? RETURNING *`
  )
    .bind(next.name, next.capacity, next.free, next.permit_type, id)
    .first<Zone>()
  if (!row) return notFound(c, id) // deleted between SELECT and UPDATE
  return c.json(row)
})

// ---------- DELETE ----------
app.delete('/api/zones/:id', validate('param', idSchema), async (c) => {
  const { id } = c.req.valid('param')
  const row = await c.env.DB.prepare('DELETE FROM zones WHERE id = ? RETURNING id').bind(id).first()
  if (!row) return notFound(c, id)
  return c.json({ deleted: true, id })
})

// ---------- Fallbacks ----------

// Known path, unsupported method -> 405 (not 404)
const methodNotAllowed = (allow: string) => (c: Context) => {
  c.header('Allow', allow)
  return c.json({ error: `Method ${c.req.method} not allowed`, allow }, 405)
}
app.all('/api/zones', methodNotAllowed('GET, POST'))
app.all('/api/zones/:id', methodNotAllowed('GET, PATCH, DELETE'))

app.notFound((c) => c.json({ error: 'Route not found' }, 404))

app.onError((err, c) => {
  // Framework errors carry their own status (e.g. malformed JSON body -> 400)
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || 'Bad request' }, err.status)
  }
  // DB constraints are the last line of defence; map them to client errors
  const msg = String(err?.message ?? '')
  if (msg.includes('UNIQUE constraint failed')) return c.json({ error: 'A zone with this name already exists' }, 409)
  if (msg.includes('CHECK constraint failed')) return c.json({ error: 'Value violates a data rule' }, 422)
  // Never leak stack traces / SQL to the client; log them server-side instead
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
