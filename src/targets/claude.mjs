/**
 * Claude Code target descriptor (P6.U1).
 *
 * This descriptor SINGLE-SOURCES the live discovery/ consts so that a future
 * consumer (U2 orphan-detector, U3 inventory) reading the descriptor instead of
 * its hardwired const reproduces today's behavior BYTE-FOR-BYTE.
 *
 *   - knownTopFiles    is the SAME REFERENCE (===) as KNOWN_TOP_FILES.
 *   - knownTopFilePatterns is the SAME REFERENCE (===) as KNOWN_TOP_FILE_PATTERNS.
 *   - knownTopDirs     is the UNION the orphan-detector itself builds
 *                      (ALL_KNOWN_TOP_DIRS = [...KNOWN_TOP_DIRS, ...KNOWN_ECOSYSTEM_TOP_DIRS]).
 *                      A fresh array (the const sources are two separate exports),
 *                      pinned to that exact union by the single-source drift-guard test.
 *
 * Pure / never-throws / frozen / zero npm deps. Imports only frozen pure consts
 * from discovery/ (NOT paths.mjs — that top-level-awaits and is async).
 */

import { KNOWN_TOP_DIRS } from '../discovery/settings.mjs';
import {
  KNOWN_TOP_FILES,
  KNOWN_TOP_FILE_PATTERNS,
  KNOWN_ECOSYSTEM_TOP_DIRS,
} from '../discovery/orphan-detector.mjs';

/** @typedef {import('./descriptor.mjs').TargetDescriptor} TargetDescriptor */

/** @type {TargetDescriptor} */
export const claudeDescriptor = Object.freeze({
  id: 'claude',
  label: 'Claude Code',
  defaultHomeSubdir: '.claude',
  signatureFile: 'settings.json',
  componentKinds: Object.freeze([
    Object.freeze({ kind: 'skill', dir: 'skills', layout: 'skill-md' }),
    Object.freeze({ kind: 'agent', dir: 'agents', layout: 'flat-md' }),
    Object.freeze({ kind: 'command', dir: 'commands', layout: 'flat-md' }),
  ]),
  governedConfigFiles: Object.freeze([
    'settings.json', 'settings.local.json', '.mcp.json', 'CLAUDE.md',
  ]),
  // The UNION the orphan detector consumes (ALL_KNOWN_TOP_DIRS).
  knownTopDirs: Object.freeze([...KNOWN_TOP_DIRS, ...KNOWN_ECOSYSTEM_TOP_DIRS]),
  // SAME REFERENCE (===) — single-sourced, drift-guarded.
  knownTopFiles: KNOWN_TOP_FILES,
  knownTopFilePatterns: KNOWN_TOP_FILE_PATTERNS,
  // Claude hooks come from the MERGED settings layers (settings.json + .local).
  hookSource: Object.freeze({ kind: 'settings-merge' }),
  // Claude effective config = the merged settings layers (same source as hooks).
  configSource: Object.freeze({ kind: 'settings-merge' }),
  // Claude MCP servers come from JSON: project .mcp.json + user-scope appFile.
  mcpSource: Object.freeze({ kind: 'json-files' }),
  // Claude plugins come from plugins/installed_plugins.json (schema v2).
  pluginSource: Object.freeze({ kind: 'json-file' }),
  // Enable signal = the merged settings enabledPlugins map; the install record's own
  // `enabled` flag is unreliable (false even for active plugins), so it is ignored.
  pluginEnableModel: 'settings-map',
});
