// Runs the test cases against the API and writes EVIDENCE.md (request, expected status, actual result).
// Usage:  node scripts/evidence.mjs [BASE_URL]
//   local:  node scripts/evidence.mjs http://localhost:8787/api
//   live:   node scripts/evidence.mjs https://equipment-booking-api.<you>.workers.dev/api
import { writeFileSync } from 'node:fs'

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8787/api').replace(/\/+$/, '')

// Use a random future day per run so re-runs never collide with old data
const day = new Date(Date.UTC(2030, 0, 1) + Math.floor(Math.random() * 20000) * 86400000).toISOString().slice(0, 10)
const at = (hhmm) => `${day}T${hhmm}:00.000Z`

const cases = []
async function run(name, method, path, body, expected, check) {
  const headers = {}
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const res = await fetch(BASE + path, { method, headers, body: payload })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  let pass = res.status === expected
  let note = ''
  if (pass && check) {
    const r = check(json)
    if (r !== true) { pass = false; note = r }
  }
  // JSON error format: every non-2xx (except 204) must be { "error": "..." }
  if (pass && res.status >= 400 && !(json && typeof json.error === 'string' && Object.keys(json).length === 1)) {
    pass = false; note = 'error body is not { "error": "..." }'
  }
  const curl = [`curl -i -X ${method} "${BASE}${path}"`]
  if (payload !== undefined) curl.push(`-H "Content-Type: application/json"`, `-d '${payload}'`)
  cases.push({ name, method, path, expected, status: res.status, pass, note, curl: curl.join(' \\\n  '), text })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${String(res.status).padEnd(3)} (expected ${expected})  ${name}${note ? '  -- ' + note : ''}`)
  return json
}

const booking = (o = {}) => ({
  equipmentId: 'eq-1',
  borrowerName: 'Somchai Jaidee',
  startAt: at('09:00'),
  endAt: at('11:00'),
  purpose: 'Class presentation',
  ...o,
})

// ----- Happy paths -----
await run('List equipment', 'GET', '/equipment', undefined, 200, (j) =>
  Array.isArray(j) && j.length >= 2 ? true : 'expected at least 2 equipment records')
const a = await run('Create booking', 'POST', '/bookings', booking(), 201, (j) =>
  j && j.id && j.equipmentId === 'eq-1' && j.startAt === at('09:00') ? true : 'unexpected body')
await run('List bookings', 'GET', '/bookings', undefined, 200, (j) =>
  Array.isArray(j) && j.some((b) => b.id === a.id) ? true : 'new booking missing from list')
await run('Get one booking', 'GET', `/bookings/${a.id}`, undefined, 200, (j) =>
  j.borrowerName === 'Somchai Jaidee' ? true : 'wrong booking')
await run('Update booking (partial: purpose only)', 'PATCH', `/bookings/${a.id}`, { purpose: 'Thesis defence' }, 200, (j) =>
  j.purpose === 'Thesis defence' && j.borrowerName === 'Somchai Jaidee' ? true : 'other fields changed')
await run('Update borrowerName only keeps purpose', 'PATCH', `/bookings/${a.id}`, { borrowerName: 'Somchai J.' }, 200, (j) =>
  j.purpose === 'Thesis defence' ? true : `purpose was changed to "${j.purpose}"`)
await run('Back-to-back written without milliseconds (08:00Z-09:00:00Z) is allowed', 'POST', '/bookings',
  booking({ borrowerName: 'Early', startAt: `${day}T08:00:00Z`, endAt: `${day}T09:00:00Z` }), 201)
const b = await run('Create back-to-back booking (11:00-12:00, touching is allowed)', 'POST', '/bookings',
  booking({ borrowerName: 'Suda', startAt: at('11:00'), endAt: at('12:00') }), 201)
await run('Same time on OTHER equipment is allowed', 'POST', '/bookings',
  booking({ equipmentId: 'eq-2', borrowerName: 'Niran' }), 201)

// ----- 409 conflicts -----
await run('Overlapping booking on same equipment -> 409', 'POST', '/bookings',
  booking({ borrowerName: 'Malee', startAt: at('10:00'), endAt: at('10:30') }), 409)
await run('Overlap using +07:00 offset (same instant) -> 409', 'POST', '/bookings',
  booking({ borrowerName: 'Malee', startAt: `${day}T17:30:00+07:00`, endAt: `${day}T18:30:00+07:00` }), 409)
await run('Update that creates an overlap -> 409', 'PATCH', `/bookings/${b.id}`, { startAt: at('10:00') }, 409)

// ----- 400 validation -----
await run('startAt after endAt -> 400', 'POST', '/bookings', booking({ startAt: at('15:00'), endAt: at('14:00') }), 400)
await run('startAt equal to endAt -> 400', 'POST', '/bookings', booking({ startAt: at('15:00'), endAt: at('15:00') }), 400)
await run('Missing required fields -> 400', 'POST', '/bookings', { purpose: 'x' }, 400)
await run('Invalid date format -> 400', 'POST', '/bookings', booking({ startAt: '20/10/2026 09:00' }), 400)
await run('equipmentId does not exist -> 400', 'POST', '/bookings', booking({ equipmentId: 'eq-999', startAt: at('20:00'), endAt: at('21:00') }), 400)
await run('Unknown field -> 400', 'POST', '/bookings', { ...booking({ startAt: at('20:00'), endAt: at('21:00') }), id: 1 }, 400)
await run('Malformed JSON -> 400', 'POST', '/bookings', '{"equipmentId": "eq-1",', 400)
await run('PATCH with empty body -> 400', 'PATCH', `/bookings/${a.id}`, {}, 400)
await run('PATCH making startAt >= endAt -> 400', 'PATCH', `/bookings/${a.id}`, { endAt: at('08:00') }, 400)

// ----- 404 -----
await run('Get booking that does not exist -> 404', 'GET', '/bookings/999999', undefined, 404)
await run('Update booking that does not exist -> 404', 'PATCH', '/bookings/999999', { purpose: 'x' }, 404)
await run('Delete booking that does not exist -> 404', 'DELETE', '/bookings/999999', undefined, 404)

// ----- Security -----
await run('SQL injection text is stored as plain data', 'POST', '/bookings',
  booking({ equipmentId: 'eq-3', borrowerName: "x'); DROP TABLE bookings;--", startAt: at('13:00'), endAt: at('14:00') }), 201,
  (j) => j.borrowerName === "x'); DROP TABLE bookings;--" ? true : 'name changed')

// ----- Race condition: 5 identical requests at the same moment -> exactly one wins -----
const slot = booking({ equipmentId: 'eq-3', borrowerName: 'Racer', startAt: at('16:00'), endAt: at('17:00') })
const results = await Promise.all(
  Array.from({ length: 5 }, () =>
    fetch(`${BASE}/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(slot) })
      .then(async (r) => ({ status: r.status, body: await r.json() })))
)
const statuses = results.map((r) => r.status).sort()
const raceOk = statuses.filter((s) => s === 201).length === 1 && statuses.filter((s) => s === 409).length === 4
cases.push({
  name: '5 simultaneous requests for the same slot -> exactly one 201, four 409',
  method: 'POST', path: '/bookings', expected: '1x201 + 4x409', status: statuses.join(','), pass: raceOk, note: '',
  curl: '(5 parallel POSTs, see scripts/evidence.mjs)', text: JSON.stringify(statuses),
})
console.log(`${raceOk ? 'PASS' : 'FAIL'}  ${statuses.join(',')}  concurrent booking race`)

// ----- Delete (and cleanup) -----
await run('Delete booking -> 204 (no body)', 'DELETE', `/bookings/${a.id}`, undefined, 204)
await run('Get deleted booking -> 404', 'GET', `/bookings/${a.id}`, undefined, 404)
const all = await (await fetch(`${BASE}/bookings`)).json()
for (const x of all.filter((x) => x.startAt.startsWith(day))) await fetch(`${BASE}/bookings/${x.id}`, { method: 'DELETE' })

// ----- Write EVIDENCE.md -----
const passed = cases.filter((c) => c.pass).length
const md = [
  '# Test Evidence',
  '',
  `- **Base API URL:** \`${BASE}\``,
  `- **Run at:** ${new Date().toISOString()}`,
  `- **Result:** ${passed}/${cases.length} cases passed`,
  `- **Generated by:** \`node scripts/evidence.mjs ${BASE}\` (each case shows the equivalent curl command)`,
  '',
  '| # | Case | Expected | Actual | Result |',
  '|---|---|---|---|---|',
  ...cases.map((c, i) => `| ${i + 1} | ${c.name} | ${c.expected} | ${c.status} | ${c.pass ? '✅' : '❌ ' + c.note} |`),
  '',
  '## Details',
  ...cases.flatMap((c, i) => [
    '',
    `### ${i + 1}. ${c.name}`,
    '',
    '```bash',
    c.curl,
    '```',
    '',
    `**Status:** ${c.status} (expected ${c.expected})`,
    '',
    '```json',
    c.text ? (() => { try { return JSON.stringify(JSON.parse(c.text), null, 2) } catch { return c.text } })() : '(no body)',
    '```',
  ]),
  '',
].join('\n')
writeFileSync(new URL('../EVIDENCE.md', import.meta.url), md)
console.log(`\n${passed}/${cases.length} passed -> EVIDENCE.md`)
process.exit(passed === cases.length ? 0 : 1)
