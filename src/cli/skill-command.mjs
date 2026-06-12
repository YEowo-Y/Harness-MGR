/**
 * CLI handler for `skill propose <name> --from <file> [--reason <msg>] [--apply]`
 * (P5.U8 sub-unit C).
 *
 * Wires the already-built `proposeSkill` engine (src/ops/propose.mjs) into the CLI
 * behind the SAME write gate every write command uses: `resolveWriteIntent` requires
 * `--apply` (dry-run by default; set `CLAUDE_MGR_ENABLE_WRITES=0` to force-lock writes).
 *
 * DRY-RUN BY DEFAULT: a bare `skill propose <name> --from <file>` reads both files,
 * builds the unified diff, and writes NOTHING. With `--apply` + the env factor the
 * propose actually runs: it writes ONLY skills/<name>/SKILL.proposed-<ts>.md under the
 * least-authority 'propose' gate context (NEVER touching the original SKILL.md) and a
 * best-effort provenance record in .mgr-state/proposals/. No auto-snapshot — propose
 * only ADDS a file; its undo is deletion (the snapshot-before-overwrite belongs to U9
 * accept).
 *
 * M2-SAFETY: this module never STATICALLY imports src/paths.mjs. The write gate
 * (`assertWritable`) is resolved via a DYNAMIC `import()` ONLY on the real --apply
 * path (mirrors remove-command.mjs); on import failure the command degrades
 * gracefully to a `skill-propose-write-unavailable` warn. The dry-run path never
 * touches paths.mjs.
 *
 * SECRET-SAFE (P5 surface convention; design §9): the WHOLE result AND the merged
 * diagnostics pass `redactSecretsDeep` before returning — the unified diff carries
 * raw SKILL.md / --from content that could contain token-shaped text. Output
 * redaction only — the proposal file on disk is the EXACT proposed bytes.
 *
 * `deps` is the injectable test seam (mirrors remove-command.mjs): fake `loadPaths`
 * + `proposeFn` + `env` make every path hermetically unit-testable without a real
 * gate / lock / write / fs.
 *
 * Never throws — proposeSkill is ops-pure/never-throws, the dynamic import is
 * guarded, and the summary helper is fully defensive.
 *
 * Spec: docs/phase-5-u8-propose-design.md §5/§7.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { proposeSkill } from '../ops/propose.mjs';
import { resolveWriteIntent } from './write-gate.mjs';
import { redactSecretsDeep } from '../analysis/redact-secrets-text.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */
/** @typedef {import('../ops/propose.mjs').ProposeResult} ProposeResult */

/**
 * Map a ProposeResult to a CLI exit code (design §7):
 *   0 — clean dry-run preview or successful apply
 *   2 — validation refused (bad args, name-invalid, no-change on apply, …)
 *   6 — apply lock could not be acquired (propose-lock-failed)
 *   3 — no name / no --from / writes-disabled gate (handled upstream)
 *   1 — any other apply failure
 *
 * @param {ProposeResult} r
 * @returns {number}
 */
function proposeExitCode(r) {
  const lockFailed = (r.lock && r.lock.acquired === false)
    || (Array.isArray(r.diagnostics) && r.diagnostics.some((d) => d && d.code === 'propose-lock-failed'));
  if (lockFailed) return 6;
  if (r.refused) return 2;
  if (r.ok) return 0;
  return 1;
}

/**
 * Shape a ProposeResult into a LEAN, flat summary for the table renderer. Fully
 * defensive — every field is coerced to a safe scalar / null. GENUINELY TOTAL: the
 * body is wrapped so even a pathological result (a throwing getter) degrades to a
 * constant summary instead of throwing (mirrors summarizeRemove). The `unified`
 * diff block is kept on the returned object so the table renderer can print it.
 *
 * @param {ProposeResult} r
 * @returns {object}
 */
function summarizeProposal(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    return {
      status: o.refused ? 'refused' : (o.dryRun ? 'dry-run' : (o.ok ? 'proposed' : 'failed')),
      ok: !!o.ok,
      dryRun: !!o.dryRun,
      name: o.name ?? null,
      target: o.target ?? null,
      proposalId: o.proposalId ?? null,
      changed: !!o.changed,
      sourceSha256: o.sourceSha256 ?? null,
      provenanceWritten: !!o.provenanceWritten,
      stats: o.stats ?? null,
      unified: typeof o.unified === 'string' ? o.unified : null,
    };
  } catch {
    return {
      status: 'summary-error', ok: false, dryRun: false,
      name: null, target: null, proposalId: null, changed: false,
      sourceSha256: null, provenanceWritten: false, stats: null, unified: null,
    };
  }
}

/**
 * Resolve the governed-write gate (`assertWritable`) ONLY when writes are enabled.
 * The dry-run path performs no write, so it returns `{ assertWritable: undefined }`
 * without touching paths.mjs (M2-safe). On the --apply path, paths.mjs is imported
 * DYNAMICALLY; a load failure returns `{ error }` — a graceful warn CommandOutput
 * the caller short-circuits with. Never throws.
 *
 * @param {boolean} enableWrites
 * @param {(() => Promise<{assertWritable: Function}>)|undefined} loadPaths  test seam
 * @returns {Promise<{assertWritable?: Function, error?: CommandOutput & {code: number}}>}
 */
async function resolveProposeGate(enableWrites, loadPaths) {
  if (!enableWrites) return { assertWritable: undefined };
  try {
    const paths = await (loadPaths ?? (() => import('../paths.mjs')))();
    return { assertWritable: paths.assertWritable };
  } catch (err) {
    return {
      error: {
        result: { status: 'write-unavailable' },
        diagnostics: [{
          severity: 'warn', code: 'skill-propose-write-unavailable', phase: 'cli',
          message: `~/.claude/hooks/lib unloadable; skill propose --apply needs the write gate: ${err instanceof Error ? err.message : String(err)}`,
        }],
        code: 1,
      },
    };
  }
}

/**
 * Drive `proposeSkill` from the CLI. Reads the skill name from
 * `ctx.args.positionals[0]` and the source from `ctx.args.from`, applies the write
 * gate, and (only on the real --apply path) dynamically resolves the governed-write
 * gate.
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, args }
 * @param {{
 *   loadPaths?: () => Promise<{assertWritable: Function}>,
 *   proposeFn?: typeof proposeSkill,
 *   env?: Record<string, string|undefined>
 * }} [deps]
 * @returns {Promise<CommandOutput & {code: number}>}
 */
export async function skillProposeCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};

  const name = args && Array.isArray(args.positionals) ? args.positionals[0] : undefined;
  if (typeof name !== 'string' || name.length === 0) {
    return {
      result: { status: 'no-name' },
      diagnostics: [{
        severity: 'error', code: 'skill-propose-no-name', phase: 'cli',
        message: 'skill propose requires a name: skill propose <name> --from <file>',
      }],
      code: 3,
    };
  }

  const fromPath = typeof args.from === 'string' ? args.from : undefined;
  if (typeof fromPath !== 'string' || fromPath.length === 0) {
    return {
      result: { status: 'no-source' },
      diagnostics: [{
        severity: 'error', code: 'propose-no-source', phase: 'cli',
        message: 'skill propose requires a source file: skill propose <name> --from <file>',
      }],
      code: 3,
    };
  }

  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  const apply = !!(args && args.apply);
  const env = deps.env ?? process.env;

  // Write gate: --apply enables the write; CLAUDE_MGR_ENABLE_WRITES=0 is an explicit
  // opt-out lock. A closed gate REFUSES here — the engine is never called.
  const intent = resolveWriteIntent({ apply, env });
  if (intent.refusal) {
    return {
      result: { status: 'refused', mode: 'apply-requested' },
      diagnostics: [intent.refusal],
      code: intent.code,
    };
  }

  // Resolve the governed-write gate ONLY on the real --apply path (M2-safe dynamic
  // import). A load failure short-circuits with a graceful warn result.
  const gate = await resolveProposeGate(intent.enableWrites, deps.loadPaths);
  if (gate.error) return gate.error;
  const assertWritable = gate.assertWritable;

  const proposeFn = deps.proposeFn ?? proposeSkill;
  // The engine boundary is a seam: proposeSkill is proven never-throws/never-
  // rejects, but guarding the await keeps the handler total even against a buggy
  // or injected seam — a throw/reject degrades to a clean error result.
  let r;
  try {
    r = await proposeFn({
      name,
      fromPath,
      targetClaudeDir: ctx.configDir,
      mgrStateDir: ctx.mgrStateDir,
      assertWritable,
      enableWrites: intent.enableWrites,
      reason,
      pid: process.pid,
    });
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{
        severity: 'error', code: 'skill-propose-unexpected-error', phase: 'cli',
        message: `skill propose failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      }],
      code: 1,
    };
  }

  const o = r && typeof r === 'object' ? r : {};
  // SECRET-SAFE: redact the WHOLE summary (the unified diff carries raw file
  // content) AND the diagnostics as belt-and-suspenders before returning.
  return {
    result: redactSecretsDeep(summarizeProposal(o)),
    diagnostics: /** @type {Diagnostic[]} */ (redactSecretsDeep(Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [])),
    code: proposeExitCode(o),
  };
}
