/**
 * CLI handler for `skill accept <name> [<proposalId>] [--force] [--apply]`
 * (P5.U9 sub-unit C).
 *
 * Wires the already-built `acceptProposal` engine (src/ops/accept.mjs) into the CLI
 * behind the SAME write gate every write command uses: `resolveWriteIntent` requires
 * `--apply` (dry-run by default; set `HARNESS_MGR_ENABLE_WRITES=0` to force-lock writes).
 *
 * Split out of skill-command.mjs (which already holds skillProposeCommand) so each
 * module stays under the 200-SLOC lint ceiling — the sanctioned helper split
 * (hooks-command.mjs / snapshot-store-command.mjs precedent). It MIRRORS
 * skillProposeCommand EXACTLY for structure.
 *
 * DRY-RUN BY DEFAULT: a bare `skill accept <name>` selects the proposal, runs the
 * stale guard, and writes NOTHING (no gate / lock / snapshot / write). With `--apply`
 * + an open gate the accept actually runs: it snapshots the governed surface FIRST
 * (the undo point), then OVERWRITES skills/<name>/SKILL.md with the proposal bytes
 * under the least-authority 'accept' gate context and deletes the accepted proposal
 * + its provenance record (best-effort). The snapshot makes every accept reversible
 * via `rollback`.
 *
 * M2-SAFETY: this module never STATICALLY imports src/paths.mjs. The write gate
 * (`assertWritable`) is resolved via a DYNAMIC `import()` ONLY on the real --apply
 * path (mirrors skill-command.mjs / remove-command.mjs); on import failure the
 * command degrades gracefully to a `skill-accept-write-unavailable` warn. The
 * dry-run path never touches paths.mjs.
 *
 * SECRET-SAFE (P5 surface convention; design §6): the WHOLE result AND the merged
 * diagnostics pass `redactSecretsDeep` before returning — the accept summary carries
 * skill paths / content that could contain token-shaped text. Output redaction only —
 * SKILL.md on disk is the EXACT proposed bytes.
 *
 * `deps` is the injectable test seam (mirrors skill-command.mjs): fake `loadPaths`
 * + `acceptFn` + `env` make every path hermetically unit-testable without a real
 * gate / lock / snapshot / write / fs.
 *
 * Never throws — acceptProposal is ops-pure/never-throws, the dynamic import is
 * guarded, and the summary helper is fully defensive.
 *
 * Spec: docs/phase-5-u9-accept-design.md §5/§6.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { acceptProposal } from '../ops/accept.mjs';
import { resolveWriteIntent } from './write-gate.mjs';
import { redactSecretsDeep } from '../lib/redact-secrets-text.mjs';

/** @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./commands.mjs').CommandContext} CommandContext */
/** @typedef {import('./commands.mjs').CommandOutput} CommandOutput */
/** @typedef {import('../ops/accept.mjs').AcceptResult} AcceptResult */

/**
 * Map an AcceptResult to a CLI exit code (design §6):
 *   0 — clean dry-run preview or successful apply
 *   2 — validation / staleness refused (name-invalid, no-proposal, ambiguous,
 *       not-found, symlink, stale, no-provenance, …)
 *   3 — no name / writes-disabled gate (handled upstream)
 *   4 — snapshot / manifest integrity failure (accept-snapshot-failed or
 *       accept-target-not-snapshotted)
 *   6 — apply lock could not be acquired (accept-lock-failed / lock.acquired===false)
 *   1 — any other apply failure
 *
 * Lock + integrity codes are checked BEFORE the generic `refused` arm so a
 * lock-failed / not-snapshotted refusal maps to its specific code, not 2.
 *
 * @param {AcceptResult} r
 * @returns {number}
 */
function acceptExitCode(r) {
  const diags = Array.isArray(r.diagnostics) ? r.diagnostics : [];
  const has = (code) => diags.some((d) => d && d.code === code);
  if ((r.lock && r.lock.acquired === false) || has('accept-lock-failed')) return 6;
  if (has('accept-snapshot-failed') || has('accept-target-not-snapshotted')) return 4;
  if (r.refused) return 2;
  if (r.ok) return 0;
  return 1;
}

/**
 * Shape an AcceptResult into a LEAN, flat summary for the table renderer. Fully
 * defensive — every field is coerced to a safe scalar / null. GENUINELY TOTAL: the
 * body is wrapped so even a pathological result (a throwing getter) degrades to a
 * constant summary instead of throwing (mirrors summarizeProposal / summarizeRemove).
 *
 * @param {AcceptResult} r
 * @returns {object}
 */
function summarizeAccept(r) {
  const o = r && typeof r === 'object' ? r : {};
  try {
    return {
      status: o.refused ? 'refused' : (o.dryRun ? 'dry-run' : (o.ok ? 'accepted' : 'failed')),
      ok: !!o.ok,
      dryRun: !!o.dryRun,
      name: o.name ?? null,
      proposalId: o.proposalId ?? null,
      skillPath: o.skillPath ?? null,
      stale: !!o.stale,
      provenanceFound: !!o.provenanceFound,
      forced: !!o.forced,
      snapshotId: o.snapshotId ?? null,
      overwritten: !!o.overwritten,
      proposalRemoved: !!o.proposalRemoved,
    };
  } catch {
    return {
      status: 'summary-error', ok: false, dryRun: false,
      name: null, proposalId: null, skillPath: null,
      stale: false, provenanceFound: false, forced: false,
      snapshotId: null, overwritten: false, proposalRemoved: false,
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
async function resolveAcceptGate(enableWrites, loadPaths) {
  if (!enableWrites) return { assertWritable: undefined };
  try {
    const paths = await (loadPaths ?? (() => import('../paths.mjs')))();
    return { assertWritable: paths.assertWritable };
  } catch (err) {
    return {
      error: {
        result: { status: 'write-unavailable' },
        diagnostics: [{
          severity: 'warn', code: 'skill-accept-write-unavailable', phase: 'cli',
          message: `the write gate is unloadable; skill accept --apply needs it: ${err instanceof Error ? err.message : String(err)}`,
        }],
        code: 1,
      },
    };
  }
}

/**
 * Drive `acceptProposal` from the CLI. Reads the skill name from
 * `ctx.args.positionals[0]` and an optional proposal id from
 * `ctx.args.positionals[1]`, applies the write gate, and (only on the real --apply
 * path) dynamically resolves the governed-write gate. Mirrors skillProposeCommand
 * exactly for structure.
 *
 * @param {CommandContext} ctx  { configDir, mgrStateDir, args }
 * @param {{
 *   loadPaths?: () => Promise<{assertWritable: Function}>,
 *   acceptFn?: typeof acceptProposal,
 *   env?: Record<string, string|undefined>
 * }} [deps]
 * @returns {Promise<CommandOutput & {code: number}>}
 */
export async function skillAcceptCommand(ctx, deps = {}) {
  const args = ctx && ctx.args ? ctx.args : {};

  const name = args && Array.isArray(args.positionals) ? args.positionals[0] : undefined;
  if (typeof name !== 'string' || name.length === 0) {
    return {
      result: { status: 'no-name' },
      diagnostics: [{
        severity: 'error', code: 'skill-accept-no-name', phase: 'cli',
        message: 'skill accept requires a name: skill accept <name> [<proposalId>] [--force] [--apply]',
      }],
      code: 3,
    };
  }

  const proposalId = args && Array.isArray(args.positionals) && typeof args.positionals[1] === 'string'
    ? args.positionals[1] : undefined;
  const force = !!(args && args.force);
  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  const apply = !!(args && args.apply);
  const env = deps.env ?? process.env;

  // Write gate: --apply enables the write; HARNESS_MGR_ENABLE_WRITES=0 is an explicit
  // opt-out lock. A closed gate REFUSES here — before loading paths.mjs / the engine.
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
  const gate = await resolveAcceptGate(intent.enableWrites, deps.loadPaths);
  if (gate.error) return gate.error;
  const assertWritable = gate.assertWritable;

  const acceptFn = deps.acceptFn ?? acceptProposal;
  // The engine boundary is a seam: acceptProposal is proven never-throws/never-
  // rejects, but guarding the await keeps the handler total even against a buggy
  // or injected seam — a throw/reject degrades to a clean error result.
  let r;
  try {
    r = await acceptFn({
      name,
      proposalId,
      targetClaudeDir: ctx.configDir,
      mgrStateDir: ctx.mgrStateDir,
      assertWritable,
      enableWrites: intent.enableWrites,
      force,
      reason,
      pid: process.pid,
    });
  } catch (err) {
    return {
      result: { status: 'error' },
      diagnostics: [{
        severity: 'error', code: 'skill-accept-unexpected-error', phase: 'cli',
        message: `skill accept failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      }],
      code: 1,
    };
  }

  const o = r && typeof r === 'object' ? r : {};
  // SECRET-SAFE: redact the WHOLE summary AND the diagnostics before returning.
  return {
    result: redactSecretsDeep(summarizeAccept(o)),
    diagnostics: /** @type {Diagnostic[]} */ (redactSecretsDeep(Array.isArray(o.diagnostics) ? o.diagnostics.slice() : [])),
    code: acceptExitCode(o),
  };
}
