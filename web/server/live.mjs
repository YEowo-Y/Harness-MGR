/**
 * harness-mgr web — live-reload hub (P1).
 *
 * Watches each target's resolved config directory and broadcasts a coalesced
 * "change" signal to every connected SSE client. The browser turns that signal
 * into a `reloadKey` bump, so open views re-fetch the engine automatically when
 * you edit ~/.claude / ~/.codex elsewhere.
 *
 * SCOPE (per the agreed design): watch each configDir RECURSIVELY and FILTER OUT
 * high-churn paths the UI never surfaces (plugin node_modules, logs, caches,
 * snapshots, session transcripts, harness-mgr's own state). Filtering happens on
 * the emitted events — the OS-level recursive watch itself is cheap on Windows
 * (ReadDirectoryChangesW), so we do not enumerate the tree.
 *
 * READ-ONLY: this only observes the filesystem. It never writes, never spawns,
 * and adds zero engine changes — the watcher lives entirely in web/server.
 *
 * Never throws out of construction: a missing/unwatchable target dir is skipped,
 * not fatal, so the API stays up even if (say) ~/.codex does not exist.
 */

import { watch } from "node:fs";
import { resolveTargetAndConfig } from "../../src/cli/resolve-target.mjs";

/** The harnesses we watch — same two the read API serves. */
const TARGETS = Object.freeze(["claude", "codex"]);

/**
 * Path segments whose presence marks an event as noise — churn that is NOT the
 * governance config the UI reads, and would otherwise cause reload storms. Note
 * `projects/` (session transcripts, written constantly — including by the very
 * session that may be running this) and `.mgr-state` (our own snapshots).
 */
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "logs",
  "log",
  "statsig",
  "cache",
  "caches",
  "snapshots",
  ".mgr-state",
  ".mgr",
  "tmp",
  "history",
  "shell-snapshots",
  "projects",
  "todos",
  "ide",
  "__store",
  // codex runtime state (NOT governance config — config.toml + skills/agents are)
  "state",
  "process_manager",
]);

/**
 * High-churn root-level state/cache files the UI never surfaces. These sit at the
 * top of ~/.claude (no parent dir segment to catch them), so they need an explicit
 * name match — e.g. the per-command `bash-commands.log` / `cost-tracker.log` are
 * caught by the `.log` rule below, but these JSON caches need naming.
 */
const IGNORED_FILE_NAMES = new Set([
  "history.jsonl",
  "mcp-health-cache.json",
  "mcp-needs-auth-cache.json",
]);

/** Root-level file name PREFIXES that mark transient daemon/session state. */
const IGNORED_FILE_PREFIXES = ["daemon", "security_warnings_state_", ".last-"];

/** Live config file extensions — a file ending in one of these is never a backup. */
const CONFIG_EXT_RE = /\.(json|md|toml|ya?ml)$/;

/**
 * Is this change event noise we should drop? A null filename (some platforms omit
 * it) is treated as a real signal — better an extra refetch than a missed change.
 *
 * The bias is deliberate: for a realtime view a missed edit (stale UI) is worse
 * than a needless refetch, so this denylist filters only paths that are provably
 * NOT governance config — never the config types the UI reads (.md / settings*.json
 * / *.toml / plugin manifests all pass through).
 * @param {string|null|undefined} filename  the watcher's relative path
 * @returns {boolean}
 */
function isNoise(filename) {
  if (!filename) return false;
  const parts = filename.split(/[\\/]/);
  for (const part of parts) {
    if (IGNORED_SEGMENTS.has(part)) return true;
  }
  const base = (parts[parts.length - 1] ?? "").toLowerCase();
  // non-config file types that churn: logs (one write per command), lockfiles,
  // editor scratch / atomic-write temp files.
  if (
    base.endsWith(".log") ||
    base.endsWith(".lock") ||
    base.endsWith(".tmp") ||
    base.endsWith("~") ||
    // SQLite / DB temp + journal files (e.g. a plugin's workbench.sqlite3-wal)
    base.includes(".sqlite") ||
    base.endsWith("-wal") ||
    base.endsWith("-shm") ||
    base.endsWith("-journal")
  ) {
    return true;
  }
  // config backups (settings.json.bak-mcpfix, CLAUDE.md.backup.2026-…) — but
  // NEVER a live config file, which ends in a real config extension. The backup
  // marker sits AFTER the real extension, so a `.bak`/`.backup` that is not itself
  // the trailing extension is a backup; a real `*.json` / `*.md` / `*.toml` passes.
  if (!CONFIG_EXT_RE.test(base) && (base.includes(".bak") || base.includes(".backup"))) {
    return true;
  }
  if (IGNORED_FILE_NAMES.has(base)) return true;
  for (const prefix of IGNORED_FILE_PREFIXES) {
    if (base.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Resolve the {target, configDir} pairs to watch. The default resolves the real
 * claude + codex config dirs; tests inject `dirs` to point at a temp sandbox so
 * they never touch (or write to) a real ~/.claude / ~/.codex.
 * @returns {Promise<Array<{target: string, configDir: string}>>}
 */
async function defaultResolveDirs() {
  const out = [];
  for (const target of TARGETS) {
    const { configDir } = await resolveTargetAndConfig({ target });
    out.push({ target, configDir });
  }
  return out;
}

/**
 * Create the live hub: start the watchers and expose subscribe/close.
 *
 * @param {{debounceMs?: number, dirs?: Array<{target: string, configDir: string}>}} [opts]
 *   dirs — optional explicit watch list (hermetic-test seam); defaults to the
 *   resolved claude + codex config dirs.
 * @returns {Promise<{subscribe: (send: (payload: string) => void) => (() => void), close: () => void, clientCount: () => number, watchedTargets: string[]}>}
 */
export async function createLiveHub({ debounceMs = 300, dirs } = {}) {
  /** @type {Set<(payload: string) => void>} */
  const clients = new Set();
  /** @type {import('node:fs').FSWatcher[]} */
  const watchers = [];
  const watchedTargets = [];
  let timer = null;
  let pending = new Set();

  function flush() {
    timer = null;
    // `targets` is a best-effort UNION of whatever changed within this debounce
    // window — the single shared timer can fold a claude + codex change into one
    // payload. The browser ignores it today (it bumps one global reloadKey); it is
    // here for a future per-target consumer, which must treat it as best-effort.
    const targets = [...pending];
    pending = new Set();
    const payload = JSON.stringify({ type: "change", targets, ts: Date.now() });
    for (const send of clients) {
      try {
        send(payload);
      } catch {
        /* a dead client — its unsubscribe will clean it up on abort */
      }
    }
  }

  function onChange(targetId) {
    pending.add(targetId);
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
    // do not keep the event loop alive purely for a pending reload tick
    if (typeof timer.unref === "function") timer.unref();
  }

  const targetDirs = Array.isArray(dirs) ? dirs : await defaultResolveDirs();
  for (const { target, configDir } of targetDirs) {
    try {
      const w = watch(
        configDir,
        { recursive: true, persistent: false },
        (_event, filename) => {
          if (isNoise(filename)) return;
          onChange(target);
        },
      );
      // A watcher error (e.g. the dir is removed mid-run) must never crash the API.
      w.on("error", () => {});
      watchers.push(w);
      watchedTargets.push(target);
    } catch {
      /* target dir absent or unwatchable → skip it; the others still work */
    }
  }

  return {
    subscribe(send) {
      clients.add(send);
      return () => clients.delete(send);
    },
    close() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
      clients.clear();
      if (timer) clearTimeout(timer);
    },
    clientCount: () => clients.size,
    watchedTargets,
  };
}
