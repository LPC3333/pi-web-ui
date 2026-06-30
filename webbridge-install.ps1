#Requires -Version 5.1
<#
.SYNOPSIS
    kimi-webbridge bootstrap installer (Windows).

.DESCRIPTION
    Detects platform (windows-amd64), downloads the daemon binary,
    starts the daemon, and installs skills into detected AI-agent runtimes.
    Windows counterpart to install.sh — the bash version is the source of
    truth; flags/env vars/prompts here mirror it with PowerShell-native style.
#>

[CmdletBinding()]
param(
    [switch]$Help,
    [switch]$NoStart,
    [switch]$NoSkill
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- config ----------

$BaseUrl    = 'https://cdn.kimi.com/webbridge'
$InstallDir = Join-Path $env:USERPROFILE '.kimi-webbridge'
$BinDir     = Join-Path $InstallDir 'bin'
$BinPath    = Join-Path $BinDir 'kimi-webbridge.exe'

# ---------- output helpers ----------

function Info ([string]$m) { Write-Host "==> $m" }
function Ok   ([string]$m) { Write-Host "$([char]0x2713) $m" -ForegroundColor Green }
function Warn ([string]$m) { Write-Host "! $m" -ForegroundColor Yellow }
function Err_ ([string]$m) { Write-Host "$([char]0x2717) $m" -ForegroundColor Red }

# ---------- help ----------

function Show-Help {
    @"
kimi-webbridge bootstrap installer (Windows)

Usage:
  irm $BaseUrl/install.ps1 | iex                                            # latest
  iex "& { `$(irm $BaseUrl/install.ps1) } -NoStart"                          # skip daemon start
  iex "& { `$(irm $BaseUrl/install.ps1) } -NoSkill"                          # skip skill install
  `$env:KIMI_WEBBRIDGE_VERSION='0.3.0'; irm $BaseUrl/install.ps1 | iex       # pin version

Options:
  -Help         Show this help.
  -NoStart      Install binary and skills, but don't start the daemon.
  -NoSkill      Install binary and start the daemon, but skip skill installation.

What it does:
  1. Detect platform (windows-amd64)
  2. Download kimi-webbridge.exe from OSS to $BinPath
  3. Start the daemon (unless -NoStart)
  4. Install skills to detected AI-agent runtimes (unless -NoSkill)

Environment:
  KIMI_WEBBRIDGE_VERSION   Pin to a specific version (e.g. 0.3.0; default: latest).
"@
}

if ($Help) { Show-Help; exit 0 }

# ---------- detect platform ----------

Info 'Detecting platform...'
$Platform = 'windows-amd64'
Ok "Platform: $Platform"

# ---------- resolve version ----------

# Version-first OSS layout — 'latest' is itself a directory containing the
# current release's contents. Users can pin via KIMI_WEBBRIDGE_VERSION.
$Version = if ($env:KIMI_WEBBRIDGE_VERSION) { $env:KIMI_WEBBRIDGE_VERSION } else { 'latest' }
Ok "Version: $Version"

# ---------- download binary ----------

$BinUrl = "$BaseUrl/$Version/releases/kimi-webbridge-$Platform.exe"
Info "Downloading binary from $BinUrl"

New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$TmpBin = Join-Path $env:TEMP "kimi-webbridge-$([System.Guid]::NewGuid().Guid).exe"

$downloadOk = $false
for ($i = 1; $i -le 3 -and -not $downloadOk; $i++) {
    try {
        Invoke-WebRequest -Uri $BinUrl -OutFile $TmpBin -UseBasicParsing -TimeoutSec 60
        $downloadOk = $true
    } catch {
        if ($i -lt 3) {
            Warn "download failed, retry ${i}/3..."
            Start-Sleep -Seconds 5
        }
    }
}

if (-not $downloadOk) {
    Err_ 'failed to download binary'
    if (Test-Path $TmpBin) { Remove-Item $TmpBin -Force -ErrorAction SilentlyContinue }
    exit 1
}

Move-Item -Path $TmpBin -Destination $BinPath -Force
Ok "Installed to $BinPath"
# ---------- start daemon ----------

if (-not $NoStart) {
    Info 'Starting daemon...'
    # try/catch wraps both "launch failed" (e.g. binary missing / AV block →
    # PS throws due to ErrorActionPreference='Stop') and "non-zero exit"
    # ($LASTEXITCODE). Mirrors bash `if "$BIN_PATH" start; then ... else ...`.
    $ok = $false
    try {
        & $BinPath start
        $ok = ($LASTEXITCODE -eq 0)
    } catch {
        $ok = $false
    }
    if ($ok) {
        Ok 'Daemon started'
    } else {
        Warn "Daemon failed to start — check logs at $InstallDir\logs\daemon.log"
    }
} else {
    Info 'Skipping daemon start (-NoStart)'
}

# ---------- install skill ----------

if (-not $NoSkill) {
    Info 'Installing skills...'
    $ok = $false
    try {
        & $BinPath install-skill -y
        $ok = ($LASTEXITCODE -eq 0)
    } catch {
        $ok = $false
    }
    if ($ok) {
        Ok 'Skills installed'
    } else {
        Warn 'Some skill installations failed'
    }
} else {
    Info 'Skipping skill install (-NoSkill)'
}

Write-Host ''
Write-Host "Done. Check status anytime: kimi-webbridge status" -ForegroundColor Green
Write-Host ''
