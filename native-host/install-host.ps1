# Scrapewright native messaging host installer + diagnostics (Windows).
#
# Usage:
#   .\install-host.ps1 <extension-id>     Install (or reinstall) the host.
#   .\install-host.ps1 -Doctor            Diagnose the current setup.
#   .\install-host.ps1 -Uninstall         Remove manifest, wrapper, registry key.
#
# Generates host-launcher.cmd next to host.js. The wrapper hard-codes the
# absolute path to node.exe detected at install time, so Chrome can launch
# the host even though its PATH on Windows doesn't include the user's
# nodejs install location (a common native-messaging failure mode).

param(
    [Parameter(Position=0)]
    [string]$ExtensionId,

    [switch]$Doctor,
    [switch]$Uninstall,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$HostName = "com.scrapewright.host"
$HostDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $HostDir "$HostName.json"
$LauncherPath = Join-Path $HostDir "host-launcher.cmd"
$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$NodeMinMajor = 18
$DefaultLogDir = Join-Path $env:LOCALAPPDATA "scrapewright"
$DefaultLogFile = Join-Path $DefaultLogDir "host.log"

# --- helpers ----------------------------------------------------------------

function Write-Step([string]$msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Ok([string]$msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "  ✗ $msg" -ForegroundColor Red }

function Find-Node {
    # Try PATH first, then well-known Windows install locations.
    $fromPath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($fromPath) { return $fromPath }
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\nodejs\node.exe",
        "$env:APPDATA\npm\node.exe",
        "$env:USERPROFILE\AppData\Roaming\npm\node.exe",
        "$env:USERPROFILE\scoop\apps\nodejs\current\node.exe",
        "$env:USERPROFILE\scoop\shims\node.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }
    if ($candidates.Count -gt 0) { return $candidates[0] }
    return $null
}

function Get-NodeVersion([string]$nodeBin) {
    try {
        $raw = & $nodeBin --version 2>$null
        if ($raw -match 'v(\d+)\.') { return [int]$Matches[1] }
    } catch {}
    return 0
}

# --- doctor -----------------------------------------------------------------

function Run-Doctor {
    Write-Host "Scrapewright native host doctor" -ForegroundColor White
    Write-Host ""
    Write-Host "Environment:" -ForegroundColor DarkGray
    Write-Step "OS:               $([System.Environment]::OSVersion.VersionString)"
    Write-Step "Host dir:         $HostDir"
    Write-Step "Manifest path:    $ManifestPath"
    Write-Step "Launcher path:    $LauncherPath"
    Write-Step "Registry key:     $RegPath"
    Write-Step "Default log file: $DefaultLogFile"
    Write-Host ""

    Write-Host "Node.js:" -ForegroundColor DarkGray
    $nodeBin = Find-Node
    if (-not $nodeBin) {
        Write-Fail "node not found on PATH or in standard install locations"
        Write-Warn "install Node.js $NodeMinMajor+ from https://nodejs.org/"
        return
    }
    Write-Ok "node found: $nodeBin"
    $major = Get-NodeVersion $nodeBin
    if ($major -ge $NodeMinMajor) {
        $full = & $nodeBin --version 2>$null
        Write-Ok "node version $full (>= $NodeMinMajor)"
    } else {
        Write-Fail "node major version $major — need >= $NodeMinMajor"
    }
    Write-Host ""

    Write-Host "Manifest:" -ForegroundColor DarkGray
    if (Test-Path $ManifestPath) {
        Write-Ok "manifest exists"
        try {
            $m = Get-Content $ManifestPath -Raw | ConvertFrom-Json
            $checks = @(
                @{ label = "name present";           ok = [bool]$m.name },
                @{ label = "path present";           ok = [bool]$m.path },
                @{ label = "path exists on disk";    ok = ($m.path -and (Test-Path $m.path)) },
                @{ label = "type=stdio";             ok = ($m.type -eq 'stdio') },
                @{ label = "allowed_origins set";    ok = ($m.allowed_origins -and $m.allowed_origins.Count -gt 0) }
            )
            foreach ($c in $checks) {
                if ($c.ok) { Write-Ok $c.label } else { Write-Fail $c.label }
            }
            # Path-drift check: does manifest.path resolve into the current
            # host dir? When it points elsewhere Chrome launches a stale
            # wrapper (classic "moved the project dir" failure).
            if ($m.path) {
                try {
                    $manifestDir = (Resolve-Path -LiteralPath (Split-Path -Parent $m.path) -ErrorAction Stop).Path.TrimEnd('\')
                    $currentDir  = (Resolve-Path -LiteralPath $HostDir -ErrorAction Stop).Path.TrimEnd('\')
                    if ($manifestDir -eq $currentDir) {
                        Write-Ok "path points into current host dir"
                    } else {
                        Write-Fail "path points OUTSIDE current host dir (path drift)"
                        Write-Step "  manifest dir: $manifestDir"
                        Write-Step "  current dir : $currentDir"
                        Write-Warn "  re-install to fix: .\install-host.ps1 -ExtensionId <id>"
                    }
                } catch {
                    Write-Fail "path points to unresolved location: $($m.path)"
                }
            }
        } catch {
            Write-Fail "manifest JSON parse failed: $_"
        }
    } else {
        Write-Fail "manifest not installed"
        Write-Warn "run: .\install-host.ps1 <extension-id>"
    }
    Write-Host ""

    Write-Host "Registry:" -ForegroundColor DarkGray
    if (Test-Path $RegPath) {
        $default = (Get-ItemProperty -Path $RegPath -Name '(Default)' -ErrorAction SilentlyContinue).'(Default)'
        if ($default) {
            Write-Ok "registry key present, default = $default"
            if (Test-Path $default) {
                Write-Ok "registry default points to existing manifest"
            } else {
                Write-Fail "registry default points to non-existent file"
            }
        } else {
            Write-Fail "registry key present but no default value"
        }
    } else {
        Write-Fail "registry key missing: $RegPath"
    }
    Write-Host ""

    Write-Host "Port 8765:" -ForegroundColor DarkGray
    try {
        $conn = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
            Write-Warn "port 8765 is in use:"
            $conn | Select-Object -First 1 | ForEach-Object {
                $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
                Write-Step "  PID $($_.OwningProcess) ($($proc.ProcessName))"
            }
        } else {
            Write-Ok "port 8765 is free"
        }
    } catch {
        Write-Step "Get-NetTCPConnection unavailable — skipping port check"
    }
    Write-Host ""

    Write-Host "Recent log:" -ForegroundColor DarkGray
    if (Test-Path $DefaultLogFile) {
        Write-Step "last 10 lines of ${DefaultLogFile}:"
        Get-Content $DefaultLogFile -Tail 10 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    } else {
        Write-Step "no log file yet"
    }
    Write-Host ""

    Write-Host "Wrapper smoke test:" -ForegroundColor DarkGray
    # Smoke-test the wrapper the manifest actually points at (what Chrome
    # launches), not just the current-dir launcher. Parity with install-host.sh.
    $smokeTarget = $LauncherPath
    if (Test-Path $ManifestPath) {
        try {
            $smokeM = Get-Content $ManifestPath -Raw | ConvertFrom-Json
            if ($smokeM.path) {
                $smokeTarget = $smokeM.path
                if ($smokeTarget -ne $LauncherPath) {
                    Write-Warn "manifest.path ($smokeTarget) != current launcher ($LauncherPath)"
                    Write-Step "  smoke-testing the manifest's wrapper (what Chrome launches)"
                }
            }
        } catch {}
    }
    if (-not (Test-Path $smokeTarget)) {
        Write-Fail "wrapper not installed: $smokeTarget"
        Write-Warn "run: .\install-host.ps1 -ExtensionId <id>"
    } else {
        $portBusy = $false
        try { $portBusy = $null -ne (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) } catch {}
        if ($portBusy) {
            Write-Warn "skipping smoke test - port 8765 in use"
            Write-Step "  stop the host first: Get-Process node | Stop-Process -Force"
        } else {
            Write-Step "invoking wrapper with empty stdin (1.5s budget)..."
            $logBefore = 0
            if (Test-Path $DefaultLogFile) { $logBefore = (Get-Content $DefaultLogFile | Measure-Object -Line).Lines }
            $smokeErr = "$env:TEMP\cc-doctor-stderr.txt"
            # cmd.exe /c mirrors how Chrome launches a .cmd native host; "nul"
            # gives a non-TTY empty stdin so host.js takes the native-messaging init path.
            $p = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$smokeTarget`"" `
                -NoNewWindow -PassThru -RedirectStandardError $smokeErr `
                -RedirectStandardInput "nul" -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1.5
            if ($p -and -not $p.HasExited) {
                Write-Ok "wrapper survived 1.5s - node spawned, host.js initialized"
                try { $p | Stop-Process -Force -ErrorAction Stop } catch {}
            } else {
                $code = if ($p) { $p.ExitCode } else { "?" }
                Write-Fail "wrapper died before 1.5s (exit=$code)"
                if (Test-Path $smokeErr) {
                    Write-Step "stderr:"
                    Get-Content $smokeErr -ErrorAction SilentlyContinue | Select-Object -First 10 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
                }
            }
            if (Test-Path $DefaultLogFile) {
                $logAfter = (Get-Content $DefaultLogFile | Measure-Object -Line).Lines
                if ($logAfter -gt $logBefore) {
                    Write-Ok "host.log grew ($logBefore -> $logAfter lines)"
                } else {
                    Write-Fail "host.log did not grow - host.js crashed before logger init"
                    Write-Step "  classic 'Native host has exited' failure mode"
                }
            }
            Remove-Item $smokeErr -ErrorAction SilentlyContinue
        }
    }
    Write-Host ""

    Write-Host "Extension connectivity probe:" -ForegroundColor DarkGray
    try {
        $resp = Invoke-RestMethod -Uri 'http://localhost:8765/health' -TimeoutSec 2 -ErrorAction Stop
        Write-Ok "host reachable on :8765"
        Write-Step ("health: " + ($resp | ConvertTo-Json -Compress))
    } catch {
        Write-Warn "host not reachable on :8765 (it only listens after Chrome launches it)"
    }

    # Overall verdict — exit non-zero if any load-bearing check failed, so
    # `scrapewright doctor` / CI can rely on the exit code (PowerShell `exit` here
    # terminates the whole process, so a sick result wins over the entrypoint's exit 0).
    $doctorOk = $true
    $nb = Find-Node
    if (-not $nb) { $doctorOk = $false }
    elseif ((Get-NodeVersion $nb) -lt $NodeMinMajor) { $doctorOk = $false }
    if (-not (Test-Path $ManifestPath)) {
        $doctorOk = $false
    } else {
        try {
            $m = Get-Content $ManifestPath -Raw | ConvertFrom-Json
            if ($m.path) {
                $md = (Resolve-Path -LiteralPath (Split-Path -Parent $m.path) -ErrorAction SilentlyContinue).Path.TrimEnd('\')
                $cd = (Resolve-Path -LiteralPath $HostDir -ErrorAction SilentlyContinue).Path.TrimEnd('\')
                if (-not $md -or -not $cd -or ($md -ne $cd)) { $doctorOk = $false }
            }
        } catch { $doctorOk = $false }
    }
    if (-not (Test-Path $LauncherPath)) { $doctorOk = $false }
    if (-not $doctorOk) { exit 1 }
}

# --- uninstall --------------------------------------------------------------

function Run-Uninstall {
    Write-Host "Removing Scrapewright native host..." -ForegroundColor White
    if (Test-Path $RegPath) {
        Remove-Item -Path $RegPath -Recurse -Force
        Write-Ok "removed registry key $RegPath"
    } else {
        Write-Step "registry key was not present"
    }
    if (Test-Path $ManifestPath) {
        Remove-Item -Path $ManifestPath -Force
        Write-Ok "removed manifest $ManifestPath"
    } else {
        Write-Step "manifest was not present"
    }
    if (Test-Path $LauncherPath) {
        Remove-Item -Path $LauncherPath -Force
        Write-Ok "removed launcher $LauncherPath"
    } else {
        Write-Step "launcher was not present"
    }
    Write-Host "Done. Chrome will no longer attempt to launch the host."
}

# --- install ----------------------------------------------------------------

function Run-Install {
    param([string]$ExtensionId)

    if (-not $ExtensionId) {
        Write-Fail "extension-id is required."
        Write-Fail "  find it at chrome://extensions/ with Developer Mode on (32 lowercase chars)"
        Write-Fail "  example: .\install-host.ps1 dmbnejooocdfjmnebpglhedhfcgncgdl"
        Write-Host ""
        Write-Host "Run .\install-host.ps1 -Doctor to check the rest of your setup."
        exit 2
    }
    if ($ExtensionId -notmatch '^[a-z]{32}$') {
        Write-Warn "extension-id doesn't look like a Chrome extension id (expected 32 lowercase letters)"
        Write-Warn "proceeding anyway — but double-check at chrome://extensions/"
        Write-Host ""
    }

    Write-Host "Installing Scrapewright native host..." -ForegroundColor White
    Write-Step "extension id: $ExtensionId"
    Write-Host ""

    Write-Host "Step 1: pre-flight checks" -ForegroundColor DarkGray
    $nodeBin = Find-Node
    if (-not $nodeBin) {
        Write-Fail "node not found"
        Write-Warn "install Node.js $NodeMinMajor+ first: https://nodejs.org/"
        exit 1
    }
    Write-Ok "node found at $nodeBin"
    $major = Get-NodeVersion $nodeBin
    if ($major -lt $NodeMinMajor) {
        $full = & $nodeBin --version 2>$null
        Write-Fail "node version $full is too old — need >= $NodeMinMajor"
        exit 1
    }
    $full = & $nodeBin --version 2>$null
    Write-Ok "node version $full (>= $NodeMinMajor)"
    Write-Host ""

    # Migration notice: warn if an existing manifest points outside the
    # current host dir (user moved/renamed the project). Non-fatal.
    if (Test-Path $ManifestPath) {
        try {
            $oldPath = (Get-Content $ManifestPath -Raw | ConvertFrom-Json).path
            if ($oldPath) {
                $oldDir = (Resolve-Path -LiteralPath (Split-Path -Parent $oldPath) -ErrorAction SilentlyContinue).Path.TrimEnd('\')
                $newDir  = (Resolve-Path -LiteralPath $HostDir -ErrorAction SilentlyContinue).Path.TrimEnd('\')
                if ($oldDir -and $newDir -and ($oldDir -ne $newDir)) {
                    Write-Host "migrating manifest path" -ForegroundColor Yellow
                    Write-Step "old: $oldPath"
                    Write-Step "new: $LauncherPath"
                    Write-Step "(project directory moved or renamed - re-install was correct)"
                    Write-Host ""
                }
            }
        } catch {}
    }

    Write-Host "Step 2: write launcher (host-launcher.cmd)" -ForegroundColor DarkGray
    # .cmd wrapper. %* passes all args through. Double-quotes handle spaces
    # in paths like C:\Program Files\nodejs.
    $cmdBody = "@echo off`r`nrem Generated by install-host.ps1 — do not edit by hand.`r`nrem Re-run .\install-host.ps1 <extension-id> to regenerate.`r`n""$nodeBin"" ""$HostDir\host.js"" %*`r`n"
    Set-Content -Path $LauncherPath -Value $cmdBody -Encoding ASCII
    Write-Ok "wrote $LauncherPath"
    Write-Host ""

    Write-Host "Step 3: install manifest" -ForegroundColor DarkGray
    $Manifest = @{
        name = $HostName
        description = "Scrapewright Native Messaging Host"
        path = $LauncherPath
        type = "stdio"
        allowed_origins = @("chrome-extension://$ExtensionId/")
    } | ConvertTo-Json -Depth 5
    Set-Content -Path $ManifestPath -Value $Manifest -Encoding UTF8
    Write-Ok "wrote $ManifestPath"
    Write-Host ""

    Write-Host "Step 4: register with Chrome (HKCU)" -ForegroundColor DarkGray
    New-Item -Path $RegPath -Force | Out-Null
    New-ItemProperty -Path $RegPath -Name '(Default)' -Value $ManifestPath -PropertyType String -Force | Out-Null
    Write-Ok "registry key set: $RegPath"
    Write-Host ""

    Write-Host "Step 5: prepare log directory" -ForegroundColor DarkGray
    if (-not (Test-Path $DefaultLogDir)) {
        New-Item -Path $DefaultLogDir -ItemType Directory -Force | Out-Null
    }
    Write-Ok "log dir ready: $DefaultLogDir"
    Write-Host ""

    Write-Host "Install complete." -ForegroundColor Green
    Write-Host ""
    Write-Host "What happens next:"
    Write-Step "1. Restart Chrome (or reload the extension)."
    Write-Step "2. Open the extension — it should connect within ~1 second."
    Write-Step "3. If it doesn't, run: .\install-host.ps1 -Doctor"
    Write-Host ""
    Write-Host "Logs:"
    Write-Step "Get-Content -Path '$DefaultLogFile' -Wait -Tail 20"
}

# --- help -------------------------------------------------------------------

function Show-Help {
    Write-Host "Scrapewright native host installer (Windows)" -ForegroundColor White
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  .\install-host.ps1 <extension-id>    Install or reinstall the native host."
    Write-Host "  .\install-host.ps1 -Doctor           Diagnose the current setup without changes."
    Write-Host "  .\install-host.ps1 -Uninstall        Remove manifest, wrapper, registry key."
    Write-Host "  .\install-host.ps1 -Help             Show this message."
    Write-Host ""
    Write-Host "Find your extension id at chrome://extensions/ (Developer Mode on)."
}

# --- entrypoint -------------------------------------------------------------

if ($Help) { Show-Help; exit 0 }
if ($Doctor) { Run-Doctor; exit 0 }
if ($Uninstall) { Run-Uninstall; exit 0 }
if (-not $ExtensionId) {
    Show-Help
    Write-Host ""
    Write-Fail "missing extension-id argument"
    Write-Host ""
    Write-Host "Run .\install-host.ps1 -Doctor to check your setup."
    exit 2
}
Run-Install -ExtensionId $ExtensionId
