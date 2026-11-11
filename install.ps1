# Warden installer for Windows (PowerShell 5.1 or newer).
#   irm https://raw.githubusercontent.com/yashhonap/warden/main/install.ps1 | iex
# What it does, and nothing else:
#   1. If Node.js 22.13+ is missing, installs Node.js LTS with winget (the official OpenJS.NodeJS.LTS package).
#   2. Installs Warden from npm (package "agent-warden").
# Set WARDEN_PACKAGE to install from somewhere else (e.g. a local .tgz) for testing.

$ErrorActionPreference = 'Stop'
function Say([string]$m) { Write-Host "  $m" }
function NodeOk {
  try {
    $v = (& node --version 2>$null)
    if (-not $v) { return $false }
    $p = $v.TrimStart('v').Split('.')
    return ([int]$p[0] -gt 22) -or (([int]$p[0] -eq 22) -and ([int]$p[1] -ge 13))
  } catch { return $false }
}

Write-Host ""
Say "Installing Warden - a coding agent for any model, in your terminal"
Say "https://github.com/yashhonap/warden"
Write-Host ""

if (-not (NodeOk)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Say "Warden needs Node.js 22.13 or newer. Installing Node.js LTS with winget..."
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
    # pick up the new PATH in this window
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (NodeOk)) {
    Say "Node.js 22.13+ is still not available."
    Say "Install the LTS version from https://nodejs.org, open a new PowerShell window, and run this command again."
    return
  }
}
Say ("Node.js " + (& node --version) + " found.")

$pkg = if ($env:WARDEN_PACKAGE) { $env:WARDEN_PACKAGE } else { 'agent-warden' }
Say "Installing $pkg from npm..."
& npm.cmd install -g $pkg
if ($LASTEXITCODE -ne 0) {
  Say "npm could not install Warden (see the messages above)."
  Say "Common fixes: check your internet connection or company proxy, then run this again."
  return
}

Write-Host ""
Say "Done! Next:"
Say "  1. Open a NEW PowerShell window"
Say "  2. Go to a project folder, e.g.  cd C:\path\to\your\project"
Say "  3. Type:  warden"
Say "Warden will help you get a free API key the first time."
Say "If PowerShell says 'running scripts is disabled', type  warden.cmd  instead."
Write-Host ""
