// Runs the instructor's cURL Quick Test Guide (steps 1-9) with the REAL curl program
// and saves the raw `curl -i` output as evidence.
// Works on Windows (uses the built-in curl.exe, so no PowerShell quoting problems) and Linux/macOS.
//
// Usage:  node scripts/curl-guide.mjs [BASE_URL]
//   node scripts/curl-guide.mjs https://equipment-booking-api.kanthiphs.workers.dev/api
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE_URL = (process.argv[2] ?? 'http://localhost:8787/api').replace(/\/+$/, '')
const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl'
const host = new URL(BASE_URL).hostname === 'localhost' ? 'local' : 'live'

const log = []
let passed = 0
let total = 0

function step(no, title, expected, method, path, body) {
  const args = ['-s', '-i', '-X', method, `${BASE_URL}${path}`]
  let shown = `curl -i -X ${method} "${BASE_URL}${path}"`
  if (body) {
    const json = JSON.stringify(body, null, 2)
    args.push('-H', 'Content-Type: application/json', '-d', json)
    shown += ` \\\n  -H "Content-Type: application/json" \\\n  -d '${json.replace(/\n/g, '\n  ')}'`
  }
  const out = execFileSync(CURL, args, { encoding: 'utf8' }).replace(/\r/g, '')
  const status = Number(out.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1])
  const bodyText = out.split('\n\n').slice(1).join('\n\n').trim()
  const ok = status === expected
  total++
  if (ok) passed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${status} (expected ${expected})  ${no}. ${title}`)
  log.push(`## ${no}. ${title} (expect ${expected}) -> ${ok ? 'PASS' : 'FAIL'}`, '', '$ ' + shown, '', out.trim(), '')
  return bodyText
}

console.log(`cURL Quick Test Guide against ${BASE_URL}\n`)
step(1, 'List equipment', 200, 'GET', '/equipment')
step(2, 'List bookings', 200, 'GET', '/bookings')
const created = step(3, 'Create a booking', 201, 'POST', '/bookings', {
  equipmentId: 'eq-1',
  borrowerName: 'Somchai Jaidee',
  startAt: '2026-10-20T09:00:00.000Z',
  endAt: '2026-10-20T11:00:00.000Z',
  purpose: 'Class presentation',
})
let BOOKING_ID = 'missing'
try { BOOKING_ID = String(JSON.parse(created).id) } catch {}
log.push(`BOOKING_ID=${BOOKING_ID}`, '')
step(4, 'Get one booking', 200, 'GET', `/bookings/${BOOKING_ID}`)
step(5, 'Update a booking', 200, 'PATCH', `/bookings/${BOOKING_ID}`, {
  equipmentId: 'eq-1',
  borrowerName: 'Somchai Jaidee',
  startAt: '2026-10-20T12:00:00.000Z',
  endAt: '2026-10-20T14:00:00.000Z',
  purpose: 'Updated class presentation',
})
step(6, 'Invalid time range', 400, 'POST', '/bookings', {
  equipmentId: 'eq-1',
  borrowerName: 'Somchai Jaidee',
  startAt: '2026-10-21T11:00:00.000Z',
  endAt: '2026-10-21T09:00:00.000Z',
  purpose: 'Invalid time range test',
})
step(7, 'Overlapping booking', 409, 'POST', '/bookings', {
  equipmentId: 'eq-1',
  borrowerName: 'Suda Dee',
  startAt: '2026-10-20T12:30:00.000Z',
  endAt: '2026-10-20T13:30:00.000Z',
  purpose: 'Conflict test',
})
step(8, 'Missing booking', 404, 'GET', '/bookings/not-found')
step(9, 'Delete a booking', 204, 'DELETE', `/bookings/${BOOKING_ID}`)

const file = `evidence/curl-guide-${host}.txt`
mkdirSync('evidence', { recursive: true })
writeFileSync(
  file,
  [`# cURL Quick Test Guide: raw curl -i output`, `# Base URL: ${BASE_URL}`, `# Run at: ${new Date().toISOString()}`,
   `# Result: ${passed}/${total} steps returned the expected status`, '', ...log].join('\n') + '\n'
)
console.log(`\n${passed}/${total} passed -> ${file}`)
process.exit(passed === total ? 0 : 1)
