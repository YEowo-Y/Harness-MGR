/**
 * Single funnel for harness-mgr's ~/.claude config-dir resolution. The discovery /
 * ops / paths layers import getClaudeConfigDir FROM HERE (paths.mjs re-exports it
 * onward), so there is exactly one source of truth for "which ~/.claude is governed".
 *
 * --- History (why this file is named "reexport") ---
 * config-dir resolution was once BORROWED at runtime from ~/.claude/hooks/lib via a
 * dynamic import() — an async shim (homedir() → a file:// URL → top-level await). That
 * made the CLI non-portable: it only ran where oh-my-claudecode had installed those
 * hooks, so CI and any fresh clone failed at load with ERR_MODULE_NOT_FOUND. It is now
 * FIRST-PARTY (lib/config-dir.mjs), so this module is a plain SYNCHRONOUS re-export and
 * the whole downstream graph loads synchronously. (The old shim also re-exported an
 * atomic-write primitive that NO in-tree module consumed — the governed write path uses
 * src/ops/atomic-write.mjs — so it was dropped rather than vendored.) The "reexport"
 * name is kept so the downstream imports stay unchanged.
 *
 * Zero npm dependencies. Node stdlib only.
 */

export { getClaudeConfigDir } from './config-dir.mjs';
