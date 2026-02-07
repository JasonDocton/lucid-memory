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

# Force TLS 1.2 — PS 5.1 defaults to TLS 1.0, but GitHub/npm/etc require TLS 1.2+
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Catch unhandled errors so the window doesn't close before users can read them
trap {
    Write-Host ""
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    break
}

# Enable ANSI colors in Windows Terminal (PS 7+ only)
if ($PSVersionTable.PSVersion.Major -ge 7) { $PSStyle.OutputRendering = 'Ansi' }

# Detect if terminal supports ANSI escape codes
# Windows Terminal sets WT_SESSION; ConEmu sets ConEmuANSI; PS 7+ always supports it
$script:SupportsAnsi = ($env:WT_SESSION) -or ($env:ConEmuANSI -eq 'ON') -or ($PSVersionTable.PSVersion.Major -ge 7) -or ($env:TERM_PROGRAM)

# Minimum disk space required (in bytes) - 5GB
$MIN_DISK_SPACE = 5GB

# Progress tracking (adjusted dynamically based on what needs installing)
$script:TotalSteps = 8
$script:CurrentStep = 0

# Write UTF-8 without BOM (PS 5.1's -Encoding UTF8 adds a BOM that breaks JSON parsing)
function Write-Utf8 { param($Path, $Content) [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding $false)) }

# Colors for output
function Write-Success { param($Message) Write-Host "✓ $Message" -ForegroundColor Green }
function Write-Warn { param($Message) Write-Host "⚠️  $Message" -ForegroundColor Yellow }
function Write-Fail {
    param($Message, $Help)
    Write-Host ""
    Write-Host "Error: $Message" -ForegroundColor Red
    if ($Help) { Write-Host $Help -ForegroundColor Yellow }
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

function Show-Banner {
    if ($script:SupportsAnsi) {
        $e = [char]27
        $C1 = "$e[38;5;99m"; $C2 = "$e[38;5;105m"; $C3 = "$e[38;5;111m"
        $C4 = "$e[38;5;117m"; $C5 = "$e[38;5;123m"; $C6 = "$e[38;5;159m"
        $NC = "$e[0m"; $DIM = "$e[2m"
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
    } else {
        Write-Host ""
        Write-Host "  LUCID MEMORY" -ForegroundColor Cyan
        Write-Host "  Claude Code that remembers." -ForegroundColor DarkGray
    }
    Write-Host ""
}

function Show-Progress {
    $script:CurrentStep++
    $percent = [math]::Floor($script:CurrentStep * 100 / $script:TotalSteps)
    $filled = [math]::Floor($script:CurrentStep * 30 / $script:TotalSteps)
    $empty = 30 - $filled

    if ($script:SupportsAnsi) {
        $e = [char]27
        $C4 = "$e[38;5;117m"; $DIM = "$e[2m"; $NC = "$e[0m"
        $bar = "${C4}" + ("█" * $filled) + "${DIM}" + ("░" * $empty) + "${NC}"
        Write-Host ""
        Write-Host "    $bar ${DIM}${percent}%${NC}"
    } else {
        $bar = ("#" * $filled) + ("-" * $empty)
        Write-Host ""
        Write-Host "    [$bar] ${percent}%" -ForegroundColor Cyan
    }
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
try {
    $Drive = (Get-Item $env:USERPROFILE).PSDrive.Name
    $FreeSpace = (Get-PSDrive $Drive).Free
} catch {
    # Fallback for UNC paths / network drives
    $FreeSpace = (Get-WmiObject Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction SilentlyContinue).FreeSpace
    if (-not $FreeSpace) { $FreeSpace = $MIN_DISK_SPACE } # Skip check if we can't determine
}
if ($FreeSpace -lt $MIN_DISK_SPACE) {
    $FreeGB = [math]::Round($FreeSpace / 1GB, 1)
    Write-Fail "Insufficient disk space" "Lucid Memory requires at least 5GB of free space.`nAvailable: ${FreeGB}GB"
}
$FreeGB = [math]::Round($FreeSpace / 1GB, 1)

# Check existing MCP config
$McpConfig = "$env:USERPROFILE\.claude.json"
if (Test-Path $McpConfig) {
    try {
        $null = Get-Content $McpConfig -Raw | ConvertFrom-Json
    } catch {
        Write-Fail "Existing MCP config is malformed" "The file $McpConfig contains invalid JSON.`nPlease fix or remove it, then run this installer again."
    }
}

# === Detect what needs to be installed ===

if ($script:SupportsAnsi) {
    $e = [char]27
    $C4 = "$e[38;5;117m"; $NC = "$e[0m"; $DIM = "$e[2m"; $BOLD = "$e[1m"
} else {
    $C4 = ""; $NC = ""; $DIM = ""; $BOLD = ""
}

# Add Python directories to PATH for detection
$PythonVersions = @("313", "312", "311", "310", "39", "38")
foreach ($pyver in $PythonVersions) {
    # pip --user install location
    $PyScriptsPath = "$env:APPDATA\Python\Python$pyver\Scripts"
    if (Test-Path $PyScriptsPath) {
        $env:PATH = "$PyScriptsPath;$env:PATH"
    }
    # Per-user python.org install location (where pip itself lives)
    $PyInstallPath = "$env:LOCALAPPDATA\Programs\Python\Python$pyver\Scripts"
    if (Test-Path $PyInstallPath) {
        $env:PATH = "$PyInstallPath;$env:PATH"
        break
    }
    # System-wide install locations
    foreach ($sysPath in @("C:\Python$pyver\Scripts", "C:\Program Files\Python$pyver\Scripts")) {
        if (Test-Path $sysPath) {
            $env:PATH = "$sysPath;$env:PATH"
            break
        }
    }
}
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
$HasPip = (Get-Command pip -ErrorAction SilentlyContinue) -or (Get-Command pip3 -ErrorAction SilentlyContinue)
if (-not $HasPip) {
    # Fallback: check if Python can run pip as a module
    cmd /c "python -m pip --version 2>nul" | Out-Null
    if ($LASTEXITCODE -eq 0) { $HasPip = $true }
    if (-not $HasPip) {
        cmd /c "py -m pip --version 2>nul" | Out-Null
        if ($LASTEXITCODE -eq 0) { $HasPip = $true }
    }
}
$NeedPip = -not $HasPip

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
    return
}

Write-Host ""
Show-Progress  # Step 1: Pre-flight checks

# === Install Dependencies ===

# Install Bun if needed
if ($NeedBun) {
    Write-Host "Installing Bun..."
    try {
        irm https://bun.sh/install.ps1 | iex
        $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
    } catch {
        Write-Fail "Bun installation failed" "Please install Bun manually: https://bun.sh"
    }
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Fail "Bun is not available" "Bun installation may have failed. Please install manually: https://bun.sh"
}
$BunVersion = cmd /c "bun --version 2>&1"
Write-Success "Bun $BunVersion"

# Install ffmpeg if needed
if ($NeedFfmpeg) {
    Write-Host "Installing ffmpeg..."
    $FfmpegInstalled = $false
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        cmd /c 'winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements 2>&1'
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
            $FfmpegInstalled = $true
        }
    }

    if ($FfmpegInstalled -or (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
        Write-Success "ffmpeg installed"
    } else {
        Write-Fail "Could not install ffmpeg" "Please install manually: https://ffmpeg.org/download.html`n  Or if you have winget: winget install Gyan.FFmpeg"
    }
} else {
    Write-Success "ffmpeg already installed"
}

# Install yt-dlp if needed
if ($NeedYtdlp) {
    Write-Host "Installing yt-dlp..."
    $YtdlpInstalled = $false
    if (Get-Command pip -ErrorAction SilentlyContinue) {
        cmd /c "pip install --user yt-dlp 2>&1" | Out-Null
        $YtdlpInstalled = $LASTEXITCODE -eq 0
    } elseif (Get-Command pip3 -ErrorAction SilentlyContinue) {
        cmd /c "pip3 install --user yt-dlp 2>&1" | Out-Null
        $YtdlpInstalled = $LASTEXITCODE -eq 0
    } else {
        # Fallback: try pip as a Python module, then winget
        cmd /c "python -m pip install --user yt-dlp 2>&1" | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $YtdlpInstalled = $true
        } else {
            cmd /c "py -m pip install --user yt-dlp 2>&1" | Out-Null
            if ($LASTEXITCODE -eq 0) {
                $YtdlpInstalled = $true
            } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
                cmd /c 'winget install --id yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements 2>&1' | Out-Null
                $YtdlpInstalled = $LASTEXITCODE -eq 0
            }
        }
    }
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

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

# Install whisper if needed (optional — native Rust module handles transcription via whisper.cpp)
if ($NeedWhisper) {
    if (-not $NeedPip) {
        Write-Host "Installing OpenAI Whisper (this may take a few minutes)..."
        $WhisperInstalled = $false
        if (Get-Command pip3 -ErrorAction SilentlyContinue) {
            cmd /c "pip3 install --user openai-whisper 2>&1" | Out-Null
            $WhisperInstalled = $LASTEXITCODE -eq 0
        } elseif (Get-Command pip -ErrorAction SilentlyContinue) {
            cmd /c "pip install --user openai-whisper 2>&1" | Out-Null
            $WhisperInstalled = $LASTEXITCODE -eq 0
        } else {
            cmd /c "python -m pip install --user openai-whisper 2>&1" | Out-Null
            if ($LASTEXITCODE -eq 0) { $WhisperInstalled = $true }
            if (-not $WhisperInstalled) {
                cmd /c "py -m pip install --user openai-whisper 2>&1" | Out-Null
                if ($LASTEXITCODE -eq 0) { $WhisperInstalled = $true }
            }
        }
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

        foreach ($pyver in @("313", "312", "311", "310", "39", "38")) {
            $PyScriptsPath = "$env:APPDATA\Python\Python$pyver\Scripts"
            if (Test-Path $PyScriptsPath) {
                $env:PATH = "$PyScriptsPath;$env:PATH"
                break
            }
        }

        if ($WhisperInstalled -or (Get-Command whisper -ErrorAction SilentlyContinue)) {
            Write-Success "Whisper CLI installed"
        } else {
            Write-Warn "Whisper CLI not installed (video transcription will use native module or be skipped)"
        }
    } else {
        Write-Warn "Whisper CLI skipped (pip not found — video transcription will use native module or be skipped)"
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

$DownloadOk = $false

# Method 1: git clone
try {
    $env:GIT_TERMINAL_PROMPT = "0"
    $gitOutput = git clone --depth 1 https://github.com/JasonDocton/lucid-memory.git 2>&1
    if ($? -and (Test-Path "lucid-memory")) {
        $DownloadOk = $true
    }
} catch {}

# Method 2: Download zip archive (fallback if git clone fails)
if (-not $DownloadOk) {
    Write-Warn "Git clone failed, trying zip download..."
    # Clean up partial git clone directory if it exists
    if (Test-Path "lucid-memory") { Remove-Item -Recurse -Force "lucid-memory" }
    try {
        $ZipUrl = "https://github.com/JasonDocton/lucid-memory/archive/refs/heads/main.zip"
        $ZipPath = Join-Path $TempDir "lucid-memory.zip"
        Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing -ErrorAction Stop
        Expand-Archive -Path $ZipPath -DestinationPath $TempDir -Force
        # GitHub zips extract to lucid-memory-main/
        if (Test-Path "lucid-memory-main") {
            Rename-Item "lucid-memory-main" "lucid-memory"
        }
        if (Test-Path "lucid-memory") {
            $DownloadOk = $true
        }
    } catch {
        Write-Host "  Zip download also failed: $_" -ForegroundColor DarkGray
    }
}

if (-not $DownloadOk) {
    Write-Fail "Could not download Lucid Memory" "Please check your internet connection and try again.`n`nIf the problem persists, try downloading manually:`n  https://github.com/JasonDocton/lucid-memory"
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
        Invoke-WebRequest -UseBasicParsing -Uri $NativeReleaseUrl -OutFile $NativeBinaryPath -ErrorAction Stop
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
        cmd /c "bun install 2>&1" | Out-Null
        cmd /c "bun run build 2>&1" | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $NativeReady = $true
            Write-Success "Native Rust module built"
        } else {
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
        Invoke-WebRequest -UseBasicParsing -Uri $PerceptionReleaseUrl -OutFile $PerceptionBinaryPath -ErrorAction Stop
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
        cmd /c "bun install 2>&1" | Out-Null
        cmd /c "bun run build 2>&1" | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $PerceptionReady = $true
            Write-Success "Perception module built"
        } else {
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
$Pkg = Get-Content $PkgPath -Raw | ConvertFrom-Json

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

Write-Utf8 $PkgPath ($Pkg | ConvertTo-Json -Depth 10)

Write-Host "Installing dependencies..."
# Run bun via cmd.exe so stderr merging happens before PowerShell sees it.
# PS 5.1 converts native stderr lines to red NativeCommandError records;
# cmd /c avoids this entirely by merging stderr→stdout at the shell level.
cmd /c "bun install 2>&1"
$BunExit = $LASTEXITCODE

if ($BunExit -ne 0 -and -not (Test-Path "node_modules")) {
    Write-Fail "Failed to install dependencies" "Bun package installation failed.`n`nTry running manually:`n  cd $LucidDir\server && bun install"
}

# Create CLI wrapper (batch file for Windows)
# Use %USERPROFILE% (resolved at runtime) so non-ASCII usernames work
Write-Utf8 "$LucidBin\lucid.cmd" "@echo off`r`nbun run `"%USERPROFILE%\.lucid\server\src\cli.ts`" %*`r`n"

# Create server launcher with auto-restart wrapper
Write-Utf8 "$LucidBin\lucid-server.cmd" "@echo off`r`npowershell -ExecutionPolicy Bypass -File `"%USERPROFILE%\.lucid\server\bin\lucid-server-wrapper.ps1`" %*`r`n"

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
        Write-Utf8 "$LucidDir\.env" "OPENAI_API_KEY=$OpenAIKey"
        Write-Success "OpenAI configured"
    }
    default {
        Write-Host ""
        Write-Host "Setting up Ollama..."

        # Install Ollama if needed (detected earlier)
        if ($NeedOllama) {
            Write-Host "Downloading Ollama installer (~200MB, this may take a minute)..."
            try {
                $OllamaInstaller = "$env:TEMP\OllamaSetup.exe"
                # Use BITS for background download with progress, fall back to Invoke-WebRequest
                $DownloadOk = $false
                try {
                    $BitsJob = Start-BitsTransfer -Source "https://ollama.com/download/OllamaSetup.exe" -Destination $OllamaInstaller -DisplayName "Ollama" -ErrorAction Stop
                    $DownloadOk = $true
                } catch {
                    # BITS unavailable or failed — fall back
                    Write-Host "  Downloading (no progress available)..." -ForegroundColor DarkGray
                    Invoke-WebRequest -UseBasicParsing -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $OllamaInstaller
                    $DownloadOk = $true
                }

                if ($DownloadOk -and (Test-Path $OllamaInstaller)) {
                    Write-Host "Installing Ollama (silent install)..."
                    # /VERYSILENT skips the GUI wizard entirely
                    $Proc = Start-Process -FilePath $OllamaInstaller -ArgumentList "/VERYSILENT" -Wait -PassThru
                    if ($Proc.ExitCode -ne 0) {
                        throw "Installer exited with code $($Proc.ExitCode)"
                    }
                    Remove-Item $OllamaInstaller -Force -ErrorAction SilentlyContinue
                }

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
            Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden -ErrorAction SilentlyContinue
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
        # Run via cmd /c — ollama writes download progress to stderr which
        # triggers NativeCommandError in PS 5.1 with ErrorActionPreference=Stop
        cmd /c "ollama pull nomic-embed-text 2>&1"
        if ($LASTEXITCODE -ne 0) {
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
        Invoke-WebRequest -UseBasicParsing -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" -OutFile $WhisperModel
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
Write-Utf8 "$LucidDir\config.json" ($ConfigContent | ConvertTo-Json)

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
    $Config = Get-Content $McpConfig -Raw | ConvertFrom-Json
    if (-not $Config.mcpServers) {
        $Config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue (New-Object PSObject) -Force
    }
    $Config.mcpServers | Add-Member -NotePropertyName "lucid-memory" -NotePropertyValue ([PSCustomObject]@{
        type = "stdio"
        command = $ServerPath
        args = @()
    }) -Force
    Write-Utf8 $McpConfig ($Config | ConvertTo-Json -Depth 10)
} else {
    # Create new config
    $NewConfig = @{
        mcpServers = @{
            "lucid-memory" = @{
                type = "stdio"
                command = $ServerPath
                args = @()
            }
        }
    }
    Write-Utf8 $McpConfig ($NewConfig | ConvertTo-Json -Depth 10)
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
        $Config = Get-Content $ClaudeSettings -Raw | ConvertFrom-Json
    } else {
        # Must use PSCustomObject, not @{} — PS 5.1 ConvertTo-Json on a
        # Hashtable ignores NoteProperties added via Add-Member
        $Config = New-Object PSObject
    }

    if (-not $Config.hooks) {
        $Config | Add-Member -NotePropertyName "hooks" -NotePropertyValue (New-Object PSObject) -Force
    }

    $Config.hooks | Add-Member -NotePropertyName "UserPromptSubmit" -NotePropertyValue @(
        [PSCustomObject]@{
            hooks = @(
                [PSCustomObject]@{
                    type = "command"
                    command = "powershell -ExecutionPolicy Bypass -File `"$HookCommand`""
                }
            )
        }
    ) -Force

    Write-Utf8 $ClaudeSettings ($Config | ConvertTo-Json -Depth 10)
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

if ($script:SupportsAnsi) {
    $e = [char]27
    $C1 = "$e[38;5;99m"; $C2 = "$e[38;5;105m"; $C3 = "$e[38;5;111m"
    $C4 = "$e[38;5;117m"; $C5 = "$e[38;5;123m"; $C6 = "$e[38;5;159m"
    $NC = "$e[0m"; $DIM = "$e[2m"; $GREEN = "$e[0;32m"; $YELLOW = "$e[1;33m"; $BOLD = "$e[1m"
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
} else {
    Write-Host ""
    Write-Host "  LUCID MEMORY" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  ✓ Installed Successfully!" -ForegroundColor Green
}
Write-Host ""
Write-Host "  Just use Claude Code normally - your memories"
Write-Host "  build automatically over time."
Write-Host ""
Write-Host "  Troubleshooting:" -ForegroundColor DarkGray
Write-Host "  lucid status" -ForegroundColor Cyan -NoNewline; Write-Host "  - Check if everything is working"
Write-Host "  lucid stats" -ForegroundColor Cyan -NoNewline; Write-Host "   - View memory statistics"
Write-Host ""
Write-Host "  To uninstall:" -ForegroundColor DarkGray
Write-Host "  irm https://lucidmemory.dev/uninstall.ps1 | iex" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Note: Please restart your terminal to use the 'lucid' command." -ForegroundColor Yellow
Write-Host ""
