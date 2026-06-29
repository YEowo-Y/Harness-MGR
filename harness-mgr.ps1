# harness-mgr.ps1 — thin Windows entry point for the harness-mgr CLI.
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
#   3  — a write was refused (write gate locked via HARNESS_MGR_ENABLE_WRITES=0,
#        missing spec, or --force required)

$cliPath = Join-Path $PSScriptRoot "src\cli.mjs"
node "$cliPath" @args
exit $LASTEXITCODE
