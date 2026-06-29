/**
 * Resolve the ~/.claude directory under governance, honoring CLAUDE_CONFIG_DIR.
 *
 * FIRST-PARTY: harness-mgr ships its own resolver so the CLI stays self-contained.
 * (Earlier this logic was borrowed at runtime from ~/.claude/hooks/lib via
 * reexport.mjs, which made the tool non-portable — it only ran on a machine where
 * oh-my-claudecode had installed those hooks. See lib/reexport.mjs for the history.)
 *
 * Zero npm dependencies (node:os / node:path stdlib only). Never throws.
 */

import { homedir } from 'node:os';
import { join, normalize, parse, sep } from 'node:path';

/** Drop a single trailing path separator, but never reduce a filesystem root. */
function stripTrailingSep(p) {
  if (!p.endsWith(sep)) return p;
  return p === parse(p).root ? p : p.slice(0, -1);
}

/**
 * The ~/.claude directory being governed. Honors CLAUDE_CONFIG_DIR:
 *   - unset / blank      → <home>/.claude
 *   - '~'                → <home>
 *   - '~/x' or '~\\x'    → <home>/x
 *   - any other value    → that value, normalized
 * The result is normalized with a single trailing separator stripped (but a bare
 * filesystem root like `C:\` or `/` is preserved).
 *
 * @returns {string}
 */
export function getClaudeConfigDir() {
  const home = homedir();
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();

  if (!configured) return stripTrailingSep(normalize(join(home, '.claude')));
  if (configured === '~') return stripTrailingSep(normalize(home));
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return stripTrailingSep(normalize(join(home, configured.slice(2))));
  }
  return stripTrailingSep(normalize(configured));
}
