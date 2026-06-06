# Switches the Stream Deck plugin junction to a given QuickBits project folder.
# Usage:
#   .\scripts\switch-streamdeck-link.ps1
#   .\scripts\switch-streamdeck-link.ps1 "D:\Development\AryaPaw\quickbits"
#   .\scripts\switch-streamdeck-link.ps1 -Build -Restart

param(
    [Parameter(Position = 0)]
    [string]$ProjectRoot = "",

    [switch]$Build,
    [switch]$Restart,
    [switch]$NoUnlink
)

$ErrorActionPreference = "Stop"

$PluginId = "dev.aryapaw.quickbits"
$SdPluginDirName = "dev.aryapaw.quickbits.sdPlugin"
$InstalledPath = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\$SdPluginDirName"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
} else {
    $ProjectRoot = (Resolve-Path $ProjectRoot).Path
}

$TargetSdPlugin = Join-Path $ProjectRoot $SdPluginDirName

if (-not (Test-Path $TargetSdPlugin)) {
    throw "Plugin folder not found: $TargetSdPlugin"
}

if (-not (Test-Path (Join-Path $TargetSdPlugin "manifest.json"))) {
    throw "manifest.json not found in: $TargetSdPlugin"
}

function Get-LinkTarget {
    param([string]$Path)
    if (-not (Test-Path $Path)) {
        return $null
    }
    $item = Get-Item $Path -Force
    if ($item.LinkType) {
        return $item.Target
    }
    return $item.FullName
}

function Invoke-StreamDeckCli {
    param([string[]]$CliArgs)
    Push-Location $ProjectRoot
    try {
        & npx --yes streamdeck @CliArgs
        if ($LASTEXITCODE -ne 0) {
            throw "streamdeck $($CliArgs -join ' ') failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

Write-Host "QuickBits Stream Deck link switch" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"
Write-Host "Target:       $TargetSdPlugin"

$currentTarget = Get-LinkTarget $InstalledPath
if ($currentTarget) {
    Write-Host "Current link: $currentTarget"
    if ($currentTarget -eq $TargetSdPlugin) {
        Write-Host "Already linked to this folder." -ForegroundColor Yellow
    }
} else {
    Write-Host "Current link: not installed"
}

if (-not $NoUnlink -and (Test-Path $InstalledPath)) {
    Write-Host "Unlinking existing plugin..." -ForegroundColor Gray
    try {
        Invoke-StreamDeckCli @("unlink", $PluginId)
    } catch {
        Write-Host "Unlink skipped or failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-Host "Linking plugin..." -ForegroundColor Green
Invoke-StreamDeckCli @("link", $SdPluginDirName)

$newTarget = Get-LinkTarget $InstalledPath
Write-Host "New link: $newTarget" -ForegroundColor Green

if ($Build) {
    Write-Host "Building plugin..." -ForegroundColor Green
    Push-Location $ProjectRoot
    try {
        & bun run build:plugin
        if ($LASTEXITCODE -ne 0) {
            throw "bun run build:plugin failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

if ($Restart) {
    Write-Host "Restarting plugin in Stream Deck..." -ForegroundColor Green
    Invoke-StreamDeckCli @("restart", $PluginId)
}

Write-Host "Done." -ForegroundColor Cyan
