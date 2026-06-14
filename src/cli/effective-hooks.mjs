/**
 * Target-aware effective-hooks source (P6.U4).
 *
 * The hook walkers (discovery/probe-hooks, analysis/hook-explain) consume ONE
 * shape: the merged `{ [event]: [{ matcher?, hooks: [{type:'command', command}] }] }`
 * map. WHERE that map comes from differs per target:
 *
 *   - Claude  (descriptor.hookSource.kind === 'settings-merge', the DEFAULT) —
 *     the merged settings layers' `hooks` field (settings.json + settings.local.json).
 *   - Codex   (kind === 'json-file') — a standalone top-level `hooks.json` whose
 *     `.hooks` pointer holds a shape-compatible map (the `state` sibling is ignored).
 *
 * This module is the single dispatch point. Both callers (hooks-command.mjs and
 * doctor-facts.mjs) read the hooks map through it, so they stay target-agnostic.
 *
 * BYTE-IDENTICAL for Claude: with no descriptor (or any non-json-file source) and
 * no pre-merged `effective`, it reproduces the pre-U4 hooks-command merge exactly
 * — same `(merged.effective && .hooks) || {}` and same `[...layers, ...merge]`
 * diagnostics order. Passing the already-merged `effective` (the doctor does this)
 * short-circuits the re-merge and returns no settings diagnostics (the doctor
 * surfaces settings facts via its own checks, not here).
 *
 * Never throws. Reads files only through the never-throws readJsoncFile (which
 * refuses to follow a symlink out of the config dir). Paths.mjs-free (M2-safe) —
 * the same static import set hooks-command.mjs / doctor-facts.mjs already use.
 *
 * Zero npm dependencies. Node stdlib only.
 */

import { join } from 'node:path';
import { readJsoncFile, isJsonObject } from '../discovery/read-json.mjs';
import { readSettingsLayers } from './settings-layers.mjs';
import { mergeSettings } from '../analysis/settings-merge.mjs';

/**
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('../targets/descriptor.mjs').TargetDescriptor} TargetDescriptor
 */

/** The default source when a descriptor is absent or lacks a usable hookSource. */
const DEFAULT_SOURCE = Object.freeze({ kind: 'settings-merge' });

/**
 * Guard against prototype-polluting keys when reading a pointer out of parsed JSON.
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * The hookSource of a descriptor, or the settings-merge default. A json-file source
 * must carry a string `file`; anything else degrades to the settings-merge default
 * (NEVER silently treat a malformed descriptor as a file read).
 * @param {TargetDescriptor|undefined|null} descriptor
 * @returns {import('../targets/descriptor.mjs').HookSource}
 */
function hookSourceOf(descriptor) {
  const src = descriptor && descriptor.hookSource;
  if (isJsonObject(src) && src.kind === 'json-file' && typeof src.file === 'string') return src;
  return DEFAULT_SOURCE;
}

/**
 * Pluck the hooks map out of a container by key, normalising to {} when absent or
 * falsy. Mirrors the pre-U4 `(container && container.hooks) || {}` expression so a
 * truthy-non-object value flows through unchanged (the walkers tolerate it).
 * @param {unknown} container
 * @param {string} key
 * @returns {object}
 */
function pluckHooks(container, key) {
  if (!isJsonObject(container) || !isSafeKey(key)) return {};
  return container[key] || {};
}

/**
 * Read a json-file hook source ({configDir}/{file} → .{pointer}). A missing file
 * is benign (no hooks configured → {} with no diagnostic, mirroring an absent
 * settings.hooks). A read/parse error surfaces ONE warn and an empty map. The
 * `state` (or any other) sibling key in the file is ignored — only the pointer
 * field is returned.
 * @param {string} configDir
 * @param {import('../targets/descriptor.mjs').HookSource} source
 * @returns {{ hooks: object, diagnostics: Diagnostic[] }}
 */
function readJsonFileHooks(configDir, source) {
  const file = join(configDir, source.file);
  const res = readJsoncFile(file);
  if (res.missing) return { hooks: {}, diagnostics: [] };
  if (res.error) {
    return { hooks: {}, diagnostics: [{ severity: 'warn', code: 'hooks-file-invalid', message: `${file}: ${res.error}`, phase: 'discovery' }] };
  }
  const pointer = typeof source.pointer === 'string' ? source.pointer : 'hooks';
  return { hooks: pluckHooks(res.value, pointer), diagnostics: [] };
}

/**
 * Read the merged settings-layer hooks. When the caller already merged settings
 * (the doctor passes `effective`), reuse it with no further I/O and no diagnostics;
 * otherwise merge here and return the layer + merge diagnostics (the hooks command
 * path — byte-identical to the pre-U4 merge).
 * @param {string} configDir
 * @param {unknown} effective  optional pre-merged effective settings
 * @returns {{ hooks: object, diagnostics: Diagnostic[] }}
 */
function readSettingsMergeHooks(configDir, effective) {
  if (isJsonObject(effective)) return { hooks: pluckHooks(effective, 'hooks'), diagnostics: [] };
  const layers = readSettingsLayers(configDir);
  const merged = mergeSettings(layers.layers);
  return { hooks: pluckHooks(merged.effective, 'hooks'), diagnostics: [...layers.diagnostics, ...merged.diagnostics] };
}

/**
 * Resolve the effective hooks map for a target, plus the diagnostics from reading
 * its source. Dispatches on the descriptor's hookSource (settings-merge default).
 *
 * @param {{ configDir: string, descriptor?: TargetDescriptor, effective?: unknown }} [opts]
 *   configDir   — the governed config root.
 *   descriptor  — the active target descriptor; absent → settings-merge default.
 *   effective   — OPTIONAL pre-merged settings (settings-merge source only): when an
 *                 object, reuse it instead of re-reading/merging (no diagnostics).
 * @returns {{ hooks: object, diagnostics: Diagnostic[] }}
 */
export function gatherEffectiveHooks(opts) {
  try {
    const { configDir, descriptor, effective } = opts ?? {};
    const source = hookSourceOf(descriptor);
    if (source.kind === 'json-file') return readJsonFileHooks(configDir, source);
    return readSettingsMergeHooks(configDir, effective);
  } catch {
    // never-throws backstop: a misbehaving reader degrades to an honest empty map.
    return { hooks: {}, diagnostics: [] };
  }
}
