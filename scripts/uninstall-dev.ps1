# scripts/uninstall-dev.ps1 — dogfood uninstaller for the claude-mgr working tree.
#
# Removes ONLY the directory symlink   <configDir>/.mgr
# created by install-dev.ps1. Never removes real directory content.
#
# If the path does not exist the script exits cleanly (idempotent).
# If the path exists but is a real directory (not a symlink/junction) the
# script ABORTS — it will not delete real data under any circumstances.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Resolve paths (identical logic to install-dev.ps1) ───────────────────────

$configDir = if ($env:CLAUDE_CONFIG_DIR -and $env:CLAUDE_CONFIG_DIR.Trim() -ne "") {
    $env:CLAUDE_CONFIG_DIR
} else {
    Join-Path $HOME ".claude"
}
$linkPath = Join-Path $configDir ".mgr"

Write-Host "uninstall-dev: configDir = $configDir"
Write-Host "uninstall-dev: linkPath  = $linkPath"

# ── Nothing to do ─────────────────────────────────────────────────────────────

if (-not (Test-Path $linkPath -PathType Any)) {
    Write-Host "uninstall-dev: nothing to remove — '$linkPath' does not exist."
    exit 0
}

# ── Safety check: must be a reparse point, not a real directory ───────────────

$item      = Get-Item $linkPath -Force
$isReparse = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0

if (-not $isReparse) {
    Write-Error "ABORT: '$linkPath' is NOT a symlink/junction (it is a real file or directory). This script only removes the dogfood symlink — it will never delete real data. Remove it manually if you intended that."
    exit 1
}

# ── Remove the symlink ────────────────────────────────────────────────────────

Write-Host "uninstall-dev: removing symlink '$linkPath'"
# Use cmd /c rmdir — NOT Remove-Item -Recurse, which would follow the link
# and delete the TARGET contents (the working repo).
cmd /c "rmdir `"$linkPath`""

if ($LASTEXITCODE -ne 0) {
    Write-Error "cmd /c rmdir failed (exit $LASTEXITCODE) when trying to remove '$linkPath'. Check permissions and try again."
    exit 1
}

Write-Host "uninstall-dev: OK  '$linkPath' removed."
exit 0
