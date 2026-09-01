import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { canReadZone, canWriteZone, hasRole, hasScope, type User } from "./authz";
import { createApiKey, readApiKey, sha256Hex } from "./security";

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
  AUTH_MODE: string;
  ENABLE_INSECURE_LAB_DEMO: string;
  AUTH_JWKS_URL?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
};
type Variables = { externalSub: string; jwtPayload?: { sub?: string } };
type AppEnv = { Bindings: Bindings; Variables: Variables };
type AppContext = Context<AppEnv>;

type AppUser = User & { external_sub: string; email: string | null };
type ZoneRow = {
  id: number;
  name: string;
  capacity: number;
  free: number;
  permit_type: string;
  operator_user_id: number;
  operator_note: string | null;
  created_at: string;
  updated_at: string;
};
type ApiClient = { id: number; name: string; scopes_json: string; revoked_at: string | null };

const app = new Hono<AppEnv>();
app.use("/*", cors());

// ---------------------------------------------------------------------------
// Part 3/4 - Authentication. Demo mode simulates claims that a real identity
// provider would have verified, and is hard-restricted to development so it can
// never authenticate anything in production.
// ---------------------------------------------------------------------------
const DEMO_SUBJECTS = ["demo-alice", "demo-bob", "demo-admin"];

function isDemoMode(c: AppContext): boolean {
  return c.env.ENVIRONMENT === "development" && c.env.AUTH_MODE === "demo";
}

const authenticateHuman: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/, "").trim();

  if (isDemoMode(c)) {
    if (!token || !DEMO_SUBJECTS.includes(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("externalSub", token);
    return next();
  }

  // Real deployment path: verify the provider JWT (signature, iss, aud, exp).
  if (!c.env.AUTH_JWKS_URL || !c.env.AUTH_ISSUER || !c.env.AUTH_AUDIENCE) {
    return c.json({ error: "OIDC configuration is incomplete" }, 500);
  }
  const { jwk } = await import("hono/jwk");
  const verify = jwk({
    jwks_uri: c.env.AUTH_JWKS_URL,
    // Must match what the identity provider actually signs with - do not assume.
    alg: ["RS256"],
    verification: { iss: c.env.AUTH_ISSUER, aud: c.env.AUTH_AUDIENCE },
  });
  const failed = await verify(c, async () => undefined);
  if (failed instanceof Response) return failed;
  const sub = c.get("jwtPayload")?.sub;
  if (!sub) return c.json({ error: "Token has no subject claim" }, 401);
  c.set("externalSub", sub);
  return next();
};

app.use("/api/*", authenticateHuman);
app.use("/lab/*", authenticateHuman);

// Part 5 - map the external identity to OUR user record. Never trust a client id.
async function getCurrentUser(c: AppContext): Promise<AppUser | null> {
  return c.env.DB.prepare("SELECT id, external_sub, email, role FROM users WHERE external_sub = ?")
    .bind(c.get("externalSub"))
    .first<AppUser>();
}

async function requireCurrentUser(c: AppContext): Promise<AppUser | Response> {
  const user = await getCurrentUser(c);
  return user ?? c.json({ error: "Identity is not mapped to an application user" }, 403);
}

const isResponse = (v: AppUser | Response): v is Response => v instanceof Response;

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// PUBLIC - availability feed. Deliberately unauthenticated: this is the product.
// It exposes NO operator_note and NO operator_user_id.
// ---------------------------------------------------------------------------
app.get("/", (c) =>
  c.json({
    name: "Campus Parking Zones API",
    security: "Week 05 trust boundary: AuthN -> role -> ownership -> scope",
    public: ["GET /public/zones"],
    authenticated: ["GET /api/me", "GET /api/zones/:id", "PATCH /api/zones/:id", "POST /api/zones"],
    admin: ["DELETE /api/admin/users/:id", "POST /api/admin/api-clients"],
    machine: ["GET /machine/zones", "POST /machine/zones"],
  })
);

app.get("/public/zones", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, capacity, free, permit_type FROM zones ORDER BY id"
  ).all();
  return c.json({ count: results.length, data: results });
});

// ---------------------------------------------------------------------------
// AUTHENTICATED
// ---------------------------------------------------------------------------
app.get("/api/me", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  return c.json({ id: user.id, email: user.email, role: user.role });
});

// Part 8 - private record: authentication AND ownership.
app.get("/api/zones/:id", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;

  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id must be a positive integer" }, 400);

  const zone = await c.env.DB.prepare("SELECT * FROM zones WHERE id = ?").bind(id).first<ZoneRow>();
  // 404 (not 403) for both "missing" and "not yours", so IDs cannot be enumerated.
  if (!zone || !canReadZone(user, zone)) return c.json({ error: "Not found" }, 404);
  return c.json(zone);
});

app.patch("/api/zones/:id", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;

  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id must be a positive integer" }, 400);

  const zone = await c.env.DB.prepare("SELECT * FROM zones WHERE id = ?").bind(id).first<ZoneRow>();
  if (!zone || !canWriteZone(user, zone)) return c.json({ error: "Not found" }, 404);

  const body = await c.req
    .json<{ free?: unknown; operator_note?: unknown }>()
    .catch(() => ({} as { free?: unknown; operator_note?: unknown }));
  const free = typeof body.free === "number" && Number.isInteger(body.free) ? body.free : zone.free;
  const note = typeof body.operator_note === "string" ? body.operator_note : zone.operator_note;
  if (free < 0 || free > zone.capacity) {
    return c.json({ error: "free must be between 0 and capacity", capacity: zone.capacity, free }, 422);
  }

  const row = await c.env.DB.prepare(
    "UPDATE zones SET free = ?, operator_note = ?, updated_at = datetime('now') WHERE id = ? RETURNING *"
  )
    .bind(free, note, id)
    .first<ZoneRow>();
  return c.json(row);
});

// Part 11 - ownership comes from the token, never from the request body.
app.post("/api/zones", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  if (!hasRole(user, ["operator", "admin"])) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{
    name?: unknown;
    capacity?: unknown;
    free?: unknown;
    operator_user_id?: unknown;
  }>();
  if (typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof body.capacity !== "number" || typeof body.free !== "number") {
    return c.json({ error: "capacity and free are required numbers" }, 400);
  }
  if (body.free > body.capacity) return c.json({ error: "free must be <= capacity" }, 422);

  // body.operator_user_id is IGNORED on purpose - the owner is the caller.
  const row = await c.env.DB.prepare(
    "INSERT INTO zones (name, capacity, free, operator_user_id) VALUES (?, ?, ?, ?) RETURNING *"
  )
    .bind(body.name.trim(), body.capacity, body.free, user.id)
    .first<ZoneRow>();
  return c.json(row, 201);
});

// Part 9 - admin-only, enforced on the SERVER (not by hiding a UI button).
app.delete("/api/admin/users/:id", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  if (!hasRole(user, ["admin"])) return c.json({ error: "Forbidden" }, 403);
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(c.req.param("id")).run();
  return c.body(null, 204);
});

app.post("/api/admin/api-clients", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  if (!hasRole(user, ["admin"])) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json<{ name?: unknown; scopes?: unknown }>();
  if (
    typeof body.name !== "string" ||
    !Array.isArray(body.scopes) ||
    !body.scopes.every((s) => typeof s === "string")
  ) {
    return c.json({ error: "name and scopes (string array) are required" }, 400);
  }
  const apiKey = createApiKey();
  const result = await c.env.DB.prepare(
    "INSERT INTO api_clients (name, key_hash, scopes_json) VALUES (?, ?, ?)"
  )
    .bind(body.name, await sha256Hex(apiKey), JSON.stringify(body.scopes))
    .run();
  return c.json(
    {
      id: result.meta.last_row_id,
      name: body.name,
      scopes: body.scopes,
      api_key: apiKey,
      warning: "Store api_key now - only the SHA-256 hash is kept server-side.",
    },
    201
  );
});

app.post("/api/admin/api-clients/:id/revoke", async (c) => {
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;
  if (!hasRole(user, ["admin"])) return c.json({ error: "Forbidden" }, 403);
  await c.env.DB.prepare("UPDATE api_clients SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(c.req.param("id"))
    .run();
  return c.json({ revoked: true, id: Number(c.req.param("id")) });
});

// ---------------------------------------------------------------------------
// Part 6 - INTENTIONALLY VULNERABLE (BOLA/IDOR). Authenticated but with no
// ownership check. Disabled unless ENABLE_INSECURE_LAB_DEMO=true. Never deploy.
// ---------------------------------------------------------------------------
app.get("/lab/vulnerable/zones/:id", async (c) => {
  if (c.env.ENABLE_INSECURE_LAB_DEMO !== "true") {
    return c.json({ error: "Insecure lab endpoint is disabled" }, 404);
  }
  const user = await requireCurrentUser(c);
  if (isResponse(user)) return user;

  const zone = await c.env.DB.prepare("SELECT * FROM zones WHERE id = ?")
    .bind(c.req.param("id"))
    .first<ZoneRow>();
  return zone ? c.json(zone) : c.json({ error: "Not found" }, 404);
});

// ---------------------------------------------------------------------------
// Parts 15-17 - machine identity: its own scheme, explicit scopes, revocation.
// ---------------------------------------------------------------------------
async function authenticateMachine(c: AppContext): Promise<ApiClient | null> {
  const key = readApiKey(c.req.header("Authorization"));
  if (!key) return null;
  const client = await c.env.DB.prepare(
    "SELECT id, name, scopes_json, revoked_at FROM api_clients WHERE key_hash = ?"
  )
    .bind(await sha256Hex(key))
    .first<ApiClient>();
  if (!client) return null;
  return client.revoked_at ? null : client; // a revoked credential fails authentication
}

function parseScopes(scopesJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(scopesJson);
    return Array.isArray(parsed) && parsed.every((s) => typeof s === "string") ? parsed : [];
  } catch {
    return [];
  }
}

app.get("/machine/zones", async (c) => {
  const client = await authenticateMachine(c);
  if (!client) return c.json({ error: "Invalid machine credential" }, 401);
  if (!hasScope(parseScopes(client.scopes_json), "read:zones")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, capacity, free, permit_type FROM zones ORDER BY id"
  ).all();
  return c.json({ client: client.name, zones: results });
});

app.post("/machine/zones", async (c) => {
  const client = await authenticateMachine(c);
  if (!client) return c.json({ error: "Invalid machine credential" }, 401);
  if (!hasScope(parseScopes(client.scopes_json), "write:zones")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return c.json({ error: "Write not implemented in this lab" }, 501);
});

app.notFound((c) => c.json({ error: "Route not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
