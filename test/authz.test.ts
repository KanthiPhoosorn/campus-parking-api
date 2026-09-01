import { describe, expect, it } from "vitest";
import { canReadZone, canWriteZone, hasRole, hasScope } from "../src/authz";

// Part 23 - authorisation regression test.
// These lock the trust boundary into the executable specification: if someone
// later refactors the policy and widens access, CI fails instead of shipping a
// BOLA vulnerability.

const alice = { id: 1, role: "operator" };   // operates zones 1 and 3
const bob = { id: 2, role: "operator" };     // operates zones 2 and 4
const admin = { id: 3, role: "admin" };
const viewer = { id: 4, role: "viewer" };

const aliceZone = { operator_user_id: 1 };
const bobZone = { operator_user_id: 2 };

describe("zone ownership authorisation", () => {
  it("must reject an operator reading another operator's zone", () => {
    expect(canReadZone(alice, bobZone)).toBe(false);
    expect(canReadZone(bob, aliceZone)).toBe(false);
  });

  it("allows an operator to read their own zone", () => {
    expect(canReadZone(alice, aliceZone)).toBe(true);
    expect(canReadZone(bob, bobZone)).toBe(true);
  });

  it("allows an admin to read any zone", () => {
    expect(canReadZone(admin, aliceZone)).toBe(true);
    expect(canReadZone(admin, bobZone)).toBe(true);
  });

  it("does not let a viewer read private zone records", () => {
    expect(canReadZone(viewer, aliceZone)).toBe(false);
  });
});

describe("zone write authorisation", () => {
  it("must reject an operator writing another operator's zone", () => {
    expect(canWriteZone(alice, bobZone)).toBe(false);
  });

  it("allows the owning operator and an admin to write", () => {
    expect(canWriteZone(alice, aliceZone)).toBe(true);
    expect(canWriteZone(admin, bobZone)).toBe(true);
  });
});

describe("roles and machine scopes stay separate", () => {
  it("does not treat an operator as an admin", () => {
    expect(hasRole(alice, ["admin"])).toBe(false);
    expect(hasRole(admin, ["admin"])).toBe(true);
  });

  it("does not let a read-only machine credential write", () => {
    expect(hasScope(["read:zones"], "read:zones")).toBe(true);
    expect(hasScope(["read:zones"], "write:zones")).toBe(false);
  });
});
