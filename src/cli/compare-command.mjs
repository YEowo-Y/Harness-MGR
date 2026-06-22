/**
 * `compare` command — cross-target presence report (analysis-only, never writes).
 *
 * Unlike every other read command (which scans ONE target via ctx.descriptor +
 * ctx.configDir), compare scans BOTH targets and diffs them. It resolves the second
 * target's config dir as a SIBLING of the active one — `~/.claude` and `~/.codex`
 * share a home, so `join(dirname(ctx.configDir), other.defaultHomeSubdir)` finds it
 * with pure string ops (no home lookup, no async resolveTargetAndConfig). This also
 * makes it hermetic: a test pointing --config-dir at `sandbox/.claude` automatically
 * compares against `sandbox/.codex`.
 *
 * The pure diff lives in src/analysis/compare.mjs. This handler does only I/O:
 * two scan() calls + a dir-exists probe (so a zero count reads as "not installed"
 * rather than "empty"). It does NOT merge the per-target scan diagnostics into the
 * report — those are target-unattributed here and belong to `inventory --target X`;
 * instead it surfaces a single `compare-scan-degraded` warn per side that scanned
 * with errors. Never throws.
 */

import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { scan } from '../discovery/scan.mjs';
import { TARGETS } from '../targets/descriptor.mjs';
import { analyzeCompare } from '../analysis/compare.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('./commands.mjs').CommandContext} CommandContext
 */

/**
 * Compare component / mcp / plugin presence between the active target and every
 * other known target. `args.detail` controls only the human render (the full
 * divergence list); the json/ndjson envelope always carries the complete `items`.
 * @param {CommandContext} ctx
 * @returns {{ result: object, diagnostics: Diagnostic[] }}
 */
export function compareCommand(ctx) {
  const args = (ctx && ctx.args) || {};
  const active = ctx && ctx.descriptor && typeof ctx.descriptor === 'object' ? ctx.descriptor : null;
  const activeDir = ctx && typeof ctx.configDir === 'string' ? ctx.configDir : '';
  const home = activeDir.length > 0 ? dirname(activeDir) : '';

  // Ordered side list: active target first (honors --target/--config-dir), then
  // each OTHER known target as a sibling of the active config dir.
  const specs = [];
  if (active) specs.push({ descriptor: active, configDir: activeDir });
  for (const id of Object.keys(TARGETS)) {
    const d = TARGETS[id];
    if (!d || (active && d.id === active.id)) continue;
    specs.push({ descriptor: d, configDir: home ? join(home, d.defaultHomeSubdir) : '' });
  }

  /** @type {Diagnostic[]} */
  const extra = [];
  const sides = specs.map((spec) => {
    const s = scan({ targetClaudeDir: spec.configDir, descriptor: spec.descriptor });
    const id = spec.descriptor.id;
    if (!dirExists(spec.configDir)) {
      extra.push({ severity: 'info', code: 'compare-target-absent', phase: 'compare', message: `target ${id} config dir not found at ${spec.configDir || '(unresolved)'} -- treated as empty` });
    } else {
      const errCount = s.diagnostics.filter((d) => d && d.severity === 'error').length;
      if (errCount > 0) extra.push({ severity: 'warn', code: 'compare-scan-degraded', phase: 'compare', message: `scan of ${id} reported ${errCount} error(s); run \`inventory --target ${id}\` for detail` });
    }
    return { id, label: spec.descriptor.label, components: s.components, plugins: s.plugins, mcpServers: s.mcpServers };
  });

  const { summary, diagnostics } = analyzeCompare(sides);
  summary.detail = !!args.detail;
  return { result: summary, diagnostics: [...diagnostics, ...extra] };
}

/** Never-throws "is this an existing directory" probe. @param {string} p @returns {boolean} */
function dirExists(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  try { return statSync(p).isDirectory(); } catch { return false; }
}
