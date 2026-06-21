/**
 * The single source of truth for the CLI flag vocabulary (P4b.U9).
 *
 * Both consumers import these two frozen lists so they can NEVER drift:
 *   - cli.mjs       uses them to parse argv (VALUE_FLAGS consume the next token;
 *                   BOOLEAN_FLAGS are presence-only).
 *   - completion.mjs bakes them into the generated tab-completion scripts so a
 *                   `--<Tab>` suggests exactly the flags the parser understands.
 *
 * This is a PURE LEAF: it imports nothing (no project modules, no node stdlib).
 * Keeping it import-free guarantees there is no cycle — completion.mjs can import
 * it, and cli.mjs can import it, without either pulling in the other.
 *
 * Zero npm dependencies.
 */

/** Value flags consume the NEXT argv token. */
export const VALUE_FLAGS = Object.freeze([
  '--format', '--config-dir', '--name', '--key', '--type', '--since', '--base',
  '--reason', '--keep', '--older-than', '--lock-version', '--scope', '--context',
  '--from', '--target', '--path',
]);

/** Boolean flags are presence-only (no value token). */
export const BOOLEAN_FLAGS = Object.freeze([
  '--explain', '--detail', '--lint', '--invariants', '--boundary',
  '--all', '--audit', '--active-probes', '--update', '--release-gate', '--log',
  '--schema-canary', '--update-baseline', '--apply', '--include-auth',
  '--break-lock', '--force', '--mark-failed', '--resume', '--rollback',
  '--from-manifest', '--by-category', '--cascade', '--redact-paths',
  '--prune-config',
]);
