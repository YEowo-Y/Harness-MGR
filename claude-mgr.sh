#!/usr/bin/env sh
#
# claude-mgr.sh — thin POSIX entry point for the claude-mgr CLI (WSL / macOS / Linux).
#
# This is the SHELL WRAPPER ONLY — the exact POSIX parity of claude-mgr.ps1. All logic
# lives in src/cli.mjs (the fat core). Invoking this file from any directory resolves
# the correct path to src/cli.mjs regardless of the caller's working directory, then
# delegates every argument directly to node and propagates the exit code.
#
# Exit codes (defined by src/cli.mjs):
#   0  — clean result (no error diagnostics)
#   1  — one or more error-level diagnostics in the output
#   2  — usage error / unhandled throw (JSON error envelope written to stdout)
#   3  — a write was refused by the two-factor gate (e.g. CLAUDE_MGR_ENABLE_WRITES unset)
#
# Usage:  ./claude-mgr.sh <command> [flags]     (or:  sh claude-mgr.sh <command> [flags])
#
# NOTE: do NOT add `set -e` here — a non-zero exit from the CLI is meaningful and must
# propagate, not abort this wrapper early.

# Resolve the directory containing THIS script, independent of the caller's cwd and
# robust to spaces in the path. `CDPATH=` guards against a user-set CDPATH perturbing
# `cd`; `dirname -- "$0"` + `cd ... && pwd` canonicalizes the script's own directory.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# `exec` replaces this shell process with node, so node's exit code becomes the
# script's exit code verbatim — exact parity with claude-mgr.ps1's `exit $LASTEXITCODE`.
exec node "$SCRIPT_DIR/src/cli.mjs" "$@"
