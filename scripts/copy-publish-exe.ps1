param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Dest
)

$ErrorActionPreference = "Stop"

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$destPath = $Dest
$destDir = Split-Path -Parent $destPath

if (-not (Test-Path -LiteralPath $sourcePath)) {
    Write-Error "Source not found: $sourcePath"
    exit 1
}

if ($destDir -and -not (Test-Path -LiteralPath $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
}

function Stop-LockingProcesses {
    param([string]$TargetPath)
    $targetName = [System.IO.Path]::GetFileName($TargetPath)
    $resolvedTarget = $null
    try {
        $resolvedTarget = (Resolve-Path -LiteralPath $TargetPath -ErrorAction SilentlyContinue).Path
    } catch {
        $resolvedTarget = $TargetPath
    }

    Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.Path -and ($_.Path -ieq $resolvedTarget -or $_.ProcessName -ieq [System.IO.Path]::GetFileNameWithoutExtension($targetName))) {
                Write-Host "Stopping locking process: $($_.ProcessName) ($($_.Id))"
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
        } catch {
            # ignore access denied for system processes
        }
    }
}

function Copy-WithRetry {
    param(
        [string]$From,
        [string]$To,
        [int]$Attempts = 5
    )

    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            Copy-Item -LiteralPath $From -Destination $To -Force
            return $true
        } catch {
            if ($i -eq $Attempts) {
                throw
            }
            Write-Host "Copy attempt $i failed, retrying..."
            Start-Sleep -Milliseconds 400
        }
    }

    return $false
}

try {
    Copy-WithRetry -From $sourcePath -To $destPath -Attempts 3 | Out-Null
} catch {
    Write-Host "Destination locked, stopping processes using $destPath"
    Stop-LockingProcesses -TargetPath $destPath
    Start-Sleep -Milliseconds 500
    try {
        Copy-WithRetry -From $sourcePath -To $destPath -Attempts 5 | Out-Null
    } catch {
        Write-Error @"
Failed to copy published exe (file is locked).

  From: $sourcePath
  To:   $destPath

Stop the plugin and helper, then rebuild:
  streamdeck stop dev.aryapaw.quickbits
  bun run build

Original error: $($_.Exception.Message)
"@
        exit 1
    }
}

Write-Host "Copied $([System.IO.Path]::GetFileName($sourcePath)) -> $destPath"
