/**
 * claude-mgr web — localhost API server (P0, read-only).
 *
 * Surfaces the zero-dependency engine over HTTP for the browser UI. It calls the
 * SAME in-process boundary the CLI uses (resolveTargetAndConfig → COMMANDS[cmd](ctx)
 * → the { command, result, diagnostics } envelope), so the UI never reimplements any
 * discovery / analysis / redaction logic.
 *
 * SECURITY (this server reads a sensitive ~/.claude / ~/.codex):
 *   1. Binds 127.0.0.1 ONLY — never a public interface.
 *   2. Routes ONLY a frozen allowlist of READ commands. No write handler is
 *      reachable in P0 (writes — even dry-run — are a P2 concern).
 *   3. NEVER honors a client-supplied configDir — the dir is resolved server-side
 *      from `target` only, so the browser cannot turn the engine into an
 *      arbitrary-filesystem reader.
 *   4. Strips `apply` and `active-probes` from incoming args (no writes, no
 *      external-tool spawns triggered from a web request).
 *   5. Host-header allowlist (localhost/127.0.0.1 only) defeats DNS-rebinding.
 *
 * Zero engine changes. Dev: Vite serves the app and proxies /api here. Prod
 * (`npm run build` then `npm run start`): this server also serves web/dist.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../../src/cli/commands.mjs";
import {
  resolveTargetAndConfig,
  isKnownTarget,
} from "../../src/cli/resolve-target.mjs";
import { createLiveHub } from "./live.mjs";
import PKG from "../../package.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4319;

/**
 * The ONLY commands a web request may run — every one is a pure, never-throws READ.
 * Deliberately excludes: all write commands; `config:diff` and `completion` (they
 * take arbitrary file/path args → would be an arbitrary-read primitive); `selftest`
 * (runs lint/boundary, not a UI read). Frozen so a handler can never extend it.
 */
const READ_COMMANDS = Object.freeze(
  new Set([
    "inventory",
    "conflicts",
    "compare",
    "orphans",
    "config:show-effective",
    "hooks",
    "permissions",
    "doctor",
    "health",
    "snapshot:list",
  ]),
);

/**
 * The ONLY commands the write channel (POST /api/write) may run — a frozen PER-COMMAND
 * spec. Each entry pins the item KIND(s) the command accepts and, for a stateful command,
 * the exact set of valid `state` values; the handler validates against this before the
 * engine is touched (so e.g. `enable` can never be aimed at a skill). Every call still
 * goes through the engine's two-factor gate: a request WITHOUT `apply` is a dry-run
 * preview (no gate, no write); `apply:true` routes through resolveWriteIntent → snapshot
 * → the byte-preserving editor → reversible rollback. The engine, not this server,
 * enforces the write semantics — we only surface them.
 *
 *   disable / enable   → plugin on/off (Claude settings.json map / Codex config.toml)
 *   skill:visibility   → a Claude skill's 4-state skillOverrides value (name + state)
 */
const WRITE_SPEC = Object.freeze({
  disable: { kinds: new Set(["plugin"]) },
  enable: { kinds: new Set(["plugin"]) },
  "skill:visibility": {
    kinds: new Set(["skill"]),
    states: new Set(["on", "name-only", "user-invocable-only", "off"]),
  },
});

/**
 * A frozen Set of the valid write commands — the membership test the handler gates on.
 * A plain-object `WRITE_SPEC[cmd]` read would treat INHERITED keys (__proto__,
 * constructor, hasOwnProperty…) as truthy specs and reach a TypeError, so we mirror the
 * READ channel's proto-safe `.has()` check before ever reading the spec.
 */
const WRITE_COMMANDS = Object.freeze(new Set(Object.keys(WRITE_SPEC)));

/**
 * A write request MUST carry this header. A browser only attaches a custom header to
 * a SAME-ORIGIN request (our app); a cross-origin page cannot, because the custom
 * header forces a CORS preflight this server never answers with allow-headers. So
 * this defeats CSRF-style drive-by writes on top of the 127.0.0.1 + Host guard.
 */
const WRITE_HEADER = "x-claude-mgr-write";

/**
 * Query params that may flow into ctx.args. Excludes configDir (server-resolved),
 * apply, active-probes, force, break-lock — none of which a read UI needs and all of
 * which are write/spawn triggers. Unknown keys are ignored.
 */
const SAFE_ARG_KEYS = Object.freeze([
  "type",
  "detail",
  "by-category",
  "audit",
  "name",
]);

const BOOLEAN_ARG_KEYS = Object.freeze(
  new Set(["detail", "by-category", "audit"]),
);

/** Coerce a query value to a boolean flag: absent/"0"/"false"/"" → false, else true. */
function asBool(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).toLowerCase();
  return !(s === "" || s === "0" || s === "false");
}

/** Build the handler args from the request's safe query params only. */
function buildArgs(query) {
  const args = Object.create(null);
  for (const key of SAFE_ARG_KEYS) {
    if (!(key in query)) continue;
    args[key] = BOOLEAN_ARG_KEYS.has(key) ? asBool(query[key]) : query[key];
  }
  return args;
}

/** Resolve the requested target, defaulting to claude. Returns null if invalid. */
function resolveRequestedTarget(query) {
  const t = query.target;
  if (t === undefined) return "claude";
  return isKnownTarget(t) ? t : null;
}

/**
 * Does this target support the plugin enable/disable toggle? Claude via the
 * settings.json enabledPlugins map; Codex via the in-place config.toml surface.
 * Mirrors the engine's own capability check in config-edit-command.mjs.
 */
function pluginWriteSupported(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return false;
  if (descriptor.pluginEnableModel === "settings-map") return true;
  const ws = descriptor.writeSurface;
  return !!(
    ws &&
    ws.features &&
    ws.features.configEdit === true &&
    Array.isArray(ws.configEditFiles) &&
    ws.configEditFiles.length > 0
  );
}

const app = new Hono();

// DNS-rebinding guard: a browser pointed at this server always sends a
// localhost/127.0.0.1 Host. Anything else means the request was routed via an
// attacker-controlled name resolving to 127.0.0.1 — reject it.
app.use("*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  const name = host.replace(/:\d+$/, "");
  if (name === "127.0.0.1" || name === "localhost" || name === "[::1]") {
    return next();
  }
  return c.json({ error: "forbidden-host", message: `host not allowed: ${host}` }, 403);
});

app.get("/api/status", async (c) => {
  const target = resolveRequestedTarget(c.req.query());
  if (target === null) {
    return c.json({ error: "unknown-target", message: "target must be claude or codex" }, 400);
  }
  const cfg = await resolveTargetAndConfig({ target });
  // writeKinds tells the UI which item kinds it may offer a write control for on this
  // target. Empty = read-only for this target. plugin = enable/disable (either target,
  // when supported); skill = the 4-state visibility override (Claude settings.json only).
  const writeKinds = [];
  if (pluginWriteSupported(cfg.descriptor)) writeKinds.push("plugin");
  if (cfg.descriptor && cfg.descriptor.id === "claude") writeKinds.push("skill");
  return c.json({
    version: PKG.version,
    target,
    configDir: cfg.configDir,
    targets: ["claude", "codex"],
    writeKinds,
    diagnostics: cfg.diagnostics,
  });
});

app.get("/api/command/:cmd", async (c) => {
  const cmd = c.req.param("cmd");
  if (!READ_COMMANDS.has(cmd)) {
    return c.json(
      { error: "command-not-allowed", message: `not a read command: ${cmd}` },
      403,
    );
  }
  const query = c.req.query();
  const target = resolveRequestedTarget(query);
  if (target === null) {
    return c.json({ error: "unknown-target", message: "target must be claude or codex" }, 400);
  }

  const cfg = await resolveTargetAndConfig({ target });
  const args = buildArgs(query);
  const out = await COMMANDS[cmd]({
    configDir: cfg.configDir,
    mgrStateDir: cfg.mgrStateDir,
    descriptor: cfg.descriptor,
    args,
  });

  // The CLI's --format json envelope, verbatim (src/cli.mjs render()).
  return c.json({
    command: cmd,
    result: out.result,
    diagnostics: [...cfg.diagnostics, ...out.diagnostics],
  });
});

// Live-reload stream (P1). The hub watches each target's config dir and pushes a
// coalesced "change" signal; the browser turns it into a reloadKey bump → views
// re-fetch. Read-only: it only observes the filesystem (no writes, no spawns).
// Inherits the Host-header guard above (the `app.use("*")` middleware).
const live = await createLiveHub();

app.get("/api/events", (c) => {
  return streamSSE(c, async (stream) => {
    // greet so the client flips its indicator to "live" immediately
    await stream.writeSSE({ event: "hello", data: "{}" });
    const unsub = live.subscribe((payload) => {
      void stream.writeSSE({ event: "change", data: payload });
    });
    // keep-alive so an idle connection is not dropped by a proxy
    const ping = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: "1" });
    }, 25_000);
    if (typeof ping.unref === "function") ping.unref();
    // hold the stream open until the client disconnects, then clean up
    await new Promise((resolve) => {
      stream.onAbort(() => {
        clearInterval(ping);
        unsub();
        resolve();
      });
    });
  });
});

// Write channel. SEPARATE from the read API: its own frozen WRITE_SPEC allowlist, a
// required custom header (CSRF guard), and a POST verb. The dir is STILL resolved
// server-side from `target` (never the client), and every apply routes through the
// engine's two-factor gate → auto-snapshot → reversible rollback. A request without
// `apply:true` is a dry-run preview.
// NOTE: the server does NOT require a preceding dry-run — `apply:true` is accepted on
// the first request. The preview-then-confirm flow is a CLIENT UX affordance, not a
// server-enforced control. Write safety rests on the localhost + custom-header (CSRF)
// boundary keeping callers same-origin, plus the engine's gate/snapshot/reversibility.
app.post("/api/write/:cmd", async (c) => {
  const cmd = c.req.param("cmd");
  // Proto-safe membership test FIRST (an inherited key like __proto__ must get the same
  // clean 403, never a TypeError-500), then read the validated spec by own-key.
  if (!WRITE_COMMANDS.has(cmd)) {
    return c.json({ error: "command-not-allowed", message: `not a write command: ${cmd}` }, 403);
  }
  const spec = WRITE_SPEC[cmd];
  // CSRF guard: a cross-origin page cannot attach this custom header without a CORS
  // preflight we never grant, so only the same-origin app can reach the write path.
  if (c.req.header(WRITE_HEADER) === undefined) {
    return c.json({ error: "write-header-required", message: `missing ${WRITE_HEADER} header` }, 403);
  }
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "bad-json", message: "request body must be JSON" }, 400);
  }
  const target =
    body?.target === undefined ? "claude" : isKnownTarget(body.target) ? body.target : null;
  if (target === null) {
    return c.json({ error: "unknown-target", message: "target must be claude or codex" }, 400);
  }
  const kind = typeof body?.type === "string" ? body.type : "";
  if (!spec.kinds.has(kind)) {
    return c.json(
      { error: "kind-not-allowed", message: `${cmd} is limited to: ${[...spec.kinds].join(", ")}` },
      400,
    );
  }
  const name = typeof body?.name === "string" ? body.name : "";
  if (name.length === 0) {
    return c.json({ error: "name-required", message: "a component name is required" }, 400);
  }
  // A stateful command (skill:visibility) requires a `state` from its frozen enum; a
  // binary command (enable/disable) takes just the name. positionals mirror the CLI:
  // [name] or [name, state].
  const positionals = [name];
  if (spec.states) {
    const state = typeof body?.state === "string" ? body.state : "";
    if (!spec.states.has(state)) {
      return c.json(
        { error: "state-not-allowed", message: `state must be one of: ${[...spec.states].join(", ")}` },
        400,
      );
    }
    positionals.push(state);
  }
  const apply = body?.apply === true;

  const cfg = await resolveTargetAndConfig({ target });
  const args = Object.create(null);
  args.type = kind;
  args.positionals = positionals;
  args.apply = apply;
  const out = await COMMANDS[cmd]({
    configDir: cfg.configDir,
    mgrStateDir: cfg.mgrStateDir,
    descriptor: cfg.descriptor,
    args,
  });
  const code = typeof out.code === "number" ? out.code : 0;
  // 0 ok/dry-run/already · 2 refused/gate, 3 unsupported/bad-args, 6 lock → 409 · else 500
  const httpStatus = code === 0 ? 200 : code === 2 || code === 3 || code === 6 ? 409 : 500;
  return c.json(
    {
      command: cmd,
      apply,
      code,
      result: out.result,
      diagnostics: [...cfg.diagnostics, ...out.diagnostics],
    },
    httpStatus,
  );
});

// Production single-port mode: serve the built SPA when web/dist exists. In dev
// this never matches (Vite owns the frontend) — the API routes above are enough.
const DIST = join(__dirname, "..", "dist");
if (existsSync(DIST)) {
  // serveStatic resolves `root`/`path` relative to process.cwd(), so compute the
  // path from cwd to web/dist — the server then serves the SPA correctly no matter
  // which directory it was launched from (repo root, web/, or a packaged bin).
  const distRoot = relative(process.cwd(), DIST) || ".";
  const indexPath = `${distRoot}/index.html`;
  app.use("/*", serveStatic({ root: distRoot }));
  // SPA fallback: any non-API path returns index.html so client routing works.
  app.get("*", serveStatic({ path: indexPath }));
}

const port = Number(process.env.CLAUDE_MGR_WEB_PORT) || DEFAULT_PORT;
serve({ fetch: app.fetch, hostname: HOST, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(
    `claude-mgr web API → http://${HOST}:${info.port}  (read + plugin-write pilot)`,
  );
});
