# Contributing to claude-mgr

Thanks for your interest! claude-mgr is a **read-mostly governance CLI** for a Claude Code (and
Codex) harness. It is deliberately conservative: it reads your config, and any write is dry-run by
default. Contributions are expected to preserve that posture.

## Getting started

```sh
# Requires Node >= 24. The CLI core has no runtime dependencies; the MCP server
# entry uses @modelcontextprotocol/sdk, and one test imports it — so install first.
npm ci

node --test                          # the full test suite (3400+ tests)
node src/cli.mjs selftest --lint     # per-file SLOC ceiling
node src/cli.mjs selftest --boundary # zero-network import boundary
```

The optional Go TUI lives in `tui/`:

```sh
cd tui && go build ./... && go vet ./... && go test ./...
```

## Conventions (please match the surrounding code)

- **Discovery (`src/discovery/`) and analysis (`src/analysis/`) never throw.** Failures surface as
  structured `Diagnostic`s collected in a `DiagnosticBag`, never as exceptions.
- **Keep `src/analysis/**` pure** — no filesystem or process I/O. Gather facts in `src/discovery/`,
  judge them in `src/analysis/`.
- Every command handler is `(ctx) => { result, diagnostics }`. Argv parsing and output formatting
  (`table` / `json` / `ndjson`) are the CLI shell's job (`src/cli.mjs`), not the handler's.
- **Writes are dry-run by default.** A real write requires `--apply` and must route through the
  gated, snapshot-backed (reversible) op path. **Tests must never `--apply` against a real
  `~/.claude` / `~/.codex`** — use a temp sandbox dir.
- Zero npm dependencies in the CLI core. Node stdlib only (the MCP SDK is the one allowed exception,
  confined to `src/mcp/`).
- Keep each file under the 200-SLOC lint ceiling (`selftest --lint` enforces it).

## Tests

Every behavioral change needs tests. The suite uses the built-in `node --test` runner (no Jest/Mocha):
flat top-level `test(...)` calls, `node:assert/strict`. Add a never-throws section for any new
discovery/analysis module, and an oracle test against a committed fixture where one fits.

## Pull requests

- Branch from `main`; keep each commit focused and use [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Make sure `node --test`, `selftest --lint`, and `selftest --boundary` all pass (CI runs them on
  Linux **and** Windows — this project is Windows-hardened, so don't break path/symlink/BOM handling).
- Describe what changed and why; link any related issue.

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
