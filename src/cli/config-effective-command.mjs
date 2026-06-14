/**
 * `config show-effective` command handler (P6 TOML wave, unit 2 — extracted from
 * commands.mjs along the hooks-command.mjs / ops-commands.mjs precedent).
 *
 * Target-aware via descriptor.configSource:
 *   - 'settings-merge' (Claude / default) — the merged settings layers + per-key
 *     provenance, with `--key`/`--explain`. This path is MOVED VERBATIM from
 *     commands.mjs (byte-identical, pinned by the existing config-show-effective
 *     tests) — the security-audited redaction path is untouched.
 *   - 'toml-file' (Codex) — the single config.toml is ONE source (no layering/merge),
 *     so the result is just `{ effective }` (no `keys` provenance, no `--explain`
 *     per-layer). `--key a.b` navigates into it. A parse error → a warn; a missing
 *     config.toml → benign empty.
 *
 * SECRET-SAFE: BOTH paths redact through the SAME redactEffective/redactKeyedValue —
 * env values + sensitive-named keys (token/secret/key/password/credential/auth) at
 * any depth + token-shaped string leaves become `{redacted, sha256}` BEFORE the
 * result is returned, so every output format is uniformly safe. (Codex config.toml
 * in practice stores env-var NAMES + references, not inline secret values; the
 * over-redaction of token/key-named fields is belt-and-suspenders.)
 *
 * Never throws. M2-safe (no paths.mjs — node:path + discovery readers only).
 * Zero npm dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { readSettingsLayers } from './settings-layers.mjs';
import { mergeSettings, explainEffective } from '../analysis/settings-merge.mjs';
import { readTomlFile } from '../discovery/read-toml.mjs';
import { redactEffective, redactKeysMap, redactMergeEntry, redactKeyedValue } from '../analysis/redact-effective.mjs';

/**
 * @typedef {import('./commands.mjs').CommandContext} CommandContext
 * @typedef {import('./commands.mjs').CommandOutput} CommandOutput
 */

/** The default config source when a descriptor is absent or lacks a usable configSource. */
const DEFAULT_SOURCE = Object.freeze({ kind: 'settings-merge' });

/** True for a non-null, non-array object. @param {unknown} v */
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * The configSource of a descriptor, or the settings-merge default. A toml-file
 * source must carry a string `file`; anything else degrades to settings-merge.
 * @param {unknown} descriptor
 * @returns {{kind: string, file?: string}}
 */
function configSourceOf(descriptor) {
  const src = descriptor && /** @type {any} */ (descriptor).configSource;
  if (isObj(src) && src.kind === 'toml-file' && typeof src.file === 'string') return src;
  return DEFAULT_SOURCE;
}

/**
 * The merged effective settings (Claude) or the parsed config.toml (Codex).
 * @param {CommandContext} ctx
 * @returns {CommandOutput}
 */
export function configShowEffectiveCommand(ctx) {
  const source = configSourceOf(ctx.descriptor);
  if (source.kind === 'toml-file') return tomlEffective(ctx, source);

  const layers = readSettingsLayers(ctx.configDir);
  const m = mergeSettings(layers.layers);
  const diagnostics = [...layers.diagnostics, ...m.diagnostics];
  const explain = !!(ctx.args && ctx.args.explain);

  const key = ctx.args && ctx.args.key;
  if (typeof key === 'string' && key.length > 0) {
    const segments = key.split('.');
    const sourceKeys = explain ? explainEffective(layers.layers).keys : m.keys;
    const result = { key, merge: redactMergeEntry(segments[0], sourceKeys[segments[0]] ?? null), value: redactKeyedValue(segments, navigate(m.effective, segments)) };
    return { result, diagnostics };
  }

  if (explain) {
    const ex = explainEffective(layers.layers);
    return { result: { explain: true, effective: redactEffective(m.effective), keys: redactKeysMap(ex.keys) }, diagnostics };
  }

  return { result: { effective: redactEffective(m.effective), keys: redactKeysMap(m.keys) }, diagnostics };
}

/**
 * The Codex `toml-file` effective-config path: read config.toml, redact, return
 * `{ effective }` (single source → no `keys`/merge provenance). `--key` navigates
 * into the parsed config. A parse error surfaces a warn; a missing file is benign.
 * @param {CommandContext} ctx
 * @param {{file: string}} source
 * @returns {CommandOutput}
 */
function tomlEffective(ctx, source) {
  // A missing config.toml is benign (value stays null → empty effective, no
  // diagnostic); only a parse error surfaces a warn.
  const { value, error } = readTomlFile(join(ctx.configDir, source.file));
  const diagnostics = error
    ? [{ severity: 'warn', code: 'config-toml-invalid', message: `${source.file}: ${error}`, phase: 'discovery' }]
    : [];
  const config = isObj(value) ? value : {};

  const key = ctx.args && ctx.args.key;
  if (typeof key === 'string' && key.length > 0) {
    const segments = key.split('.');
    return { result: { key, value: redactKeyedValue(segments, navigate(config, segments)) }, diagnostics };
  }
  return { result: { effective: redactEffective(config) }, diagnostics };
}

/**
 * Walk an object down a path of segments. Returns undefined the moment the path
 * leaves a real object — total and never throws.
 * @param {unknown} obj @param {string[]} segments @returns {unknown}
 */
function navigate(obj, segments) {
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = /** @type {Record<string, unknown>} */ (cur)[seg];
  }
  return cur;
}
