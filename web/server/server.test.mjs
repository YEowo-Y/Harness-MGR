/**
 * Web API server tests (node --test, zero new deps).
 *
 * Two layers:
 *   1. PURE GUARD HELPERS — the capability matrix (writeKindsFor / removeKindsFor /
 *      pluginWriteSupported), the safe-arg filter (buildArgs / asBool), target resolution,
 *      and the frozen/proto-safe allowlists. Deterministic, no I/O.
 *   2. ROUTE GUARDS via app.request() — the HTTP security boundary the curl checks pin:
 *      the read/write command allowlists, the x-harness-mgr-write CSRF header, target/kind/
 *      name/state validation, the DNS-rebinding Host guard, and proto-safety. Every one of
 *      these returns BEFORE the engine is touched, so they assert without reading real config
 *      or writing anything. A couple of read-only happy paths (/api/status, a capability gate)
 *      do resolve the real claude descriptor — read-only, and deterministic for claude.
 *
 * import.meta.main gates the listener, so importing the module here starts NO server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  app,
  READ_COMMANDS,
  WRITE_SPEC,
  WRITE_COMMANDS,
  WRITE_HEADER,
  SAFE_ARG_KEYS,
  asBool,
  buildArgs,
  resolveRequestedTarget,
  pluginWriteSupported,
  writeKindsFor,
  removeKindsFor,
} from "./server.mjs";

const CLAUDE = { id: "claude", pluginEnableModel: "settings-map" };
const CODEX = {
  id: "codex",
  writeSurface: { features: { configEdit: true }, configEditFiles: ["config.toml"] },
};

// A localhost base + an explicit localhost Host header so the request passes the Host
// guard and reaches the route logic (app.request does not derive Host from the URL).
const BASE = "http://127.0.0.1";
const req = (path, init = {}) =>
  app.request(BASE + path, { ...init, headers: { host: "127.0.0.1", ...(init.headers ?? {}) } });
const writeInit = (body, headers = { [WRITE_HEADER]: "1" }) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

// ── 1. capability matrix (pure) ────────────────────────────────────────────────

test("writeKindsFor: claude → plugin + skill (settings.json map + skillOverrides)", () => {
  assert.deepEqual(writeKindsFor(CLAUDE), ["plugin", "skill"]);
});

test("writeKindsFor: codex → plugin + mcp (config.toml splice; no skill lever)", () => {
  assert.deepEqual(writeKindsFor(CODEX), ["plugin", "mcp"]);
});

test("writeKindsFor: unknown / null descriptor → [] (read-only)", () => {
  assert.deepEqual(writeKindsFor(null), []);
  assert.deepEqual(writeKindsFor({}), []);
  assert.deepEqual(writeKindsFor({ id: "other" }), []);
});

test("removeKindsFor: claude AND codex → skill/agent/command; else []", () => {
  assert.deepEqual(removeKindsFor(CLAUDE), ["skill", "agent", "command"]);
  assert.deepEqual(removeKindsFor(CODEX), ["skill", "agent", "command"]);
  assert.deepEqual(removeKindsFor(null), []);
  assert.deepEqual(removeKindsFor({ id: "other" }), []);
});

test("pluginWriteSupported: settings-map OR a configEdit surface; else false", () => {
  assert.equal(pluginWriteSupported(CLAUDE), true);
  assert.equal(pluginWriteSupported(CODEX), true);
  assert.equal(pluginWriteSupported(null), false);
  assert.equal(pluginWriteSupported({}), false);
  assert.equal(pluginWriteSupported({ writeSurface: { features: { configEdit: true }, configEditFiles: [] } }), false);
});

// ── 2. safe-arg filter (pure) ───────────────────────────────────────────────────

test("buildArgs: only SAFE_ARG_KEYS pass; configDir/apply/active-probes/force are dropped", () => {
  const args = buildArgs({
    type: "skill",
    name: "x",
    detail: "1",
    configDir: "/etc/passwd",
    apply: "true",
    "active-probes": "1",
    force: "1",
    unknown: "y",
  });
  assert.equal(args.type, "skill");
  assert.equal(args.name, "x");
  assert.equal(args.detail, true); // boolean-coerced
  for (const danger of ["configDir", "apply", "active-probes", "force", "unknown"]) {
    assert.equal(danger in args, false, `${danger} must not flow into args`);
  }
});

test("buildArgs: result has a null prototype (no __proto__ pollution sink)", () => {
  const args = buildArgs({ name: "x" });
  assert.equal(Object.getPrototypeOf(args), null);
});

test("asBool: absent/''/0/false → false; everything else → true", () => {
  for (const f of [undefined, null, "", "0", "false", "FALSE"]) assert.equal(asBool(f), false);
  for (const t of ["1", "true", "yes", "x"]) assert.equal(asBool(t), true);
});

test("resolveRequestedTarget: default claude; valid passthrough; invalid → null", () => {
  assert.equal(resolveRequestedTarget({}), "claude");
  assert.equal(resolveRequestedTarget({ target: "claude" }), "claude");
  assert.equal(resolveRequestedTarget({ target: "codex" }), "codex");
  assert.equal(resolveRequestedTarget({ target: "../../etc" }), null);
});

// ── 3. frozen + proto-safe allowlists ──────────────────────────────────────────

test("allowlists are frozen (a handler can never extend them)", () => {
  assert.equal(Object.isFrozen(READ_COMMANDS), true);
  assert.equal(Object.isFrozen(WRITE_COMMANDS), true);
  assert.equal(Object.isFrozen(WRITE_SPEC), true);
  assert.equal(Object.isFrozen(SAFE_ARG_KEYS), true);
});

test("allowlist membership is proto-safe (inherited keys are NOT members)", () => {
  for (const k of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
    assert.equal(READ_COMMANDS.has(k), false);
    assert.equal(WRITE_COMMANDS.has(k), false);
  }
  // sanity: the real members ARE present
  assert.equal(READ_COMMANDS.has("inventory"), true);
  assert.equal(WRITE_COMMANDS.has("disable"), true);
});

// ── 4. read route guards (app.request — return before the engine) ───────────────

test("GET /api/command: a non-allowlisted command → 403", async () => {
  for (const cmd of ["selftest", "config:diff", "completion", "rm"]) {
    const r = await req(`/api/command/${cmd}`);
    assert.equal(r.status, 403, `${cmd} should be 403`);
    assert.equal((await r.json()).error, "command-not-allowed");
  }
});

test("GET /api/command: an invalid target → 400", async () => {
  const r = await req("/api/command/inventory?target=bogus");
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "unknown-target");
});

test("GET /api/command: a colon-keyed read command (config:show-effective) is allowlisted + routes", async () => {
  const r = await req("/api/command/config:show-effective?target=claude");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).command, "config:show-effective");
});

// ── 5. write route guards (app.request — return before the engine) ──────────────

test("POST /api/write: missing the CSRF header → 403", async () => {
  const r = await req("/api/write/disable", writeInit({ type: "plugin", name: "x" }, {}));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "write-header-required");
});

test("POST /api/write: a non-write command → 403 (proto-safe, not a 500)", async () => {
  for (const cmd of ["inventory", "__proto__", "constructor"]) {
    const r = await req(`/api/write/${cmd}`, writeInit({ type: "plugin", name: "x" }));
    assert.equal(r.status, 403, `${cmd} should be a clean 403`);
  }
});

test("POST /api/write: malformed JSON body → 400", async () => {
  const r = await req("/api/write/disable", writeInit("{not json", { [WRITE_HEADER]: "1" }));
  assert.equal(r.status, 400);
});

test("POST /api/write: a kind outside the command's allowlist → 400", async () => {
  // disable accepts plugin|mcp, never skill
  const r = await req("/api/write/disable", writeInit({ type: "skill", name: "x" }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "kind-not-allowed");
});

test("POST /api/write: a missing/empty name → 400", async () => {
  const r = await req("/api/write/disable", writeInit({ type: "plugin", name: "" }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "name-required");
});

test("POST /api/write skill:visibility: an invalid state → 400", async () => {
  const r = await req("/api/write/skill:visibility", writeInit({ type: "skill", name: "x", state: "bogus" }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "state-not-allowed");
});

test("POST /api/write: an unknown target → 400", async () => {
  const r = await req("/api/write/disable", writeInit({ type: "plugin", name: "x", target: "bogus" }));
  assert.equal(r.status, 400);
});

// ── 6. DNS-rebinding Host guard ─────────────────────────────────────────────────

test("Host guard: a non-localhost Host → 403, localhost/127.0.0.1 pass", async () => {
  const bad = await app.request(BASE + "/api/status", { headers: { host: "evil.example.com" } });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error, "forbidden-host");
  for (const h of ["127.0.0.1", "localhost", "127.0.0.1:4319"]) {
    const ok = await app.request(BASE + "/api/status", { headers: { host: h } });
    assert.notEqual(ok.status, 403, `host ${h} should pass the guard`);
  }
});

// ── 7. read-only happy paths + the per-target capability gate (claude descriptor) ─

test("GET /api/status: 200 with version + capability advertisement (read-only)", async () => {
  const r = await req("/api/status");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(typeof j.version, "string");
  assert.deepEqual(j.targets, ["claude", "codex"]);
  // claude is settings-map → plugin + skill writable; remove covers all three component kinds
  assert.deepEqual(j.writeKinds, ["plugin", "skill"]);
  assert.deepEqual(j.removeKinds, ["skill", "agent", "command"]);
});

test("POST /api/write: a kind the TARGET doesn't support → 400 (mcp on claude)", async () => {
  // mcp passes the command-level kind check (disable accepts plugin|mcp) but claude's
  // writeKindsFor has no mcp → the per-target gate refuses BEFORE any engine call. apply omitted.
  const r = await req("/api/write/disable", writeInit({ type: "mcp", name: "context7", target: "claude" }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "kind-not-supported-for-target");
});
