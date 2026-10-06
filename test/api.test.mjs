// API tests — success AND error cases. Zero dependencies (node:test + fetch).
// Run the server first (npm run db:local && npm run dev), then: npm test
// Against another server: BASE_URL=https://... npm test
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

const BASE = process.env.BASE_URL ?? 'http://localhost:8787'
const ZONES = `${BASE}/api/zones`
const unique = () => `Test Zone ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

async function call(method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers['content-type'] ??= 'application/json'
  }
  const res = await fetch(url, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, headers: res.headers, json }
}

const createZone = (overrides = {}) =>
  call('POST', ZONES, { name: unique(), capacity: 50, free: 10, permit_type: 'staff', ...overrides })

describe('health', () => {
  test('GET / -> 200 ok', async () => {
    const r = await call('GET', `${BASE}/`)
    assert.equal(r.status, 200)
    assert.equal(r.json.status, 'ok')
  })
})

describe('CREATE  POST /api/zones', () => {
  test('valid body -> 201 + Location + created row', async () => {
    const name = unique()
    const r = await createZone({ name })
    assert.equal(r.status, 201)
    assert.equal(r.json.name, name)
    assert.equal(r.json.free, 10)
    assert.ok(Number.isInteger(r.json.id))
    assert.equal(r.headers.get('location'), `/api/zones/${r.json.id}`)
  })

  test('permit_type defaults to student', async () => {
    const r = await call('POST', ZONES, { name: unique(), capacity: 5, free: 5 })
    assert.equal(r.status, 201)
    assert.equal(r.json.permit_type, 'student')
  })

  test('missing required fields -> 400 with details', async () => {
    const r = await call('POST', ZONES, {})
    assert.equal(r.status, 400)
    const fields = r.json.details.map((d) => d.field)
    assert.deepEqual(fields.sort(), ['capacity', 'free', 'name'])
  })

  test('wrong types -> 400', async () => {
    const r = await call('POST', ZONES, { name: unique(), capacity: '10', free: 1.5 })
    assert.equal(r.status, 400)
  })

  test('negative numbers -> 400', async () => {
    const r = await createZone({ capacity: -1 })
    assert.equal(r.status, 400)
  })

  test('blank name (whitespace only) -> 400', async () => {
    const r = await createZone({ name: '   ' })
    assert.equal(r.status, 400)
  })

  test('invalid enum -> 400', async () => {
    const r = await createZone({ permit_type: 'vip' })
    assert.equal(r.status, 400)
  })

  test('unknown field (mass assignment) -> 400', async () => {
    const r = await createZone({ id: 999, is_admin: true })
    assert.equal(r.status, 400)
  })

  test('free > capacity -> 422', async () => {
    const r = await createZone({ capacity: 5, free: 6 })
    assert.equal(r.status, 422)
  })

  test('duplicate name (case-insensitive) -> 409', async () => {
    const name = unique()
    assert.equal((await createZone({ name })).status, 201)
    const r = await createZone({ name: name.toUpperCase() })
    assert.equal(r.status, 409)
  })

  test('malformed JSON -> 400 (not 500)', async () => {
    const r = await call('POST', ZONES, '{"name": oops', { 'content-type': 'application/json' })
    assert.equal(r.status, 400)
  })

  test('wrong Content-Type -> 415', async () => {
    const r = await call('POST', ZONES, 'name=x', { 'content-type': 'text/plain' })
    assert.equal(r.status, 415)
  })

  test('body over 10 KB -> 413', async () => {
    const r = await createZone({ name: 'x'.repeat(20_000) })
    assert.equal(r.status, 413)
  })

  test('SQL injection text is stored as plain data', async () => {
    const name = `x'); DROP TABLE zones;-- ${unique()}`
    const r = await createZone({ name })
    assert.equal(r.status, 201)
    assert.equal(r.json.name, name)
    assert.equal((await call('GET', ZONES)).status, 200) // table still exists
  })
})

describe('READ  GET /api/zones', () => {
  before(async () => {
    await createZone({ permit_type: 'visitor', free: 0 })
  })

  test('list -> 200 with data array + paging info', async () => {
    const r = await call('GET', ZONES)
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.json.data))
    assert.equal(r.json.count, r.json.data.length)
    assert.ok(r.json.total >= r.json.count)
  })

  test('filter by permit_type', async () => {
    const r = await call('GET', `${ZONES}?permit_type=visitor`)
    assert.equal(r.status, 200)
    assert.ok(r.json.data.length > 0)
    assert.ok(r.json.data.every((z) => z.permit_type === 'visitor'))
  })

  test('filter available=false -> only full zones', async () => {
    const r = await call('GET', `${ZONES}?available=false`)
    assert.equal(r.status, 200)
    assert.ok(r.json.data.every((z) => z.free === 0))
  })

  test('limit is respected', async () => {
    const r = await call('GET', `${ZONES}?limit=1`)
    assert.equal(r.status, 200)
    assert.equal(r.json.data.length, 1)
  })

  test('search q with SQL wildcard is literal', async () => {
    const r = await call('GET', `${ZONES}?q=${encodeURIComponent('%')}`)
    assert.equal(r.status, 200)
    assert.ok(r.json.data.every((z) => z.name.includes('%')))
  })

  test('invalid query params -> 400', async () => {
    for (const qs of ['permit_type=vip', 'limit=0', 'limit=1000', 'offset=-1', 'available=yes']) {
      const r = await call('GET', `${ZONES}?${qs}`)
      assert.equal(r.status, 400, qs)
    }
  })

  test('GET one -> 200', async () => {
    const { json: created } = await createZone()
    const r = await call('GET', `${ZONES}/${created.id}`)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, created)
  })

  test('GET one that does not exist -> 404', async () => {
    const r = await call('GET', `${ZONES}/999999`)
    assert.equal(r.status, 404)
  })

  test('GET one with invalid id -> 400', async () => {
    for (const id of ['abc', '0', '-1', '1.5', '1%20OR%201=1']) {
      const r = await call('GET', `${ZONES}/${id}`)
      assert.equal(r.status, 400, id)
    }
  })
})

describe('UPDATE  PATCH /api/zones/:id', () => {
  test('partial update -> 200, other fields unchanged', async () => {
    const { json: z } = await createZone()
    const r = await call('PATCH', `${ZONES}/${z.id}`, { free: 3 })
    assert.equal(r.status, 200)
    assert.equal(r.json.free, 3)
    assert.equal(r.json.name, z.name)
    assert.equal(r.json.permit_type, z.permit_type)
  })

  test('empty body -> 400', async () => {
    const { json: z } = await createZone()
    const r = await call('PATCH', `${ZONES}/${z.id}`, {})
    assert.equal(r.status, 400)
  })

  test('unknown field -> 400', async () => {
    const { json: z } = await createZone()
    const r = await call('PATCH', `${ZONES}/${z.id}`, { created_at: '2000-01-01' })
    assert.equal(r.status, 400)
  })

  test('free above current capacity -> 422', async () => {
    const { json: z } = await createZone({ capacity: 10, free: 5 })
    const r = await call('PATCH', `${ZONES}/${z.id}`, { free: 11 })
    assert.equal(r.status, 422)
  })

  test('capacity below current free -> 422', async () => {
    const { json: z } = await createZone({ capacity: 10, free: 5 })
    const r = await call('PATCH', `${ZONES}/${z.id}`, { capacity: 4 })
    assert.equal(r.status, 422)
  })

  test('rename to an existing name -> 409', async () => {
    const { json: a } = await createZone()
    const { json: b } = await createZone()
    const r = await call('PATCH', `${ZONES}/${b.id}`, { name: a.name })
    assert.equal(r.status, 409)
  })

  test('not found -> 404', async () => {
    const r = await call('PATCH', `${ZONES}/999999`, { free: 1 })
    assert.equal(r.status, 404)
  })

  test('invalid id -> 400', async () => {
    const r = await call('PATCH', `${ZONES}/abc`, { free: 1 })
    assert.equal(r.status, 400)
  })
})

describe('DELETE  /api/zones/:id', () => {
  test('delete -> 200, then GET -> 404, second delete -> 404', async () => {
    const { json: z } = await createZone()
    const r = await call('DELETE', `${ZONES}/${z.id}`)
    assert.equal(r.status, 200)
    assert.equal(r.json.deleted, true)
    assert.equal((await call('GET', `${ZONES}/${z.id}`)).status, 404)
    assert.equal((await call('DELETE', `${ZONES}/${z.id}`)).status, 404)
  })

  test('invalid id -> 400', async () => {
    const r = await call('DELETE', `${ZONES}/abc`)
    assert.equal(r.status, 400)
  })
})

describe('routing, CORS, security headers', () => {
  test('unknown route -> 404 JSON', async () => {
    const r = await call('GET', `${BASE}/api/nope`)
    assert.equal(r.status, 404)
    assert.ok(r.json.error)
  })

  test('unsupported method -> 405 + Allow header', async () => {
    const r = await call('PUT', `${ZONES}/1`, { free: 1 })
    assert.equal(r.status, 405)
    assert.match(r.headers.get('allow'), /PATCH/)
  })

  test('preflight from allowed origin -> CORS headers', async () => {
    const res = await fetch(ZONES, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5500', 'Access-Control-Request-Method': 'POST' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5500')
    assert.match(res.headers.get('access-control-allow-methods'), /PATCH/)
  })

  test('request from unknown origin gets no CORS allow header', async () => {
    const res = await fetch(ZONES, { headers: { Origin: 'https://evil.example' } })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })

  test('security headers present', async () => {
    const res = await fetch(ZONES)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  })
})
