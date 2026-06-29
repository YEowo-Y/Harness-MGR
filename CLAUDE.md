# harness-mgr — project context for Claude Code sessions

A **read-mostly governance CLI** for a Claude Code (and Codex) harness at `~/.claude` / `~/.codex`:
inventory, conflicts, `config show-effective`, doctor, snapshot/rollback, remove/update, and
cross-target `compare`. The CLI core is zero-runtime-dependency Node ESM, Windows-hardened,
**dry-run-by-default**, and lives OUTSIDE the agent's own loader (it never participates in loading).

## Conventions
- `src/discovery/` (scanners) and `src/analysis/` (pure analysis) **never throw** — failures surface
  as structured `Diagnostic`s collected in a `DiagnosticBag`.
- Every command handler is `(ctx) => { result, diagnostics }`; argv parsing and output formatting
  (table / json / ndjson) are the CLI shell's job (`src/cli.mjs`).
- **Dry-run by default**; writes require `--apply` and route through a gated, snapshot-backed
  (reversible) op path. NEVER `--apply` against a real `~/.claude` / `~/.codex` in a test — use a
  temp sandbox.
- Keep `src/analysis/**` pure (no I/O); gather facts in `src/discovery/**`.

## Build & verify
- Tests: `npm test` (Node >= 24).
- Lint / import-boundary self-checks: `node src/cli.mjs selftest --lint` and `node src/cli.mjs selftest --boundary`.

## Layout
- `src/cli/` — command handlers + render adapters
- `src/analysis/` — pure analysis (conflicts, compare, doctor checks, redaction)
- `src/discovery/` — never-throws scanners (components, plugins, mcp, settings)
- `src/ops/` — gated write operations (snapshot, rollback, config-edit)
- `src/lib/` — shared primitives (Diagnostic, paths, TOML/JSON editors)
- `docs/` — user-facing reference (effective-config rules, threat model)
