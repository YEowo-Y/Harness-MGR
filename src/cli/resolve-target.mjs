/**
 * Target + config-dir resolution for the CLI boundary (P6.U2b).
 *
 * One decision: WHICH harness (claude / codex) is governed, and from WHICH
 * directory. This sits in front of resolve-config.mjs and DELEGATES the actual
 * `~/.claude` resolution (and its M2 missing-hooks-lib fallback) back to it.
 *
 * --- How the descriptor is picked ---
 *   1. an explicit `--target` (validated by cli.mjs first) → that descriptor.
 *   2. else an explicit `--config-dir` → auto-detect by probing the descriptor's
 *      signatureFile (codex's `config.toml`) inside that dir.
 *   3. else → the claude descriptor (the default harness).
 *
 * --- How the config dir is resolved ---
 *   - CODEX with no explicit `--config-dir`: `join(homedir(), '.codex')` directly.
 *     This path NEVER touches paths.mjs (paths.mjs is the CC loader, hard-wired to
 *     ~/.claude; importing it would be wrong for codex). Keeping this module
 *     paths.mjs-free is also the M2-safe property the boundary self-check enforces.
 *     mgrStateDir is the codex-rooted `.mgr-state`.
 *   - everything else: DELEGATE to resolveConfigDir({configDir, loadPaths}), which
 *     owns the explicit-override branch AND the live paths.mjs import (the ONLY
 *     dynamic-import path; this module's static graph stays paths.mjs-free — the
 *     M2-safe property the boundary self-check enforces).
 *
 * Never throws (outer guard). Zero npm deps; node stdlib only.
 */

import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfigDir } from './resolve-config.mjs';
import { resolveTarget, TARGETS } from '../targets/descriptor.mjs';
import { claudeDescriptor } from '../targets/claude.mjs';
import { codexDescriptor } from '../targets/codex.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../targets/descriptor.mjs').TargetDescriptor} TargetDescriptor
 */

/**
 * @typedef {Object} ResolvedTarget
 * @property {TargetDescriptor} descriptor   the active target descriptor (always set)
 * @property {string} configDir              the governed config directory
 * @property {string} mgrStateDir            harness-mgr's own state dir (configDir/.mgr-state)
 * @property {Diagnostic[]} diagnostics
 */

/** The .mgr-state dir name — kept as a LOCAL literal so this module never statically imports paths.mjs (M2). */
const MGR_STATE_DIRNAME = '.mgr-state';

/**
 * Is `target` a known descriptor id ('claude'|'codex')? Own-property lookup only,
 * so 'constructor'/'__proto__'/'prototype' resolve to false (proto-safe).
 * @param {unknown} target
 * @returns {boolean}
 */
export function isKnownTarget(target) {
  return (typeof target === 'string') && Object.prototype.hasOwnProperty.call(TARGETS, target);
}

/**
 * A never-throws statSync(p).isFile() probe — false on any error (ENOENT, EACCES,
 * a directory, a non-string path). The default fs seam for auto-detect.
 * @param {string} p
 * @returns {boolean}
 */
function defaultStatIsFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Pick the active descriptor from the explicit target, else auto-detect from the
 * config dir, else the claude default.
 * @param {string|undefined} target
 * @param {string|undefined} configDir
 * @param {(p: string) => boolean} statFn
 * @returns {TargetDescriptor}
 */
function pickDescriptor(target, configDir, statFn) {
  if (typeof target === 'string' && target.length > 0) {
    // cli.mjs validates the target before we get here, so an unknown id should not
    // reach this module; defensively fall back to claude if resolveTarget returns
    // undefined (NEVER silently mis-route).
    return resolveTarget({ target }) ?? claudeDescriptor;
  }
  if (typeof configDir === 'string' && configDir.length > 0) {
    return autoDetect(configDir, statFn);
  }
  return claudeDescriptor;
}

/**
 * Auto-detect the descriptor by probing whether the codex signatureFile
 * ('config.toml') exists as a FILE directly inside `configDir`. Present → codex;
 * else → claude (the default). Only codex has a distinguishing signature file in
 * this batch, so this is a single probe.
 * @param {string} configDir
 * @param {(p: string) => boolean} statFn
 * @returns {TargetDescriptor}
 */
function autoDetect(configDir, statFn) {
  const sig = join(configDir, codexDescriptor.signatureFile);
  return statFn(sig) ? codexDescriptor : claudeDescriptor;
}

/**
 * Resolve the active target descriptor AND its governed config dir.
 *
 * Seams (all injectable for hermetic tests):
 *   - homeFn   : () => string         overrides os.homedir() (codex home root)
 *   - statFn   : (p) => boolean        overrides the auto-detect file probe
 *   - loadPaths: () => Promise<…>      forwarded to resolveConfigDir (paths.mjs seam)
 *
 * @param {{target?: string, configDir?: string, loadPaths?: Function, homeFn?: () => string, statFn?: (p: string) => boolean}} [opts]
 * @returns {Promise<ResolvedTarget>}
 */
export async function resolveTargetAndConfig({ target, configDir, loadPaths, homeFn, statFn } = {}) {
  try {
    const stat = typeof statFn === 'function' ? statFn : defaultStatIsFile;
    const descriptor = pickDescriptor(target, configDir, stat);

    // CODEX with no explicit config dir: resolve from homedir()/.codex directly —
    // NEVER import paths.mjs (it is the CC loader, wrong for codex); staying
    // paths.mjs-free is also the M2-safe property the boundary self-check enforces.
    if (descriptor.id === 'codex' && !(typeof configDir === 'string' && configDir.length > 0)) {
      const home = typeof homeFn === 'function' ? homeFn() : homedir();
      const cd = join(home, descriptor.defaultHomeSubdir);
      return { descriptor, configDir: cd, mgrStateDir: join(cd, MGR_STATE_DIRNAME), diagnostics: [] };
    }

    // CLAUDE (or codex WITH an explicit --config-dir): delegate to resolveConfigDir,
    // which owns the explicit-override branch + the live paths.mjs dynamic import.
    const cfg = await resolveConfigDir({ configDir, loadPaths });
    return { descriptor, configDir: cfg.configDir, mgrStateDir: cfg.mgrStateDir, diagnostics: cfg.diagnostics };
  } catch {
    // Never-throws boundary: degrade to the claude default rooted at the home dir.
    const home = typeof homeFn === 'function' ? homeFn() : homedir();
    const cd = join(home, claudeDescriptor.defaultHomeSubdir);
    return { descriptor: claudeDescriptor, configDir: cd, mgrStateDir: join(cd, MGR_STATE_DIRNAME), diagnostics: [] };
  }
}
