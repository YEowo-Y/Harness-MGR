/**
 * Codex config.toml probe (P6 codex doctor: #26/#27).
 *
 * A PASSIVE I/O gatherer — reads only, never spawns, never writes. It is the
 * fact-gathering half for the two codex-specific doctor checks the pure
 * codex-checks.mjs judges:
 *   #26 config-toml-valid — was config.toml parseable? (tomlError)
 *   #27 trust-overbroad   — which [projects."P"] tables trust an overbroad path?
 *
 * codex keeps its whole config in `~/.codex/config.toml`. The `[projects."<path>"]`
 * tables each carry a `trust_level` ("trusted"/"untrusted"/absent); a project whose
 * path transitively trusts the whole home dir (or a drive root) is the #27 signal.
 *
 * This gather is only invoked for a codex target (doctor-facts gates it on
 * descriptor.id === 'codex'); a Claude run never touches it.
 *
 * --- M2-safe ---
 * Imports ONLY ./read-toml.mjs + node:path — NEVER paths.mjs (its top-level await
 * would break the missing-hooks-lib fallback). The home dir is passed IN by the
 * caller (resolved via node:os there), not read here.
 *
 * Zero npm dependencies. Node stdlib only. Never throws.
 */

import { join } from 'node:path';
import { readTomlFile } from './read-toml.mjs';

/**
 * @typedef {Object} CodexConfigFacts
 * @property {string|null} tomlError       the readTomlFile error (parse/read), or null when valid/missing
 * @property {string[]} trustedProjects    every `[projects."P"]` key whose table has trust_level === 'trusted'
 * @property {string} homeDir              passed through (the OS home dir) for #27's overbroad judgment
 */

/** Prototype-polluting keys to skip when iterating a parsed table, defensively. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Gather codex config.toml facts: parse-validity + the trusted-project list.
 *
 * A missing config.toml is benign: tomlError null + trustedProjects []. A parse/read
 * error surfaces as tomlError set (judged into a #26 ERROR) — trustedProjects stays
 * [] because there is no parsed table to read. Never throws.
 *
 * @param {{ configDir: string, homeDir: string }} opts
 * @returns {{ codexConfig: CodexConfigFacts, diagnostics: import('../lib/diagnostic.mjs').Diagnostic[] }}
 */
export function gatherCodexConfig(opts) {
  // `|| {}` (not a destructuring default, which only catches `undefined`) so a
  // literal `null` opts also degrades safely — honors the never-throws contract.
  const { configDir, homeDir } = opts || {};
  /** @type {import('../lib/diagnostic.mjs').Diagnostic[]} */
  const diagnostics = [];
  const home = typeof homeDir === 'string' ? homeDir : '';

  let file;
  try {
    file = join(typeof configDir === 'string' ? configDir : '', 'config.toml');
  } catch {
    return { codexConfig: { tomlError: null, trustedProjects: [], homeDir: home }, diagnostics };
  }

  const res = readTomlFile(file);
  // A missing file is benign (no config trust to judge). A read/parse error becomes
  // a tomlError #26 will escalate; we do NOT also emit a gather diagnostic for it
  // (the doctor #26 finding is the user-facing surface).
  const tomlError = res.missing ? null : (typeof res.error === 'string' ? res.error : null);
  const trustedProjects = tomlError ? [] : collectTrustedProjects(res.value);

  return { codexConfig: { tomlError, trustedProjects, homeDir: home }, diagnostics };
}

/**
 * Collect every key of the parsed `config.projects` table whose value is an object
 * carrying `trust_level === 'trusted'`. parseToml output is Object.create(null), so
 * Object.keys is proto-safe; we still skip __proto__/constructor/prototype defensively.
 * @param {*} parsed  the parseToml root (Object.create(null)) or null
 * @returns {string[]}
 */
function collectTrustedProjects(parsed) {
  /** @type {string[]} */
  const out = [];
  if (!parsed || typeof parsed !== 'object') return out;
  const projects = parsed.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return out;
  for (const key of Object.keys(projects)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const table = projects[key];
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    if (table.trust_level === 'trusted') out.push(key);
  }
  return out;
}
