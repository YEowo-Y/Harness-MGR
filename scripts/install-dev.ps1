# scripts/install-dev.ps1 — dogfood installer for the harness-mgr working tree.
#
# Creates a DIRECTORY SYMLINK   <configDir>/.mgr  →  <repoRoot>
# so the live Claude Code harness loads harness-mgr directly from this repo.
#
# Safe to re-run (idempotent): if a symlink already exists at the link path it
# is removed and recreated. If a REAL directory exists there the script ABORTS
# rather than risk deleting real content.
#
# Prerequisites (Windows):
#   • Developer Mode enabled  (Settings → System → For developers), OR
#   • Run this script from an elevated (Administrator) PowerShell prompt.
#
# Fallback note (not implemented): if mklink continues to fail on a locked-down
# machine you can use  robocopy /MIR <repoRoot> <linkPath>  to copy the tree
# instead of symlinking — but you would then need to re-run this script after
# every change to keep the copy in sync.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Resolve paths ────────────────────────────────────────────────────────────

$repoRoot  = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configDir = if ($env:CLAUDE_CONFIG_DIR -and $env:CLAUDE_CONFIG_DIR.Trim() -ne "") {
    $env:CLAUDE_CONFIG_DIR
} else {
    Join-Path $HOME ".claude"
}
$linkPath  = Join-Path $configDir ".mgr"

Write-Host "install-dev: repoRoot  = $repoRoot"
Write-Host "install-dev: configDir = $configDir"
Write-Host "install-dev: linkPath  = $linkPath"

# ── Developer Mode precheck ───────────────────────────────────────────────────

try {
    $devModeKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
    $devModeVal = (Get-ItemProperty -Path $devModeKey -Name "AllowDevelopmentWithoutDevLicense" -ErrorAction Stop).AllowDevelopmentWithoutDevLicense
    if ($devModeVal -ne 1) {
        Write-Warning "Developer Mode does not appear to be enabled (AllowDevelopmentWithoutDevLicense=$devModeVal). Creating a directory symlink may fail unless you run this script as Administrator."
    }
} catch {
    Write-Warning "Could not read Developer Mode registry value. If symlink creation fails, enable Developer Mode or run as Administrator."
}

# ── Ensure configDir exists ───────────────────────────────────────────────────

if (-not (Test-Path $configDir)) {
    Write-Host "install-dev: creating configDir '$configDir'"
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

# ── Handle existing linkPath ──────────────────────────────────────────────────

if (Test-Path $linkPath -PathType Any) {
    $item       = Get-Item $linkPath -Force
    $isReparse  = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0

    if (-not $isReparse) {
        Write-Error "ABORT: '$linkPath' already exists and is NOT a symlink/junction (it is a real file or directory). Remove it manually before running this installer — this script will never delete real data."
        exit 1
    }

    Write-Host "install-dev: removing existing reparse point '$linkPath'"
    # Use cmd /c rmdir — NOT Remove-Item -Recurse, which would follow the link
    # and delete the TARGET contents (the working repo).
    cmd /c "rmdir `"$linkPath`""
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to remove existing symlink '$linkPath' (exit $LASTEXITCODE). Check permissions."
        exit 1
    }
}

# ── Create symlink ────────────────────────────────────────────────────────────

Write-Host "install-dev: creating symlink '$linkPath' → '$repoRoot'"
cmd /c "mklink /D `"$linkPath`" `"$repoRoot`""

if ($LASTEXITCODE -ne 0) {
    Write-Error @"
mklink failed (exit $LASTEXITCODE).
Possible causes and fixes:
  1. Developer Mode is not enabled.
     → Settings → System → For developers → toggle Developer Mode ON, then re-run.
  2. Not running as Administrator.
     → Re-run this script from an elevated PowerShell prompt.
  3. The link path is locked by another process.
     → Close any programs that may have the path open and retry.
"@
    exit 1
}

# ── Verify ────────────────────────────────────────────────────────────────────

$created = Get-Item $linkPath -Force -ErrorAction SilentlyContinue
if (-not $created) {
    Write-Error "Verification failed: '$linkPath' does not exist after mklink reported success."
    exit 1
}

$resolvedTarget = try { (Resolve-Path $linkPath).Path } catch { $null }
if (-not $resolvedTarget) {
    Write-Warning "Symlink created but Resolve-Path could not dereference '$linkPath'. Check manually."
} else {
    Write-Host "install-dev: OK  $linkPath  →  $resolvedTarget"
}

exit 0
