#!/usr/bin/env node
/**
 * claude-mgr — npm-bin entry point (thin wrapper; ALL logic lives in src/cli.mjs).
 *
 * The shell analogs are claude-mgr.ps1 (Windows) and claude-mgr.sh (POSIX); this is
 * the npm global-install analog, so `npm link` (or a future published install) puts a
 * `claude-mgr` command on PATH and the non-coder owner can type `claude-mgr doctor`
 * from any directory instead of cd'ing into the repo to run a wrapper.
 *
 * It mirrors cli.mjs's own executable main-guard (the bottom of src/cli.mjs): call the
 * pure run(), print stdout with a single trailing newline, and propagate the exit code
 * verbatim. cli.mjs's guard does NOT fire here (its import.meta.url !== argv[1] when
 * this shim is the entry), so this is the single execution path — no double-run.
 *
 * Zero npm dependencies (imports only the project core) — the bin path stays dep-free,
 * exactly like the CLI it wraps.
 */
import { run } from '../src/cli.mjs';

const { code, stdout } = await run(process.argv.slice(2));
process.stdout.write(stdout + '\n');
process.exit(code);
