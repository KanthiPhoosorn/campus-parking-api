// Part 22 — authorisation policy in ONE place, so it is explicit and testable.
// Nothing here touches the network or the database: pure decisions, easy to unit test.

export type User = {
  id: number;
  role: string;
};

export type Zone = {
  operator_user_id: number;
};

/** Role check (Part 9). Used for admin-only endpoints. */
export function hasRole(user: User, allowedRoles: readonly string[]): boolean {
  return allowedRoles.includes(user.role);
}

/**
 * Part 10 — role + ownership combined.
 * admin    : may read any zone's private record
 * operator : may read only the zones they operate
 * viewer   : may not read private records at all (public feed only)
 */
export function canReadZone(user: User, zone: Zone): boolean {
  if (user.role === "admin") return true;
  return user.role === "operator" && zone.operator_user_id === user.id;
}

/**
 * Writing availability is stricter than reading it: only the operator who owns
 * the zone (or an admin) may change the free-space count.
 */
export function canWriteZone(user: User, zone: Zone): boolean {
  if (user.role === "admin") return true;
  return user.role === "operator" && zone.operator_user_id === user.id;
}

/** Part 16 — machine scope check. Deliberately separate from human roles. */
export function hasScope(clientScopes: readonly string[], requiredScope: string): boolean {
  return clientScopes.includes(requiredScope);
}
