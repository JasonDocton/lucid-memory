# Lucid Memory Installer for Windows
#
# One-liner installation (run in PowerShell as Administrator):
#   irm https://lucidmemory.dev/install.ps1 | iex
#
# What this does:
#   1. Checks all prerequisites (git, disk space, etc.)
#   2. Installs Bun if needed
#   3. Creates ~/.lucid directory
#   4. Downloads and installs lucid-server
#   5. Sets up Ollama for local embeddings (or OpenAI)
#   6. Configures Claude Code MCP settings
#   7. Installs hooks for automatic memory capture
#   8. Restarts Claude Code to activate

$ErrorActionPreference = "Stop"

# Enable ANSI colors in Windows Terminal (PS 7+ only)
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSStyle.OutputRendering = 'Ansi' }

# Minimum disk space required (in bytes) - 5GB
$MIN_DISK_SPACE = 5GB

# Progress tracking (adjusted dynamically based on what needs installing)
$script:TotalSteps = 8
$script:CurrentStep = 0

# Colors for output
function Write-Success { param($Message) Write-Host "✓ $Message" -ForegroundColor Green }
function Write-Warn { param($Message) Write-Host "⚠️  $Message" -ForegroundColor Yellow }
function Write-Fail {
    param($Message, $Help)
    Write-Host "❌ Error: $Message" -ForegroundColor Red
    if ($Help) { Write-Host $Help -ForegroundColor Yellow }
    exit 1
}

function Show-Banner {
    $e = [char]27
    $C1 = "$e[38;5;99m"   # Purple
    $C2 = "$e[38;5;105m"  # Light purple
    $C3 = "$e[38;5;111m"  # Purple-blue
    $C4 = "$e[38;5;117m"  # Blue
    $C5 = "$e[38;5;123m"  # Light blue
    $C6 = "$e[38;5;159m"  # Cyan
    $NC = "$e[0m"
    $DIM = "$e[2m"

    Write-Host ""
    Write-Host "${C1}  ██╗     ██╗   ██╗ ██████╗██╗██████╗ ${NC}"
    Write-Host "${C2}  ██║     ██║   ██║██╔════╝██║██╔══██╗${NC}"
    Write-Host "${C3}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
    Write-Host "${C4}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
    Write-Host "${C5}  ███████╗╚██████╔╝╚██████╗██║██████╔╝${NC}"
    Write-Host "${C6}  ╚══════╝ ╚═════╝  ╚═════╝╚═╝╚═════╝ ${NC}"
    Write-Host "          ${C3}M ${C4}E ${C5}M ${C6}O ${C5}R ${C4}Y${NC}"
    Write-Host ""
    Write-Host "  ${DIM}Claude Code that remembers.${NC}"
    Write-Host ""
}

function Show-Progress {
    $e = [char]27
    $C4 = "$e[38;5;117m"
    $DIM = "$e[2m"
    $NC = "$e[0m"

    $script:CurrentStep++
    $percent = [math]::Floor($script:CurrentStep * 100 / $script:TotalSteps)
    $filled = [math]::Floor($script:CurrentStep * 30 / $script:TotalSteps)
    $empty = 30 - $filled

    $bar = "${C4}" + ("█" * $filled) + "${DIM}" + ("░" * $empty) + "${NC}"
    Write-Host ""
    Write-Host "    $bar ${DIM}${percent}%${NC}"
    Write-Host ""
}

Show-Banner

# === Pre-flight Checks ===

Write-Host "Checking system requirements..."
Write-Host ""

# Check for git (required, cannot auto-install)
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Fail "Git is not installed" "Please install Git first: https://git-scm.com/download/win"
}

# Check for Claude Code (required, cannot auto-install)
$ClaudeSettingsDir = "$env:USERPROFILE\.claude"
if (-not (Test-Path $ClaudeSettingsDir)) {
    Write-Fail "Claude Code not found" "Please install Claude Code first: https://claude.ai/download`n`nAfter installing, run this installer again."
}

# Check disk space
$Drive = (Get-Item $env:USERPROFILE).PSDrive.Name
$FreeSpace = (Get-PSDrive $Drive).Free
if ($FreeSpace -lt $MIN_DISK_SPACE) {
    $FreeGB = [math]::Round($FreeSpace / 1GB, 1)
    Write-Fail "Insufficient disk space" "Lucid Memory requires at least 5GB of free space.`nAvailable: ${FreeGB}GB"
}
$FreeGB = [math]::Round($FreeSpace / 1GB, 1)

# Check existing MCP config
$McpConfig = "$env:USERPROFILE\.claude.json"
if (Test-Path $McpConfig) {
    try {
        $null = Get-Content $McpConfig | ConvertFrom-Json
    } catch {
        Write-Fail "Existing MCP config is malformed" "The file $McpConfig contains invalid JSON.`nPlease fix or remove it, then run this installer again."
    }
}

# === Detect what needs to be installed ===

$e = [char]27
$C4 = "$e[38;5;117m"
$NC = "$e[0m"
$DIM = "$e[2m"
$BOLD = "$e[1m"

# Add Python user Scripts directories to PATH for detection (pip --user installs go here)
# Windows: %APPDATA%\Python\PythonXX\Scripts
$PythonVersions = @("313", "312", "311", "310", "39", "38")
foreach ($pyver in $PythonVersions) {
    $PyScriptsPath = "$env:APPDATA\Python\Python$pyver\Scripts"
    if (Test-Path $PyScriptsPath) {
        $env:PATH = "$PyScriptsPath;$env:PATH"
        break
    }
}
# Also check the standard user site-packages location
$PyUserScripts = "$env:APPDATA\Python\Scripts"
if (Test-Path $PyUserScripts) {
    $env:PATH = "$PyUserScripts;$env:PATH"
}

$InstallList = @()
$NeedBun = -not (Get-Command bun -ErrorAction SilentlyContinue)
$NeedFfmpeg = -not (Get-Command ffmpeg -ErrorAction SilentlyContinue)
$NeedYtdlp = -not (Get-Command yt-dlp -ErrorAction SilentlyContinue)
$NeedWhisper = -not (Get-Command whisper -ErrorAction SilentlyContinue)
$NeedOllama = -not (Get-Command ollama -ErrorAction SilentlyContinue)
$NeedPip = -not ((Get-Command pip -ErrorAction SilentlyContinue) -or (Get-Command pip3 -ErrorAction SilentlyContinue))

if ($NeedBun) { $InstallList += "  ${C4}•${NC} Bun (JavaScript runtime)" }
if ($NeedFfmpeg) { $InstallList += "  ${C4}•${NC} ffmpeg (video processing)" }
if ($NeedYtdlp) { $InstallList += "  ${C4}•${NC} yt-dlp (video downloads)" }
if ($NeedWhisper) { $InstallList += "  ${C4}•${NC} OpenAI Whisper (audio transcription)" }
if ($NeedOllama) { $InstallList += "  ${C4}•${NC} Ollama + nomic-embed-text (local embeddings)" }

# Always installing these
$InstallList += "  ${C4}•${NC} Lucid Memory server"
$InstallList += "  ${C4}•${NC} Whisper model (74MB)"
$InstallList += "  ${C4}•${NC} Claude Code hooks"

# === Show installation summary ===

Write-Host "${BOLD}The following will be installed:${NC}"
foreach ($item in $InstallList) {
    Write-Host $item
}
Write-Host ""
Write-Host "${DIM}Disk space available: ${FreeGB}GB${NC}"
Write-Host ""

# Ask for confirmation
$Confirm = Read-Host "Continue with installation? [Y/n]"
if (-not $Confirm) { $Confirm = "Y" }
if ($Confirm -notmatch "^[Yy]") {
    Write-Host ""
    Write-Host "Installation cancelled."
    exit 0
}

Write-Host ""
Show-Progress  # Step 1: Pre-flight checks

# === Install Dependencies ===

# Install Bun if needed
if ($NeedBun) {
    Write-Host "Installing Bun..."
    try {
        irm bun.sh/install.ps1 | iex
        $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
    } catch {
        Write-Fail "Bun installation failed" "Please install Bun manually: https://bun.sh"
    }
}
$BunVersion = bun --version
Write-Success "Bun $BunVersion"

# Install ffmpeg if needed
if ($NeedFfmpeg) {
    Write-Host "Installing ffmpeg..."
    $FfmpegInstalled = $false
    try {
        $result = winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements 2>&1
        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
            $FfmpegInstalled = $true
        }
    } catch {
        # winget might throw but still install
    }

    if ($FfmpegInstalled -or (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
        Write-Success "ffmpeg installed"
    } else {
        Write-Fail "Could not install ffmpeg" "Please install manually:`n  winget install Gyan.FFmpeg`n  Or download from: https://ffmpeg.org/download.html"
    }
} else {
    Write-Success "ffmpeg already installed"
}

# Install yt-dlp if needed
if ($NeedYtdlp) {
    Write-Host "Installing yt-dlp..."
    $YtdlpInstalled = $false
    try {
        if (Get-Command pip -ErrorAction SilentlyContinue) {
            pip install --user yt-dlp 2>&1 | Out-Null
            $YtdlpInstalled = $true
        } elseif (Get-Command pip3 -ErrorAction SilentlyContinue) {
            pip3 install --user yt-dlp 2>&1 | Out-Null
            $YtdlpInstalled = $true
        } else {
            winget install --id yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
            $YtdlpInstalled = $true
        }
        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    } catch {
        # Might throw but still install
    }

    # Add Python Scripts to PATH for detection
    foreach ($pyver in @("313", "312", "311", "310", "39", "38")) {
        $PyScriptsPath = "$env:APPDATA\Python\Python$pyver\Scripts"
        if (Test-Path $PyScriptsPath) {
            $env:PATH = "$PyScriptsPath;$env:PATH"
            break
        }
    }

    if ($YtdlpInstalled -or (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
        Write-Success "yt-dlp installed"
    } else {
        Write-Fail "Could not install yt-dlp" "Please install manually:`n  pip install --user yt-dlp`n  Or: winget install yt-dlp.yt-dlp"
    }
} else {
    Write-Success "yt-dlp already installed"
}

# Install whisper if needed
if ($NeedWhisper) {
    Write-Host "Installing OpenAI Whisper (this may take a few minutes)..."
    if ($NeedPip) {
        Write-Fail "pip is not installed" "Please install Python first: https://www.python.org/downloads/`nMake sure to check 'Add Python to PATH' during installation."
    }
    $WhisperInstalled = $false
    try {
        if (Get-Command pip3 -ErrorAction SilentlyContinue) {
            pip3 install --user openai-whisper 2>&1 | Out-Null
            $WhisperInstalled = $true
        } elseif (Get-Command pip -ErrorAction SilentlyContinue) {
            pip install --user openai-whisper 2>&1 | Out-Null
            $WhisperInstalled = $true
        }
        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    } catch {
        # Might throw but still install
    }

    # Add Python Scripts to PATH for detection
    foreach ($pyver in @("313", "312", "311", "310", "39", "38")) {
        $PyScriptsPath = "$env:APPDATA\Python\Python$pyver\Scripts"
        if (Test-Path $PyScriptsPath) {
            $env:PATH = "$PyScriptsPath;$env:PATH"
            break
        }
    }

    if ($WhisperInstalled -or (Get-Command whisper -ErrorAction SilentlyContinue)) {
        Write-Success "Whisper installed"
    } else {
        Write-Fail "Whisper installation failed" "Please install manually:`n  pip install --user openai-whisper`n`nNote: Whisper requires Python 3.8+ and may take several minutes."
    }
} else {
    Write-Success "Whisper already installed"
}

Show-Progress  # Step 2: Install dependencies

# === Create Lucid Directory ===

$LucidDir = "$env:USERPROFILE\.lucid"
$LucidBin = "$LucidDir\bin"

Write-Host ""
Write-Host "Creating Lucid Memory directory..."

New-Item -ItemType Directory -Force -Path $LucidDir | Out-Null
New-Item -ItemType Directory -Force -Path $LucidBin | Out-Null

Write-Success "Created ~/.lucid"
Show-Progress  # Step 3: Create directory

# === Install Lucid Server ===

Write-Host ""
Write-Host "Downloading Lucid Memory..."

$TempDir = New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }
Push-Location $TempDir

try {
    # Prevent git from prompting for credentials if repo not found
    $env:GIT_TERMINAL_PROMPT = "0"
    git clone --depth 1 https://github.com/JasonDocton/lucid-memory.git 2>$null
    if (-not $?) { throw "Clone failed" }
} catch {
    Write-Fail "Could not download Lucid Memory" "Please check your internet connection and try again.`n`nIf the problem persists, the repository may not be available yet.`nVisit: https://github.com/JasonDocton/lucid-memory"
}

# Copy the server
$ServerSource = "lucid-memory\packages\lucid-server"
if (Test-Path $ServerSource) {
    if (Test-Path "$LucidDir\server") { Remove-Item -Recurse -Force "$LucidDir\server" }
    Copy-Item -Recurse $ServerSource "$LucidDir\server"
} else {
    Write-Fail "Invalid repository structure" "The downloaded repository is missing required files."
}

# Copy native package
$NativeSource = "lucid-memory\packages\lucid-native"
if (Test-Path $NativeSource) {
    if (Test-Path "$LucidDir\native") { Remove-Item -Recurse -Force "$LucidDir\native" }
    Copy-Item -Recurse $NativeSource "$LucidDir\native"
}

# Copy perception package (video processing)
$PerceptionSource = "lucid-memory\packages\lucid-perception"
if (Test-Path $PerceptionSource) {
    if (Test-Path "$LucidDir\perception") { Remove-Item -Recurse -Force "$LucidDir\perception" }
    Copy-Item -Recurse $PerceptionSource "$LucidDir\perception"
}

# Copy Rust crates for potential building
$CratesSource = "lucid-memory\crates"
if (Test-Path $CratesSource) {
    if (Test-Path "$LucidDir\crates") { Remove-Item -Recurse -Force "$LucidDir\crates" }
    Copy-Item -Recurse $CratesSource "$LucidDir\crates"
    Copy-Item "lucid-memory\Cargo.toml" "$LucidDir\Cargo.toml"
    if (Test-Path "lucid-memory\Cargo.lock") {
        Copy-Item "lucid-memory\Cargo.lock" "$LucidDir\Cargo.lock"
    }
}

Set-Location "$LucidDir\server"

# === Set up Native Module ===

function Get-NativeBinaryName {
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    return "lucid-native.win32-$arch-msvc.node"
}

$NativeBinary = Get-NativeBinaryName
$NativeReady = $false

# Check if pre-built binary exists in the repo
$NativeBinaryPath = "$LucidDir\native\$NativeBinary"
if ((Test-Path "$LucidDir\native") -and (Test-Path $NativeBinaryPath)) {
    Write-Success "Pre-built native binary found ($NativeBinary)"
    $NativeReady = $true
}

# If no pre-built binary, try to download from latest release
if (-not $NativeReady -and (Test-Path "$LucidDir\native")) {
    Write-Host "Downloading pre-built native binary..."
    $NativeReleaseUrl = "https://github.com/JasonDocton/lucid-memory/releases/latest/download/$NativeBinary"
    try {
        Invoke-WebRequest -Uri $NativeReleaseUrl -OutFile $NativeBinaryPath -ErrorAction Stop
        Write-Success "Downloaded native binary"
        $NativeReady = $true
    } catch {
        Write-Host "  No pre-built native binary available for download"
    }
}

# If still no binary, try to build with Rust
if (-not $NativeReady -and (Test-Path "$LucidDir\native")) {
    if (Get-Command cargo -ErrorAction SilentlyContinue) {
        Write-Host "Building native Rust module (this gives you 100x faster retrieval)..."
        Push-Location "$LucidDir\native"
        try {
            bun install 2>$null
            bun run build 2>$null
            $NativeReady = $true
            Write-Success "Native Rust module built"
        } catch {
            Write-Warn "Native build failed"
        }
        Pop-Location
    }
}

# Final native status
if ($NativeReady) {
    Write-Success "Native module ready (100x faster retrieval)"
} else {
    Write-Warn "Using TypeScript fallback (still works, just slower)"
    Write-Host "  To get 100x faster retrieval, install Rust: https://rustup.rs"
}

# === Set up Perception Module (Video Processing) ===

function Get-PerceptionBinaryName {
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
    return "lucid-perception.win32-$arch-msvc.node"
}

$PerceptionBinary = Get-PerceptionBinaryName
$PerceptionReady = $false

# Check if pre-built binary exists in the repo
$PerceptionBinaryPath = "$LucidDir\perception\$PerceptionBinary"
if ((Test-Path "$LucidDir\perception") -and (Test-Path $PerceptionBinaryPath)) {
    Write-Success "Pre-built perception binary found ($PerceptionBinary)"
    $PerceptionReady = $true
}

# If no pre-built binary, try to download from latest release
if (-not $PerceptionReady -and (Test-Path "$LucidDir\perception")) {
    Write-Host "Downloading pre-built perception binary..."
    $PerceptionReleaseUrl = "https://github.com/JasonDocton/lucid-memory/releases/latest/download/$PerceptionBinary"
    try {
        Invoke-WebRequest -Uri $PerceptionReleaseUrl -OutFile $PerceptionBinaryPath -ErrorAction Stop
        Write-Success "Downloaded perception binary"
        $PerceptionReady = $true
    } catch {
        Write-Host "  No pre-built perception binary available for download"
    }
}

# If still no binary, try to build with Rust
if (-not $PerceptionReady -and (Test-Path "$LucidDir\perception")) {
    if (Get-Command cargo -ErrorAction SilentlyContinue) {
        Write-Host "Building perception module (video processing)..."
        Push-Location "$LucidDir\perception"
        try {
            bun install 2>$null
            bun run build 2>$null
            $PerceptionReady = $true
            Write-Success "Perception module built"
        } catch {
            Write-Warn "Perception build failed"
        }
        Pop-Location
    }
}

# Final perception status
if ($PerceptionReady) {
    Write-Success "Perception module ready (video processing enabled)"
} else {
    Write-Warn "Perception module not available"
    Write-Host "  Video processing will use fallback methods (slower)"
    Write-Host "  To enable, install Rust: https://rustup.rs"
}

# Update package.json to point to local packages
$PkgPath = "$LucidDir\server\package.json"
$Pkg = Get-Content $PkgPath | ConvertFrom-Json

# Handle native package
if (Test-Path "$LucidDir\native") {
    if (-not $Pkg.dependencies) { $Pkg | Add-Member -NotePropertyName "dependencies" -NotePropertyValue @{} -Force }
    $Pkg.dependencies | Add-Member -NotePropertyName "@lucid-memory/native" -NotePropertyValue "file:../native" -Force
} else {
    if ($Pkg.dependencies -and $Pkg.dependencies.'@lucid-memory/native') {
        $Pkg.dependencies.PSObject.Properties.Remove('@lucid-memory/native')
    }
}

# Handle perception package
if (Test-Path "$LucidDir\perception") {
    if (-not $Pkg.dependencies) { $Pkg | Add-Member -NotePropertyName "dependencies" -NotePropertyValue @{} -Force }
    $Pkg.dependencies | Add-Member -NotePropertyName "@lucid-memory/perception" -NotePropertyValue "file:../perception" -Force
    # Remove from optionalDependencies if present
    if ($Pkg.optionalDependencies -and $Pkg.optionalDependencies.'@lucid-memory/perception') {
        $Pkg.optionalDependencies.PSObject.Properties.Remove('@lucid-memory/perception')
    }
} else {
    if ($Pkg.optionalDependencies -and $Pkg.optionalDependencies.'@lucid-memory/perception') {
        $Pkg.optionalDependencies.PSObject.Properties.Remove('@lucid-memory/perception')
    }
    if ($Pkg.dependencies -and $Pkg.dependencies.'@lucid-memory/perception') {
        $Pkg.dependencies.PSObject.Properties.Remove('@lucid-memory/perception')
    }
}

$Pkg | ConvertTo-Json -Depth 10 | Out-File -FilePath $PkgPath -Encoding UTF8

Write-Host "Installing dependencies..."
try {
    bun install 2>$null
    if (-not $?) { throw "bun install failed" }
} catch {
    Write-Fail "Failed to install dependencies" "Bun package installation failed. Check your internet connection."
}

# Create CLI wrapper (batch file for Windows)
@"
@echo off
bun run "%USERPROFILE%\.lucid\server\src\cli.ts" %*
"@ | Out-File -FilePath "$LucidBin\lucid.cmd" -Encoding ASCII

# Create server launcher with auto-restart wrapper
@"
@echo off
powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.lucid\server\bin\lucid-server-wrapper.ps1" %*
"@ | Out-File -FilePath "$LucidBin\lucid-server.cmd" -Encoding ASCII

# Create logs directory
New-Item -ItemType Directory -Force -Path "$LucidDir\logs" | Out-Null

Write-Success "Lucid Memory installed"
Show-Progress  # Step 4: Install server

# === Embedding Provider ===

Write-Host ""
Write-Host "Embedding provider setup:" -ForegroundColor White
Write-Host "  [1] Local (Ollama) - Free, private, runs on your machine (recommended)"
Write-Host "  [2] OpenAI API - Faster, requires API key (`$0.0001/query)"
Write-Host ""
$EmbedChoice = Read-Host "Choice [1]"
if (-not $EmbedChoice) { $EmbedChoice = "1" }

switch ($EmbedChoice) {
    "2" {
        Write-Host ""
        $OpenAIKey = Read-Host "Enter OpenAI API key"
        if (-not $OpenAIKey) {
            Write-Fail "OpenAI API key is required" "Please run the installer again and provide a valid API key,`nor choose option 1 for local embeddings."
        }
        "OPENAI_API_KEY=$OpenAIKey" | Out-File -FilePath "$LucidDir\.env" -Encoding UTF8
        Write-Success "OpenAI configured"
    }
    default {
        Write-Host ""
        Write-Host "Setting up Ollama..."

        # Install Ollama if needed (detected earlier)
        if ($NeedOllama) {
            Write-Host "Installing Ollama..."
            try {
                # Download and run Ollama installer
                $OllamaInstaller = "$env:TEMP\OllamaSetup.exe"
                Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $OllamaInstaller
                Start-Process -FilePath $OllamaInstaller -Wait
                Remove-Item $OllamaInstaller -Force

                # Refresh PATH
                $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
            } catch {
                Write-Fail "Ollama installation failed" "Please install Ollama manually: https://ollama.com`nThen run this installer again."
            }
        }
        Write-Success "Ollama installed"

        # Ensure Ollama is running
        Write-Host "Starting Ollama service..."
        $OllamaProcess = Get-Process -Name "ollama" -ErrorAction SilentlyContinue
        if (-not $OllamaProcess) {
            Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
            Start-Sleep -Seconds 3
        }

        # Verify it's running
        $Retries = 5
        $OllamaRunning = $false
        while ($Retries -gt 0 -and -not $OllamaRunning) {
            try {
                $null = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 2
                $OllamaRunning = $true
            } catch {
                Start-Sleep -Seconds 1
                $Retries--
            }
        }

        if (-not $OllamaRunning) {
            Write-Fail "Could not start Ollama service" "Please start Ollama manually and run this installer again."
        }
        Write-Success "Ollama service running"

        # Create scheduled task for Ollama auto-start (Windows keepalive equivalent)
        try {
            $TaskName = "LucidOllamaKeepAlive"
            $ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

            if (-not $ExistingTask) {
                $OllamaPath = (Get-Command ollama -ErrorAction SilentlyContinue).Source
                if ($OllamaPath) {
                    $Action = New-ScheduledTaskAction -Execute $OllamaPath -Argument "serve"
                    $Trigger = New-ScheduledTaskTrigger -AtLogOn
                    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
                    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Keeps Ollama running for Lucid Memory" | Out-Null
                    Write-Success "Ollama auto-start configured"
                }
            }
        } catch {
            Write-Warn "Could not configure Ollama auto-start. You may need to start Ollama manually after reboots."
        }

        # Pull the embedding model
        Write-Host "Downloading embedding model (this may take a few minutes)..."
        try {
            ollama pull nomic-embed-text
        } catch {
            Write-Fail "Failed to download embedding model" "Please try manually: ollama pull nomic-embed-text"
        }
        Write-Success "Embedding model ready"
    }
}
Show-Progress  # Step 5: Embedding provider

# === Download Whisper Model for Transcription ===

$LucidModels = "$LucidDir\models"
New-Item -ItemType Directory -Force -Path $LucidModels | Out-Null

$WhisperModel = "$LucidModels\ggml-base.en.bin"
if (-not (Test-Path $WhisperModel)) {
    Write-Host ""
    Write-Host "Downloading Whisper model for video transcription (74MB)..."
    try {
        Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" -OutFile $WhisperModel
        Write-Success "Whisper model downloaded"
    } catch {
        Write-Warn "Could not download Whisper model - video transcription will be unavailable"
        Write-Host "  To download manually: Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' -OutFile '$WhisperModel'"
    }
} else {
    Write-Success "Whisper model already present"
}

# === Auto-Update Preference ===

Write-Host ""
Write-Host "${BOLD}Automatic updates:${NC}"
Write-Host "  Lucid Memory can automatically check for and install updates"
Write-Host "  when the server starts. Your data is always preserved."
Write-Host ""

$AutoUpdateChoice = Read-Host "Enable automatic updates? [Y/n]"
if (-not $AutoUpdateChoice) { $AutoUpdateChoice = "Y" }
$AutoUpdate = $AutoUpdateChoice -match "^[Yy]"

# Write config file
$ConfigContent = @{
    autoUpdate = $AutoUpdate
    installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$ConfigContent | ConvertTo-Json | Out-File -FilePath "$LucidDir\config.json" -Encoding UTF8

if ($AutoUpdate) {
    Write-Success "Auto-updates enabled"
} else {
    Write-Success "Auto-updates disabled (run 'lucid update' manually)"
}

# === Configure Claude Code ===

Write-Host ""
Write-Host "Configuring Claude Code..."

$ServerPath = "$LucidBin\lucid-server.cmd"

if (Test-Path $McpConfig) {
    # Backup existing config
    Copy-Item $McpConfig "$McpConfig.backup"
    Write-Success "Backed up existing config"

    # Add our server to existing config
    $Config = Get-Content $McpConfig | ConvertFrom-Json
    if (-not $Config.mcpServers) {
        $Config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue @{}
    }
    $Config.mcpServers | Add-Member -NotePropertyName "lucid-memory" -NotePropertyValue @{
        type = "stdio"
        command = $ServerPath
        args = @()
    } -Force
    $Config | ConvertTo-Json -Depth 10 | Out-File -FilePath $McpConfig -Encoding UTF8
} else {
    # Create new config
    @{
        mcpServers = @{
            "lucid-memory" = @{
                type = "stdio"
                command = $ServerPath
                args = @()
            }
        }
    } | ConvertTo-Json -Depth 10 | Out-File -FilePath $McpConfig -Encoding UTF8
}

Write-Success "MCP server configured"
Show-Progress  # Step 6: Configure Claude Code

# === Install Hooks ===

Write-Host ""
Write-Host "Installing memory hooks..."

# Create hooks directory in lucid folder
$LucidHooksDir = "$LucidDir\hooks"
New-Item -ItemType Directory -Force -Path $LucidHooksDir | Out-Null

# Copy hook script from server package
$HookSource = "$LucidDir\server\hooks\user-prompt-submit.ps1"
if (Test-Path $HookSource) {
    Copy-Item $HookSource "$LucidHooksDir\user-prompt-submit.ps1"
    Write-Success "Hook script installed"
} else {
    Write-Warn "Hook script not found - automatic context injection disabled"
}

# Configure hook in Claude Code settings.json
$ClaudeSettings = "$ClaudeSettingsDir\settings.json"
$HookCommand = "$LucidHooksDir\user-prompt-submit.ps1"

try {
    if (Test-Path $ClaudeSettings) {
        $Config = Get-Content $ClaudeSettings | ConvertFrom-Json
    } else {
        $Config = @{}
    }

    if (-not $Config.hooks) {
        $Config | Add-Member -NotePropertyName "hooks" -NotePropertyValue @{} -Force
    }

    $Config.hooks | Add-Member -NotePropertyName "UserPromptSubmit" -NotePropertyValue @(
        @{
            hooks = @(
                @{
                    type = "command"
                    command = "powershell -ExecutionPolicy Bypass -File `"$HookCommand`""
                }
            )
        }
    ) -Force

    $Config | ConvertTo-Json -Depth 10 | Out-File -FilePath $ClaudeSettings -Encoding UTF8
    Write-Success "Hook configured in settings.json"
} catch {
    Write-Warn "Could not configure hook in settings.json - manual setup may be needed"
}

# === Add to PATH ===

$CurrentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($CurrentPath -notlike "*$LucidBin*") {
    [Environment]::SetEnvironmentVariable("PATH", "$LucidBin;$CurrentPath", "User")
    $env:PATH = "$LucidBin;$env:PATH"
    Write-Success "Added to PATH"
}
Show-Progress  # Step 7: Install hooks & PATH

# === Cleanup ===

Pop-Location
Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue

# === Post-Installation Verification ===

$InstallErrors = @()

# Check critical files exist
if (-not (Test-Path "$LucidDir\server\src\server.ts")) {
    $InstallErrors += "Server script missing"
}

if (-not (Test-Path "$LucidBin\lucid-server.cmd")) {
    $InstallErrors += "Server launcher missing"
}

if (-not (Test-Path "$LucidBin\lucid.cmd")) {
    $InstallErrors += "CLI missing"
}

if (-not (Test-Path $McpConfig)) {
    $InstallErrors += "MCP config not created"
}

# Check Bun is available
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    $InstallErrors += "Bun not in PATH (restart terminal)"
}

if ($InstallErrors.Count -gt 0) {
    Write-Host ""
    Write-Warn "Installation completed with issues:"
    foreach ($err in $InstallErrors) {
        Write-Host "  - $err"
    }
    Write-Host ""
    Write-Host "Run 'lucid status' after restarting your terminal to diagnose."
}

# === Restart Claude Code ===

Write-Host ""
Write-Host "Restarting Claude Code to activate Lucid Memory..."

$ClaudeProcess = Get-Process -Name "Claude*" -ErrorAction SilentlyContinue
if ($ClaudeProcess) {
    $ClaudeProcess | Stop-Process -Force
    Start-Sleep -Seconds 2

    # Try to restart Claude
    $ClaudePath = "$env:LOCALAPPDATA\Programs\Claude\Claude.exe"
    if (Test-Path $ClaudePath) {
        Start-Process -FilePath $ClaudePath
    }
}
Show-Progress  # Step 8: Restart Claude Code

# === Done! ===

$e = [char]27
$C1 = "$e[38;5;99m"
$C2 = "$e[38;5;105m"
$C3 = "$e[38;5;111m"
$C4 = "$e[38;5;117m"
$C5 = "$e[38;5;123m"
$C6 = "$e[38;5;159m"
$NC = "$e[0m"
$DIM = "$e[2m"
$GREEN = "$e[0;32m"
$YELLOW = "$e[1;33m"
$BOLD = "$e[1m"

Write-Host ""
Write-Host "${C1}  ██╗     ██╗   ██╗ ██████╗██╗██████╗ ${NC}"
Write-Host "${C2}  ██║     ██║   ██║██╔════╝██║██╔══██╗${NC}"
Write-Host "${C3}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
Write-Host "${C4}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
Write-Host "${C5}  ███████╗╚██████╔╝╚██████╗██║██████╔╝${NC}"
Write-Host "${C6}  ╚══════╝ ╚═════╝  ╚═════╝╚═╝╚═════╝ ${NC}"
Write-Host "          ${C3}M ${C4}E ${C5}M ${C6}O ${C5}R ${C4}Y${NC}"
Write-Host ""
Write-Host "       ${GREEN}✓${NC} ${BOLD}Installed Successfully!${NC}"
Write-Host ""
Write-Host "  Just use Claude Code normally - your memories"
Write-Host "  build automatically over time."
Write-Host ""
Write-Host "  ${DIM}Troubleshooting:${NC}"
Write-Host "  ${C4}lucid status${NC}  - Check if everything is working"
Write-Host "  ${C4}lucid stats${NC}   - View memory statistics"
Write-Host ""
Write-Host "  ${DIM}To uninstall:${NC}"
Write-Host "  ${C4}irm https://lucidmemory.dev/uninstall.ps1 | iex${NC}"
Write-Host ""
Write-Host "${DIM}  ─────────────────────────────────────────${NC}"
Write-Host ""
Write-Host "  ${YELLOW}Note:${NC} Please restart your terminal to use the 'lucid' command."
Write-Host ""
