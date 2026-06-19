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

/**
 * Codex leftover-state temp-file family: an interrupted atomic write of
 * `.codex-global-state.json` leaves a `..codex-global-state.json.tmp-<ts>-<uuid>`
 * behind. SINGLE-SOURCED — the orphan detector reads it via knownTopFilePatterns
 * (so these are KNOWN, not hard orphans) AND doctor #28 codex-state-tmp-bloat counts
 * the same files (discovery/probe-codex-config imports this const), so the
 * orphan-recognition and the bloat-count can never drift.
 */
export const CODEX_STATE_TMP_RE = /^\.\.codex-global-state\.json\.tmp-.+$/;

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
  // Codex loads components from MULTIPLE sources beyond the home dir. This declares the
  // IN-TREE plugin caches: plugins/cache/<marketplace>/<plugin>/<leaf>/{skills,commands}.
  // Each is tiered 'plugin' with marketplace+plugin provenance, so a plugin skill
  // `github:gh-fix-ci` does NOT collide with a home skill `gh-fix-ci` (namespaced key).
  //
  // SKILLS + COMMANDS are scanned. Commands are flat-md `.md` files in a leaf `commands/`
  // dir (live 2026-06-15: openai-curated/cloudflare ships build-agent.md + build-mcp.md
  // with real `description`/`argument-hint`/`allowed-tools` frontmatter) — basename
  // identity, exactly like the home `prompts/` command kind. Small (1 plugin today) but
  // CORRECT and consistent with the plugin-skill scan.
  //
  // Plugin "agents" are DELIBERATELY NOT scanned. Every one of the 91 (live 2026-06-15)
  // `agents/` dirs in the cache holds exactly a fixed-name `openai.yaml` INTERFACE-METADATA
  // sidecar (display_name/short_description/icon/default_prompt) describing the ADJACENT
  // skill/plugin — NOT an agent component. They appear both at leaf level AND nested inside
  // each skill dir; the filename carries no identity, the skills they annotate already
  // appear in inventory, and surfacing them would need a YAML parser (we have none —
  // TOML+JSONC only, by design) for zero governance value. (Home `~/.codex/agents/*.toml`
  // ARE real agents and are scanned by componentKinds above; only the plugin-cache yaml
  // sidecars are excluded.)
  //
  // The documented OUT-OF-TREE `~/.agents/skills` USER scope is the sibling-dir source
  // below. A symlinked `<leaf>` (codex's `latest -> <version>`) is not followed, so a
  // versioned component is counted once.
  componentSources: Object.freeze([
    Object.freeze({
      kind: 'plugin-cache',
      dir: 'plugins/cache',
      kinds: Object.freeze([
        Object.freeze({ kind: 'skill', dir: 'skills', layout: 'skill-md' }),
        Object.freeze({ kind: 'command', dir: 'commands', layout: 'flat-md' }),
      ]),
    }),
    // The documented OUT-OF-TREE USER scope `$HOME/.agents/skills` (dozens of skills
    // observed 2026-06-15; counts drift — a dated seed, like the rest of this file) — a
    // SIBLING of `~/.codex`, resolved as `dirname(config-dir)/.agents`
    // (default `~/.codex` → `~/.agents`; tiered 'user', distinguished from home by path).
    // Per Codex docs same-name skills coexist, so a `.agents` skill that shares a name
    // with a home/plugin skill surfaces as co-existence, never a shadow.
    Object.freeze({
      kind: 'sibling-dir',
      dir: '.agents',
      kinds: Object.freeze([Object.freeze({ kind: 'skill', dir: 'skills', layout: 'skill-md' })]),
    }),
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
    // leftover-bloat: recognized as KNOWN (not a hard orphan); doctor #28
    // codex-state-tmp-bloat owns the "too many" judgment (mirrors CC CLAUDE.md.backup.* + #13).
    CODEX_STATE_TMP_RE,
  ]),
  // Codex hooks live in a standalone top-level hooks.json (TOML-free) under the
  // `hooks` pointer — the `.hooks` map is shape-compatible with Claude's merged
  // effective.hooks ({ [event]: [{ matcher?, hooks: [{type:'command', command}] }] }).
  hookSource: Object.freeze({ kind: 'json-file', file: 'hooks.json', pointer: 'hooks' }),
  // Codex effective config = the single config.toml (one source — no layering/merge).
  configSource: Object.freeze({ kind: 'toml-file', file: 'config.toml' }),
  // Codex MCP servers live in the config.toml `mcp_servers` table (one source).
  mcpSource: Object.freeze({ kind: 'toml-table', file: 'config.toml', pointer: 'mcp_servers' }),
  // Codex plugins live in the config.toml `plugins` table (one source).
  pluginSource: Object.freeze({ kind: 'toml-table', file: 'config.toml', pointer: 'plugins' }),
  // Codex marketplaces = the UNION of the config.toml `marketplaces` table (declared, with
  // a machine-specific `source` path → installLocation) AND the plugins/cache/<name>/ dirs
  // (the on-disk truth; the table is incomplete — observed live: table=2 local vs cache=4,
  // the remote openai-curated/-remote ship plugins but aren't in the table). `onDisk` =
  // the cache dir exists. The table mixes a scalar setting (`max_depth`) with the sub-table
  // entries — non-object values are skipped silently (a setting, not a malformed entry).
  marketplaceSource: Object.freeze({ kind: 'toml-table-cache', file: 'config.toml', pointer: 'marketplaces', cacheDir: 'plugins/cache' }),
  // Enable signal = each plugin record's own `enabled` flag (config.toml
  // `[plugins."k"] enabled`); there is no settings enabledPlugins map for Codex.
  pluginEnableModel: 'record-flag',
  // The Codex governed WRITE surface (P6 write wave, unit 1 — file-level only).
  // Consumed by paths.mjs::makeAssertWritable; the gate's security LOGIC is shared
  // with Claude, only this DATA differs. Least authority:
  //   - forbiddenSubpaths: secrets (auth.json/.credentials.json), conversation
  //     privacy (sessions/archived_sessions/history.jsonl), and rebuildable plugin
  //     caches/catalog — ALWAYS denied (write-forbidden), defense in depth even
  //     against a rollback that tried to restore them.
  //   - applyWritableFiles: EMPTY. config.toml stays read-only this wave — no
  //     in-place TOML mutation (no comment/format-preserving serializer exists).
  //   - rollbackPaths: the governed config FILES (config.toml/AGENTS.md/hooks.json)
  //     + component dirs (skills/prompts/agents) — restorable WHOLE-file by rollback
  //     from a verified snapshot (NOT editable; same stance Claude takes for CLAUDE.md).
  //   - removeLeaves: codex commands are prompts/*.md and codex agents are
  //     agents/*.toml (NOT Claude's agents/*.md + commands/*.md). NOTE 'agents' is
  //     BOTH a removeLeaves dir AND a rollbackPath: a 'remove' of agents/x.toml hits
  //     the remove branch first (returns), while an 'apply' of it falls through to
  //     rollback → write-rollback-only — the dual listing is intentional + tested.
  //   - features: probe/propose/accept are Claude-only (loader-probe + skill
  //     self-iteration), disabled here → those contexts fall through to a deny. No
  //     probeDir is declared: it would be inert while probe is off, and OMITTING it
  //     means enabling codex probe later FAILS LOUDLY (no dir to write) instead of
  //     silently authorizing a write into the REAL agents/*.toml component dir.
  // See docs/phase-6-codex-write-gate-design.md.
  writeSurface: Object.freeze({
    forbiddenSubpaths: Object.freeze([
      'auth.json', '.credentials.json',
      'plugins/cache', 'plugins/marketplaces',
      'sessions', 'archived_sessions', 'history.jsonl',
    ]),
    applyWritableFiles: Object.freeze([]),
    rollbackPaths: Object.freeze(['config.toml', 'AGENTS.md', 'hooks.json', 'skills', 'prompts', 'agents']),
    removeLeaves: Object.freeze([
      Object.freeze({ dir: 'prompts', leafRe: /^[A-Za-z0-9._-]+\.md$/i }),
      Object.freeze({ dir: 'agents', leafRe: /^[A-Za-z0-9._-]+\.toml$/i }),
    ]),
    skillsDir: 'skills',
    features: Object.freeze({ probe: false, propose: false, accept: false }),
  }),
});
