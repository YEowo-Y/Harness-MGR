/**
 * OpenAI Codex target descriptor (P6.U1).
 *
 * A frozen LITERAL SEED from the 2026-06-13 live `~/.codex` scan (design §4).
 * The Codex surface CHURNS (skills 263→287 in two days, config.toml ~49 KB), so
 * these tables are a DATED seed, deliberately re-grounded per unit — not a stable
 * contract. Read-only / TOML-free batch: governedConfigFiles is recorded for the
 * later snapshot/drift wave but UNUSED in U1–U4; agents/ uses filename identity
 * only (`flat-toml`) — no `.toml` CONTENT is parsed this batch.
 *
 * Pure / never-throws / frozen / zero npm deps.
 */

/** @typedef {import('./descriptor.mjs').TargetDescriptor} TargetDescriptor */

/** @type {TargetDescriptor} */
export const codexDescriptor = Object.freeze({
  id: 'codex',
  label: 'OpenAI Codex',
  defaultHomeSubdir: '.codex',
  signatureFile: 'config.toml',
  componentKinds: Object.freeze([
    Object.freeze({ kind: 'skill', dir: 'skills', layout: 'skill-md' }),
    // codex prompts/ = the command kind (.md, TOML-free)
    Object.freeze({ kind: 'command', dir: 'prompts', layout: 'flat-md' }),
    // filename identity only; content parse deferred to the TOML wave
    Object.freeze({ kind: 'agent', dir: 'agents', layout: 'flat-toml' }),
  ]),
  governedConfigFiles: Object.freeze(['config.toml', 'AGENTS.md', 'hooks.json']),
  knownTopDirs: Object.freeze([
    '.codex', '.omx', '.sandbox', '.sandbox-bin', '.sandbox-secrets', '.tmp',
    'agents', 'ambient-suggestions', 'archived_sessions', 'cache', 'computer-use',
    'computer-use-turn-ended', 'generated_images', 'harness', 'hooks', 'log',
    'memories', 'node_repl', 'pets', 'plugins', 'process_manager', 'prompts',
    'rules', 'sessions', 'skills', 'sqlite', 'tmp', 'vendor_imports', 'worktrees',
  ]),
  knownTopFiles: Object.freeze([
    'config.toml', 'AGENTS.md', 'hooks.json', 'auth.json', '.credentials.json',
    '.codex-global-state.json', '.codex-global-state.json.bak', '.personality_migration',
    'cap_sid', 'chrome-native-hosts.json', 'chrome-native-hosts-v2.json',
    'history.jsonl', 'installation_id', 'models_cache.json', 'sandbox.log',
    'session_index.jsonl', 'version.json',
  ]),
  knownTopFilePatterns: Object.freeze([
    // sqlite heavy-runtime family — goals_1.sqlite / logs_2.sqlite-wal
    /^[a-z0-9_]+\.sqlite(-shm|-wal)?$/i,
    // leftover-bloat: recognized as KNOWN (not a hard orphan); a future doctor
    // check owns the "8 stale" judgment (mirrors CC CLAUDE.md.backup.* + #13).
    /^\.\.codex-global-state\.json\.tmp-.+$/,
  ]),
  // Codex hooks live in a standalone top-level hooks.json (TOML-free) under the
  // `hooks` pointer — the `.hooks` map is shape-compatible with Claude's merged
  // effective.hooks ({ [event]: [{ matcher?, hooks: [{type:'command', command}] }] }).
  hookSource: Object.freeze({ kind: 'json-file', file: 'hooks.json', pointer: 'hooks' }),
});
