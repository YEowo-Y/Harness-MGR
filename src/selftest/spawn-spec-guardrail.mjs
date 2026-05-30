/**
 * Spawn-spec guardrail (P3 gate-infra / carried follow-up #2).
 *
 * Behavioral check: for every registered safe-spawn consumer that opts into
 * `allowSlashPositionals: true`, verify that its `positionalPattern` is TIGHT
 * enough to reject all known Windows mutation flags (icacls /grant, /deny, etc.).
 *
 * WHY BEHAVIORAL (not a static source scan):
 *   The residual risk is the runtime behavior of a RegExp, not its textual form.
 *   A source scan cannot distinguish a permissive pattern from a tight NODE_PATH_RE
 *   without re-implementing regex matching — which is exactly what `.test()` does,
 *   for free and correctly. This mirrors the existing runtime write-allowlist probe
 *   rather than the textual checkStaticImports approach.
 *
 * TWO-DIRECTION FALSIFIABILITY:
 *   - Real SPAWN_SPECS (from spawn-spec-registry.mjs) MUST yield zero errors.
 *   - A synthetic permissive {allowSlashPositionals:true, positionalPattern:/.+/}
 *     MUST yield spawn-spec-permissive-positional errors.
 *   Both directions are pinned by tests.
 *
 * PURE / never-throws. All diagnostics carry phase:'boundary'.
 * Zero npm dependencies.
 */

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */

/**
 * @typedef {Object} SpawnSpecDescriptor
 * @property {string} id                    human-readable identifier (module name)
 * @property {boolean} allowSlashPositionals must be true (descriptors with false are skipped)
 * @property {RegExp} [positionalPattern]   the pattern fed to safeSpawn's schema
 */

/**
 * Windows icacls mutation flags (and single-char flags the tool accepts).
 * This is the closure of verbs enumerated in docs/threat-model.md §5.4 + §6.
 * The battery is exported so callers can extend it if they add a new spawn
 * consumer with a different mutation-flag vocabulary.
 *
 * CRITICAL: these are BARE flag tokens, exactly as icacls receives them.
 * NODE_PATH_RE rejects all of them because of its mandatory \.(mjs|cjs|js)$ tail.
 * A permissive pattern such as /.+/ or /^[/\\].+/ would match /grant and /deny.
 *
 * @type {ReadonlyArray<string>}
 */
export const MUTATION_FLAGS = Object.freeze([
  '/grant', '/grant:r',
  '/deny',
  '/remove', '/remove:g',
  '/c',
  '/t',
  '/q',
  '/reset',
  '/inheritance:r',
  '/setowner',
  '/save',
  '/restore',
]);

/**
 * A canonical POSIX absolute path that every real abs-path positionalPattern
 * should accept.  Used as the "accept probe" to catch degenerate over-tightened
 * patterns like /^$/ that vacuously reject all flags but are not working matchers.
 *
 * @type {string}
 */
export const LEGIT_POSIX_PATH = '/home/u/x.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Produce a single Diagnostic with phase:'boundary'.
 * @param {string} severity
 * @param {string} code
 * @param {string} message
 * @param {string} [path]
 * @returns {Diagnostic}
 */
function diag(severity, code, message, path) {
  /** @type {Diagnostic} */
  const d = { severity: /** @type {any} */ (severity), code, message, phase: 'boundary' };
  if (typeof path === 'string') d.path = path;
  return d;
}

// ── exported API ───────────────────────────────────────────────────────────

/**
 * Check every descriptor in `specs` that has `allowSlashPositionals === true`.
 *
 * For each such descriptor:
 *   (a) If positionalPattern is missing or not a RegExp instance →
 *       one 'spawn-spec-missing-pattern' error.
 *   (b) For each token in MUTATION_FLAGS where pattern.test(token) === true →
 *       one 'spawn-spec-permissive-positional' error per offending token.
 *   (c) If LEGIT_POSIX_PATH is rejected by the pattern (accept-probe fails) →
 *       one 'spawn-spec-accept-failed' error.
 *
 * Descriptors without allowSlashPositionals:true are skipped entirely.
 * Non-array input or garbage descriptors are tolerated (skipped silently).
 *
 * Never throws. All diagnostics carry phase:'boundary'.
 *
 * @param {unknown} specs   expected to be an array of SpawnSpecDescriptor
 * @returns {Diagnostic[]}
 */
export function checkSpawnSpecGuardrail(specs) {
  if (!Array.isArray(specs)) return [];

  /** @type {Diagnostic[]} */
  const diags = [];

  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') continue;
    // Only check opt-in consumers.
    if (spec.allowSlashPositionals !== true) continue;

    const id = typeof spec.id === 'string' && spec.id.length > 0 ? spec.id : '(unknown)';
    const pat = spec.positionalPattern;

    // (a) Missing or non-RegExp pattern.
    if (!(pat instanceof RegExp)) {
      diags.push(diag(
        'error',
        'spawn-spec-missing-pattern',
        `spawn spec '${id}' has allowSlashPositionals:true but positionalPattern is missing or not a RegExp`,
        id,
      ));
      continue; // can't probe a non-RegExp; skip (b) and (c)
    }

    // (b) Battery: every mutation flag must be REJECTED.
    // Reset lastIndex before each test() to guard against /g or /y flags on the
    // caller-supplied RegExp — a stateful lastIndex can cause test() to return
    // false for a flag that the pattern would otherwise match, under-counting
    // violations.  pat.lastIndex is writable on all RegExp instances.
    for (const flag of MUTATION_FLAGS) {
      try {
        pat.lastIndex = 0;
        if (pat.test(flag)) {
          diags.push(diag(
            'error',
            'spawn-spec-permissive-positional',
            `spawn spec '${id}': positionalPattern admits Windows mutation flag '${flag}' — ` +
              `re-opens the slash-flag injection hole closed by safe-spawn's default gate`,
            id,
          ));
        }
      } catch {
        // A RegExp that throws on .test() is degenerate; treat as a pattern error.
        diags.push(diag(
          'error',
          'spawn-spec-missing-pattern',
          `spawn spec '${id}': positionalPattern threw during .test('${flag}') — treat as missing`,
          id,
        ));
      }
    }

    // (c) Accept probe: the legit POSIX path must be ACCEPTED.
    // Reset lastIndex here too for the same /g /y guard reason.
    try {
      pat.lastIndex = 0;
      if (!pat.test(LEGIT_POSIX_PATH)) {
        diags.push(diag(
          'error',
          'spawn-spec-accept-failed',
          `spawn spec '${id}': positionalPattern rejects the legit POSIX path '${LEGIT_POSIX_PATH}' — ` +
            `pattern is too restrictive to be a working abs-path matcher`,
          id,
        ));
      }
    } catch {
      diags.push(diag(
        'error',
        'spawn-spec-accept-failed',
        `spawn spec '${id}': positionalPattern threw during accept-probe test`,
        id,
      ));
    }
  }

  return diags;
}
