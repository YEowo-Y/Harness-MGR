/**
 * Schema-canary fact gatherer (P3 gate infrastructure).
 *
 * THIN I/O gather — pure/IO split per [[feedback-pure-analysis-split]].
 * All computation lives in src/selftest/schema-canary.mjs (pure).
 *
 * Gathers the 6 schema-surface dimensions:
 *   1. pluginSchemaVersion  — numeric version field of installed_plugins.json
 *   2. settingsKeys         — top-level KEY NAMES of settings.json (JSONC-tolerant)
 *   3. topDirs              — top-level dir names; REUSED from scanResult.topDirs
 *   4. hookEvents           — hook event KEY NAMES from settings.json hooks object
 *   5. mcpServerCount+transports — REUSED from scanResult.mcpServers
 *   6. appKeys              — top-level KEY NAMES of ~/.claude.json
 *
 * M2-SAFE: does NOT import paths.mjs.
 * appFile resolved via node:os homedir() or the injected appFile seam.
 * Proto-key guard on every Object.keys call.
 * Never throws; missing files → benign empty sets.
 *
 * @typedef {import('../lib/diagnostic.mjs').Diagnostic} Diagnostic
 * @typedef {import('./scan.mjs').ScanResult} ScanResult
 * @typedef {import('../selftest/schema-canary.mjs').SchemaFacts} SchemaFacts
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';
import { DiagnosticBag } from '../lib/diagnostic.mjs';
import { readJsonFile, readJsoncFile } from './read-json.mjs';

const POISON = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * True for a non-null plain object.
 * @param {unknown} v
 * @returns {boolean}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Safe string-key extractor. Returns sorted non-poisoned key names.
 * @param {unknown} obj
 * @returns {string[]}
 */
function safeKeys(obj) {
  if (!isObj(obj)) return [];
  return Object.keys(/** @type {object} */ (obj))
    .filter((k) => !POISON.has(k))
    .sort();
}

// ── per-dimension helpers ─────────────────────────────────────────────────────

/**
 * Read installed_plugins.json and return its numeric `version` field.
 * Returns null on any error/miss.
 * @param {string} configDir
 * @param {(p:string) => import('./read-json.mjs').JsonReadResult} readJsonFn
 * @returns {number|null}
 */
function readPluginSchemaVersion(configDir, readJsonFn) {
  const p = join(configDir, 'plugins', 'installed_plugins.json');
  const { value, missing } = readJsonFn(p);
  if (missing || !isObj(value)) return null;
  const v = /** @type {Record<string,unknown>} */ (value).version;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

/**
 * Read settings.json via JSONC parser and return top-level key names + hook events.
 * @param {string} configDir
 * @param {(p:string) => import('./read-json.mjs').JsoncReadResult} readJsoncFn
 * @returns {{ settingsKeys: string[], hookEvents: string[] }}
 */
function readSettingsDims(configDir, readJsoncFn) {
  const p = join(configDir, 'settings.json');
  const { value } = readJsoncFn(p);
  if (!isObj(value)) return { settingsKeys: [], hookEvents: [] };
  const obj = /** @type {Record<string, unknown>} */ (value);
  const settingsKeys = safeKeys(obj);
  const hooks = obj.hooks;
  const hookEvents = isObj(hooks) ? safeKeys(hooks) : [];
  return { settingsKeys, hookEvents };
}

/**
 * Extract topDirs from a ScanResult: present `known` names UNION `unknown` names.
 * @param {ScanResult|undefined|null} scanResult
 * @returns {string[]}
 */
function extractTopDirs(scanResult) {
  if (!scanResult || !isObj(scanResult.topDirs)) return [];
  const { known, unknown: unk } = /** @type {any} */ (scanResult.topDirs);

  const names = new Set();
  if (Array.isArray(known)) {
    for (const entry of known) {
      if (isObj(entry) && entry.present === true && typeof entry.name === 'string') {
        if (!POISON.has(entry.name)) names.add(entry.name);
      }
    }
  }
  if (Array.isArray(unk)) {
    for (const name of unk) {
      if (typeof name === 'string' && !POISON.has(name)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Extract mcp count + distinct transport set from ScanResult.
 * @param {ScanResult|undefined|null} scanResult
 * @returns {{ mcpServerCount: number, mcpTransports: string[] }}
 */
function extractMcpDims(scanResult) {
  if (!scanResult || !Array.isArray(scanResult.mcpServers)) {
    return { mcpServerCount: 0, mcpTransports: [] };
  }
  const servers = scanResult.mcpServers;
  const transports = new Set();
  for (const s of servers) {
    if (isObj(s) && typeof s.transport === 'string') transports.add(s.transport);
  }
  return { mcpServerCount: servers.length, mcpTransports: [...transports].sort() };
}

/**
 * Read top-level KEY NAMES of ~/.claude.json (the home-level app config).
 * @param {string} appFilePath
 * @param {(p:string) => import('./read-json.mjs').JsonReadResult} readJsonFn
 * @returns {string[]}
 */
function readAppKeys(appFilePath, readJsonFn) {
  const { value, missing } = readJsonFn(appFilePath);
  if (missing || !isObj(value)) return [];
  return safeKeys(/** @type {object} */ (value));
}

/**
 * Fallback: enumerate top-level dirs from the filesystem when scanResult is absent.
 * @param {string} configDir
 * @returns {string[]}
 */
function readTopDirsFromFs(configDir) {
  try {
    const entries = readdirSync(configDir, { withFileTypes: true });
    const dirs = [];
    for (const e of entries) {
      if (e.isDirectory() && !POISON.has(e.name)) dirs.push(e.name);
    }
    return dirs.sort();
  } catch {
    return [];
  }
}

/**
 * Resolve an effective ScanResult for topDirs + mcp dimensions.
 * Priority: explicit scanResult > scanFn call > null (triggers fs fallback).
 * Never throws — a failed scanFn returns null so callers degrade gracefully.
 *
 * @param {ScanResult|null} scanResult
 * @param {Function|null} scanFn
 * @param {string} configDir
 * @param {string|undefined} appFile
 * @returns {ScanResult|null}
 */
function resolveEffectiveScan(scanResult, scanFn, configDir, appFile) {
  if (scanResult) return scanResult;
  if (typeof scanFn !== 'function') return null;
  try {
    return scanFn({ targetClaudeDir: configDir, appFile, kinds: ['settings', 'mcp'] }) ?? null;
  } catch {
    return null;
  }
}

// ── main gather ───────────────────────────────────────────────────────────────

/**
 * Gather schema surface facts from configDir.
 *
 * When `opts.scanResult` is provided, topDirs and mcp dimensions are derived
 * from it (fast path). When absent, `scanFn` is called internally so every
 * call site gets consistent mcp + topDir data without requiring the caller to
 * pre-run a scan. An injectable `scanFn` seam keeps tests hermetic.
 *
 * @param {{
 *   configDir: string,
 *   appFile?: string,
 *   scanResult?: ScanResult|null,
 *   scanFn?: (opts: {targetClaudeDir: string, appFile?: string, kinds: string[]}) => ScanResult,
 *   readJsonFn?: (p:string) => import('./read-json.mjs').JsonReadResult,
 *   readJsoncFn?: (p:string) => import('./read-json.mjs').JsoncReadResult,
 * }} opts
 * @returns {{ facts: SchemaFacts, diagnostics: Diagnostic[] }}
 */
export function gatherSchemaFacts(opts) {
  const bag = new DiagnosticBag();
  const {
    configDir,
    appFile,
    scanResult = null,
    scanFn = null,
    readJsonFn = readJsonFile,
    readJsoncFn = readJsoncFile,
  } = opts ?? {};

  if (typeof configDir !== 'string' || configDir.length === 0) {
    bag.add({ severity: 'error', code: 'discover-bad-root', message: 'configDir must be a non-empty string', phase: 'probe-schema' });
    return { facts: emptyFacts(), diagnostics: bag.all() };
  }

  try {
    // Dim 1: plugin schema version
    const pluginSchemaVersion = readPluginSchemaVersion(configDir, readJsonFn);

    // Dims 2 + 4: settings keys + hook events
    const { settingsKeys, hookEvents } = readSettingsDims(configDir, readJsoncFn);

    // Resolve an effective scan result: caller-supplied wins; otherwise run scan
    // internally (settings + mcp kinds only — no need for a full component walk).
    // The fs-readdir fallback is retained only for tests that inject neither.
    const effectiveScan = resolveEffectiveScan(scanResult, scanFn, configDir, appFile);

    // Dim 3: top dirs (from scan or fs fallback)
    const topDirs = effectiveScan ? extractTopDirs(effectiveScan) : readTopDirsFromFs(configDir);

    // Dim 5: mcp count + transports (from scan or zero when fs-only)
    const { mcpServerCount, mcpTransports } = extractMcpDims(effectiveScan);

    // Dim 6: app keys from ~/.claude.json
    const resolvedAppFile = (typeof appFile === 'string' && appFile.length > 0)
      ? appFile
      : join(homedir(), '.claude.json');
    const appKeys = readAppKeys(resolvedAppFile, readJsonFn);

    /** @type {SchemaFacts} */
    const facts = {
      pluginSchemaVersion,
      settingsKeys,
      topDirs,
      hookEvents,
      mcpServerCount,
      mcpTransports,
      appKeys,
    };
    return { facts, diagnostics: bag.all() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    bag.add({ severity: 'error', code: 'probe-schema-failed', message: msg, phase: 'probe-schema' });
    return { facts: emptyFacts(), diagnostics: bag.all() };
  }
}

/** @returns {SchemaFacts} */
function emptyFacts() {
  return {
    pluginSchemaVersion: null,
    settingsKeys: [],
    topDirs: [],
    hookEvents: [],
    mcpServerCount: 0,
    mcpTransports: [],
    appKeys: [],
  };
}
