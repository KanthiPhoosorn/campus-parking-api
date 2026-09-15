#!/usr/bin/env bash
# Assignment 5 - collect integration evidence against the DEPLOYED worker.
# Every step prints an ISO-8601 UTC timestamp, the exact request, and the raw
# response, then pulls the matching rows out of the remote D1 database so the
# markdown report can quote real records rather than descriptions.
#
# Usage:  bash scripts/a5-evidence.sh            (writes evidence/a5/*.txt)
# Needs:  curl, python3, wrangler login, .dev.vars with INBOUND_WEBHOOK_SECRET
set -euo pipefail
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1
cd "$(dirname "$0")/.."

BASE="https://campus-parking-integration.kanthiphs.workers.dev"
DB="campus-parking-integration"
OUT="evidence/a5"
mkdir -p "$OUT"
SECRET=$(grep '^INBOUND_WEBHOOK_SECRET=' .dev.vars | cut -d= -f2-)
RUN=$(date -u +%Y%m%dT%H%M%SZ)

ts()  { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
hr()  { printf '\n%s\n%s\n' "== $1" "$(printf '=%.0s' {1..70})"; }
sql() { npx wrangler d1 execute "$DB" --remote --json --command "$1" 2>/dev/null \
        | python -c 'import json,sys
rows=json.load(sys.stdin)[0]["results"]
if not rows: print("(no rows)"); sys.exit()
cols=list(rows[0].keys()); print(" | ".join(cols)); print("-"*80)
for r in rows: print(" | ".join(str(r[c]) if r[c] is not None else "NULL" for c in cols))'; }
# curl wrapper: prints timestamp, request line, status, headers of interest, body
req() { # method url [curl args...]
  local m=$1 u=$2; shift 2
  echo "[$(ts)] $m $u"
  curl -sS -X "$m" "$u" "$@" -D evidence/a5/.headers -o evidence/a5/.body -w 'HTTP %{http_code}  (%{time_total}s)\n'
  grep -iE '^(idempotent-replayed|cf-ray|content-type):' evidence/a5/.headers | tr -d '\r' | sed 's/^/  /'
  python -c 'import json,sys
try: print(json.dumps(json.load(open("evidence/a5/.body")),indent=2,ensure_ascii=False))
except Exception: print(open("evidence/a5/.body").read())'
}

{
echo "A5 evidence run $RUN   worker=$BASE   db=$DB"

# ---------------------------------------------------------------------------
hr "0. Mint a machine credential for the partner team (admin action, demo identity)"
req POST "$BASE/api/admin/api-clients" -H "Authorization: Bearer demo-admin" -H "Content-Type: application/json" \
  -d "{\"name\":\"partner-team-$RUN\",\"scopes\":[\"partner:read\",\"partner:write\"]}"
KEY=${PARTNER_KEY:-$(python -c 'import json;print(json.load(open("evidence/a5/.body"))["api_key"])')}
# never let the raw credential into the committed transcript
sed -i -E 's/("api_key": ")wk_([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+"/wk_…REDACTED"/' "$OUT/.body" 2>/dev/null || true
echo "  (raw key handed to partner out-of-band; server keeps only SHA-256 -> ${KEY:0:7}...redacted)"
sql "SELECT id, name, substr(key_hash,1,12)||'…' AS key_hash, scopes_json, created_at FROM api_clients ORDER BY id DESC LIMIT 1"

# ---------------------------------------------------------------------------
hr "2. PROVIDER PROOF - partner calls OUR endpoint with its credential"
req GET "$BASE/partner/zones" -H "Authorization: ApiKey $KEY"
echo "-- negative: no credential"
req GET "$BASE/partner/zones"
echo "-- internal request log (request_log)"
sql "SELECT id, received_at, method, path, client_name, status, cf_ray, latency_ms FROM request_log ORDER BY id DESC LIMIT 3"

# ---------------------------------------------------------------------------
hr "5. IDEMPOTENCY PROOF - same Idempotency-Key + same body, sent twice"
IKEY="a5-$RUN-booking-42"
ZONE="Zone I-$RUN"
BODY="{\"name\":\"$ZONE\",\"capacity\":40,\"free\":40,\"permit_type\":\"visitor\"}"
echo "Idempotency-Key: $IKEY"
echo "-- request 1"
req POST "$BASE/partner/zones" -H "Authorization: ApiKey $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $IKEY" -d "$BODY"
echo "-- request 2 (byte-identical)"
req POST "$BASE/partner/zones" -H "Authorization: ApiKey $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $IKEY" -d "$BODY"
echo "-- request 3 (same key, DIFFERENT body) -> must be refused"
req POST "$BASE/partner/zones" -H "Authorization: ApiKey $KEY" -H "Content-Type: application/json" -H "Idempotency-Key: $IKEY" -d "{\"name\":\"$ZONE\",\"capacity\":40,\"free\":1}"
echo "-- DB proof: exactly one zone row was created"
sql "SELECT COUNT(*) AS rows_created, name FROM zones WHERE name = '$ZONE'"
sql "SELECT client_name, key, substr(request_hash,1,16)||'…' AS request_hash, response_status, created_at FROM idempotency_keys WHERE key = '$IKEY'"

# ---------------------------------------------------------------------------
hr "4. WEBHOOK SENDER - request 1 above triggered zone.created; outgoing payload + partner response"
sleep 3
sql "SELECT id, created_at, trigger_action, target_url, response_status, completed_at, error FROM webhook_outbox ORDER BY id DESC LIMIT 2"
sql "SELECT payload, signature, substr(response_body,1,900) AS partner_response FROM webhook_outbox ORDER BY id DESC LIMIT 1"

# ---------------------------------------------------------------------------
hr "3. WEBHOOK RECEIVER - incoming payload, secret verification, stored log"
echo "-- a) correctly signed delivery (partner signs t.body with the shared secret)"
PFILE="$OUT/.partner-payload.json"
printf '%s' '{"event":"slot.reserved","source":"partner-team","data":{"reservation_id":"R-1001","zone_id":1,"plate":"กข 1234"}}' > "$PFILE"
sign() { # sign FILE [age-seconds] -> X-Webhook-Signature value; signs the exact bytes on disk
  python - "$SECRET" "$1" "${2:-0}" <<'PYEOF'
import sys,hmac,hashlib,time
s,f,age=sys.argv[1],sys.argv[2],int(sys.argv[3]); b=open(f,"rb").read(); t=int(time.time())-age
print(f"t={t},v1={hmac.new(s.encode(),f'{t}.'.encode()+b,hashlib.sha256).hexdigest()}")
PYEOF
}
SIG=$(sign "$PFILE")
echo "payload: $(cat "$PFILE")"
echo "X-Webhook-Signature: $SIG"
req POST "$BASE/webhooks/partner" -H "Content-Type: application/json" -H "X-Webhook-Signature: $SIG" --data-binary "@$PFILE"
echo "-- b) forged delivery (wrong secret) -> rejected but still logged"
req POST "$BASE/webhooks/partner" -H "Content-Type: application/json" -H "X-Webhook-Signature: t=$(date +%s),v1=deadbeef" --data-binary "@$PFILE"
echo "-- c) replayed delivery (signature from 10 minutes ago) -> rejected"
req POST "$BASE/webhooks/partner" -H "Content-Type: application/json" -H "X-Webhook-Signature: $(sign "$PFILE" 600)" --data-binary "@$PFILE"
echo "-- stored log (webhook_inbox) - newest first"
sql "SELECT id, received_at, event_type, signature_valid, reason, substr(raw_body,1,60)||'…' AS raw_body FROM webhook_inbox ORDER BY id DESC LIMIT 4"

# ---------------------------------------------------------------------------
hr "1. CONSUMER PROOF - we call the partner's URL"
req GET "$BASE/integration/partner/zones"
sql "SELECT id, at, partner_url, outcome, http_status, latency_ms, error FROM integration_log ORDER BY id DESC LIMIT 1"

# ---------------------------------------------------------------------------
hr "6. DEGRADATION PROOF - break the partner, observe fallback, restore, observe recovery"
echo "[$(ts)] BREAKAGE: redeploying with PARTNER_BASE_URL pointed at a dead host"
npx wrangler deploy --var PARTNER_BASE_URL:https://partner-is-down.invalid 2>&1 | grep -E 'Deployed|Version' | sed 's/^/  /'
echo "-- consumer call while partner is unreachable -> fallback JSON"
req GET "$BASE/integration/partner/zones"
echo "[$(ts)] RECOVERY: redeploying with the real partner URL"
npx wrangler deploy 2>&1 | grep -E 'Deployed|Version' | sed 's/^/  /'
echo "-- first call after recovery -> recovered:true"
req GET "$BASE/integration/partner/zones"
echo "-- automatic recovery log (integration_log)"
sql "SELECT id, at, outcome, http_status, latency_ms, error FROM integration_log ORDER BY id DESC LIMIT 3"

echo
echo "run complete $(ts)"
} 2>&1 | tee "$OUT/run-$RUN.txt"

echo "wrote $OUT/run-$RUN.txt"
