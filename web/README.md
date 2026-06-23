# claude-mgr web UI

A **localhost-only, read-only** web front-end for the `claude-mgr` engine. It surfaces
your live `~/.claude` / `~/.codex` harness (inventory, conflicts, compare, doctor/health)
in the browser, with the Claude warm-brand design system.

> **Status: P0 (read-only).** Write actions (disable / enable / remove / visibility,
> with the dry-run → confirm → snapshot → rollback flow) are designed but **not built
> yet** — they are P2. Nothing here mutates your config.

## How it relates to the rest of the repo

This is an **isolated module** with its own `package.json` and dependencies, exactly like
`tui/` is an isolated Go module. It keeps the CLI core (`src/`) **zero-runtime-dependency** —
none of React / Vite / Hono leaks into the root `package.json`.

The server (`server/server.mjs`) calls the engine **in-process** through the same boundary
the CLI uses (`resolveTargetAndConfig` → `COMMANDS[cmd](ctx)` → the `{ command, result,
diagnostics }` JSON envelope). No discovery / analysis / redaction logic is reimplemented.

```
Browser (React + Vite)  ──fetch /api──>  Hono server (127.0.0.1)
                                              │ in-process
                                              ▼
                                  src/cli/commands.mjs  COMMANDS[cmd](ctx)
```

## Run it

From this `web/` directory:

```sh
npm install        # first time only — installs into web/node_modules (not the repo root)
npm run dev        # starts BOTH the API (127.0.0.1:4319) and Vite (127.0.0.1:5173)
```

Then open **http://127.0.0.1:5173**. Vite proxies `/api/*` to the API server.

Single-port production-style run (no Vite hot-reload):

```sh
npm run build      # bundles the app to web/dist
npm run start      # Hono serves web/dist + /api on http://127.0.0.1:4319
```

## Live updates (P1)

The views refresh **automatically** when your harness changes on disk. The server
watches each target's config dir (`~/.claude` / `~/.codex`) and pushes a coalesced
signal over Server-Sent Events (`/api/events`); the app re-fetches the affected
views. A small dot in the sidebar shows the connection (`live` / `connecting` /
`offline`). High-churn paths the UI never surfaces — logs, caches, snapshots,
session transcripts, SQLite journals — are filtered out so edits, not noise,
drive the refresh. This is still **read-only**: the watcher only observes.

## Security

This server reads sensitive config, so it is hardened:

- Binds **127.0.0.1 only** — never a public interface.
- Routes **only a frozen allowlist of READ commands**; no write handler is reachable.
- **Never** honors a client-supplied config directory — the dir is resolved server-side
  from the `target` param, so the browser can't turn the engine into a filesystem reader.
- Strips `apply` / `active-probes` from requests (no writes, no external-tool spawns).
- **Host-header allowlist** (localhost/127.0.0.1) defeats DNS-rebinding.

Secrets are already redacted by the engine before they reach the envelope (MCP env values,
tokens in status-line / permission strings, etc.).
