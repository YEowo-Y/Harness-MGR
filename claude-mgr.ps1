# claude-mgr.ps1 — thin Windows entry point for the claude-mgr CLI.
#
# This script is the SHELL WRAPPER ONLY. All logic lives in src/cli.mjs (the
# fat core). Invoking this file from any directory will resolve the correct
# path to src/cli.mjs regardless of the caller's working directory, then
# delegate every argument directly to Node and propagate the exit code.
#
# Exit codes (defined by src/cli.mjs):
#   0  — clean result (no error diagnostics)
#   1  — one or more error-level diagnostics in the output
#   2  — usage error / unhandled throw (JSON error envelope written to stdout)
#
# NOTE: src/cli.mjs currently exports run() only; an executable main() guard
# will be wired in a sibling task. This wrapper is ready for it.

$cliPath = Join-Path $PSScriptRoot "src\cli.mjs"
node "$cliPath" @args
exit $LASTEXITCODE
