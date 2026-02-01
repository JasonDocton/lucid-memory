# Lucid Memory Server Wrapper for Windows
# Auto-restarts the MCP server if it crashes

$ServerScript = "$env:USERPROFILE\.lucid\server\src\server.ts"
$LogDir = "$env:USERPROFILE\.lucid\logs"
$LogFile = "$LogDir\server.log"

# Verify Bun is available
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "Bun is not installed or not in PATH"
    Write-Error "Please install Bun: irm bun.sh/install.ps1 | iex"
    exit 1
}

# Verify server script exists
if (-not (Test-Path $ServerScript)) {
    Write-Error "Server script not found at $ServerScript"
    Write-Error "Please reinstall Lucid Memory: irm lucidmemory.dev/install.ps1 | iex"
    exit 1
}
$RestartDelay = 2
$MaxRapidRestarts = 5
$RapidRestartWindow = 60  # seconds

# Ensure log directory exists
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
    param($Message)
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $LogMessage = "[$Timestamp] $Message"
    Add-Content -Path $LogFile -Value $LogMessage
    Write-Host $Message
}

$RestartTimes = @()

while ($true) {
    # Check for rapid restart loop (crash loop detection)
    $Now = [int][double]::Parse((Get-Date -UFormat %s))
    $RestartTimes += $Now

    # Keep only restarts within the window
    $RestartTimes = $RestartTimes | Where-Object { ($Now - $_) -lt $RapidRestartWindow }

    if ($RestartTimes.Count -ge $MaxRapidRestarts) {
        Write-Log "ERROR: Server crashed $MaxRapidRestarts times in ${RapidRestartWindow}s. Stopping."
        Write-Log "Check logs and run 'lucid status' for diagnostics."
        exit 1
    }

    Write-Log "Starting Lucid Memory server..."

    try {
        $Process = Start-Process -FilePath "bun" -ArgumentList "run", $ServerScript -NoNewWindow -PassThru -Wait
        $ExitCode = $Process.ExitCode
    } catch {
        $ExitCode = 1
        Write-Log "ERROR: Failed to start server: $_"
    }

    if ($ExitCode -eq 0) {
        Write-Log "Server exited cleanly."
        exit 0
    }

    Write-Log "Server crashed with exit code $ExitCode. Restarting in ${RestartDelay}s..."
    Start-Sleep -Seconds $RestartDelay
}
