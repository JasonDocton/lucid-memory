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
#   5. Downloads BGE embedding model (or configures OpenAI)
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
        Write-Host "  ${DIM}AI coding assistants that remember.${NC}"
    } else {
        Write-Host ""
        Write-Host "  LUCID MEMORY" -ForegroundColor Cyan
        Write-Host "  AI coding assistants that remember." -ForegroundColor DarkGray
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

# Check for Claude Code (optional - user may install for other clients only)
$ClaudeSettingsDir = "$env:USERPROFILE\.claude"
if (-not (Test-Path $ClaudeSettingsDir)) {
    Write-Warn "Claude Code not found ($ClaudeSettingsDir does not exist)"
    Write-Host "  If you plan to use Claude Code, install it first: https://claude.ai/download"
    Write-Host ""
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
# Always installing these
$InstallList += "  ${C4}•${NC} Lucid Memory server"
$InstallList += "  ${C4}•${NC} BGE embedding model (~220MB)"
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
        # Verify download is not empty (404 pages can create 0-byte files)
        if ((Test-Path $NativeBinaryPath) -and (Get-Item $NativeBinaryPath).Length -gt 0) {
            Write-Success "Downloaded native binary"
            $NativeReady = $true
        } else {
            Remove-Item $NativeBinaryPath -Force -ErrorAction SilentlyContinue
            Write-Host "  Downloaded file was empty, skipping"
        }
    } catch {
        Remove-Item $NativeBinaryPath -Force -ErrorAction SilentlyContinue
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
        if ((Test-Path $PerceptionBinaryPath) -and (Get-Item $PerceptionBinaryPath).Length -gt 0) {
            Write-Success "Downloaded perception binary"
            $PerceptionReady = $true
        } else {
            Remove-Item $PerceptionBinaryPath -Force -ErrorAction SilentlyContinue
            Write-Host "  Downloaded file was empty, skipping"
        }
    } catch {
        Remove-Item $PerceptionBinaryPath -Force -ErrorAction SilentlyContinue
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

# Retry once — Windows Defender can briefly lock newly-downloaded .node files,
# causing EPERM when Bun tries to copy workspace packages
if ($BunExit -ne 0) {
    Write-Host "  Retrying package install..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 3
    cmd /c "bun install 2>&1"
    $BunExit = $LASTEXITCODE
}

if ($BunExit -ne 0 -and -not (Test-Path "node_modules")) {
    Write-Fail "Failed to install dependencies" "Bun package installation failed.`n`nTry running manually:`n  cd $LucidDir\server && bun install"
}

# Verify workspace packages installed — if they failed (EPERM), remove the
# file: references from package.json so Bun's resolver doesn't segfault
$PkgFixNeeded = $false
$Pkg2 = Get-Content $PkgPath -Raw | ConvertFrom-Json
if ($Pkg2.dependencies.'@lucid-memory/native' -and -not (Test-Path "node_modules\@lucid-memory\native")) {
    Write-Warn "Native package failed to install — using TypeScript fallback"
    $Pkg2.dependencies.PSObject.Properties.Remove('@lucid-memory/native')
    $PkgFixNeeded = $true
}
if ($Pkg2.dependencies.'@lucid-memory/perception' -and -not (Test-Path "node_modules\@lucid-memory\perception")) {
    Write-Warn "Perception package failed to install — using fallback"
    $Pkg2.dependencies.PSObject.Properties.Remove('@lucid-memory/perception')
    $PkgFixNeeded = $true
}
if ($PkgFixNeeded) {
    Write-Utf8 $PkgPath ($Pkg2 | ConvertTo-Json -Depth 10)
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

# Built-in BGE-base-en-v1.5 model runs in-process (no external services needed)
# OpenAI API key is an optional override for power users
Write-Host ""
Write-Host "Embedding provider:" -ForegroundColor White
Write-Host "  Using built-in BGE-base-en-v1.5 model (no external services needed)"
Write-Host ""
Write-Host "  Optional: provide an OpenAI API key to use cloud embeddings instead."
Write-Host ""
$OpenAIKey = Read-Host "OpenAI API key (press Enter to skip)"
if ($OpenAIKey) {
    Write-Utf8 "$LucidDir\.env" "OPENAI_API_KEY=$OpenAIKey"
    Write-Success "OpenAI configured as embedding provider"
} else {
    Write-Success "Using built-in BGE embeddings (recommended)"
}
# === Client Selection ===

Write-Host ""
Write-Host "${BOLD}Which AI coding assistants do you use?${NC}"
Write-Host "  [1] Claude Code"
Write-Host "  [2] OpenAI Codex"
Write-Host "  [3] OpenCode"
Write-Host ""
Write-Host "  Enter numbers separated by spaces (e.g. '1 3')"
Write-Host "  Press Enter for all clients."
Write-Host ""

$ClientInput = Read-Host "Choice"
if (-not $ClientInput) { $ClientInput = "1 2 3" }

$InstallClaude = $false
$InstallCodex = $false
$InstallOpenCode = $false
$ValidSelection = $false

foreach ($num in $ClientInput.Trim().Split(' ', [StringSplitOptions]::RemoveEmptyEntries)) {
    switch ($num) {
        "1" { $InstallClaude = $true; $ValidSelection = $true }
        "2" { $InstallCodex = $true; $ValidSelection = $true }
        "3" { $InstallOpenCode = $true; $ValidSelection = $true }
    }
}

if (-not $ValidSelection) {
    Write-Warn "Invalid selection, defaulting to Claude Code"
    $InstallClaude = $true
}

# === Database Mode ===

$DbMode = "shared"
$ClaudeProfile = "default"
$CodexProfile = "default"
$OpenCodeProfile = "default"

$SelectedCount = 0
if ($InstallClaude) { $SelectedCount++ }
if ($InstallCodex) { $SelectedCount++ }
if ($InstallOpenCode) { $SelectedCount++ }

if ($SelectedCount -ge 2) {
    Write-Host ""
    Write-Host "${BOLD}Database configuration:${NC}"
    Write-Host "  [1] Shared - Same memories for all clients (recommended)"
    Write-Host "  [2] Separate - Each client has its own database"
    Write-Host "  [3] Profiles - Custom profiles (e.g., work vs home)"
    Write-Host ""

    $DbChoice = Read-Host "Choice [1]"
    if (-not $DbChoice) { $DbChoice = "1" }

    switch ($DbChoice) {
        "2" { $DbMode = "per-client" }
        "3" {
            $DbMode = "profiles"
            if ($InstallClaude) {
                $ClaudeProfile = Read-Host "Profile for Claude Code [home]"
                if (-not $ClaudeProfile) { $ClaudeProfile = "home" }
                $ClaudeProfile = $ClaudeProfile -replace '[^a-zA-Z0-9_-]', ''
            }
            if ($InstallCodex) {
                $CodexProfile = Read-Host "Profile for Codex [work]"
                if (-not $CodexProfile) { $CodexProfile = "work" }
                $CodexProfile = $CodexProfile -replace '[^a-zA-Z0-9_-]', ''
            }
            if ($InstallOpenCode) {
                $OpenCodeProfile = Read-Host "Profile for OpenCode [default]"
                if (-not $OpenCodeProfile) { $OpenCodeProfile = "default" }
                $OpenCodeProfile = $OpenCodeProfile -replace '[^a-zA-Z0-9_-]', ''
            }
        }
    }
}

Show-Progress  # Step 5: Embedding provider & client selection

# === Download Models ===

$LucidModels = "$LucidDir\models"
New-Item -ItemType Directory -Force -Path $LucidModels | Out-Null

# BGE embedding model (quantized ONNX, ~110MB) — downloaded from HuggingFace CDN
# Note: model_quantized.onnx is used instead of model_fp16.onnx because the FP16
# variant contains ORT graph optimizations incompatible with ort 2.0.0-rc.11.
$BgeModelUrl = "https://huggingface.co/Xenova/bge-base-en-v1.5/resolve/main/onnx/model_quantized.onnx"
$BgeTokenizerUrl = "https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/tokenizer.json"

# Clean up old FP16 model (incompatible with ort 2.x)
$OldFp16Model = "$LucidModels\bge-base-en-v1.5-fp16.onnx"
if (Test-Path $OldFp16Model) {
    Remove-Item $OldFp16Model -Force -ErrorAction SilentlyContinue
    Write-Host "Removed old FP16 model (incompatible with current runtime)"
}

$BgeModel = "$LucidModels\bge-base-en-v1.5-quantized.onnx"
if (-not (Test-Path $BgeModel)) {
    Write-Host ""
    Write-Host "Downloading BGE embedding model (~110MB)..."
    try {
        $OldProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri $BgeModelUrl -OutFile "$BgeModel.tmp"
        $ProgressPreference = $OldProgress
        # Validate file is actually a model (>30MB), not a CDN error page
        $FileSize = (Get-Item "$BgeModel.tmp").Length
        if ($FileSize -gt 30000000) {
            Move-Item "$BgeModel.tmp" $BgeModel -Force
            Write-Success "BGE embedding model downloaded"
        } else {
            Remove-Item "$BgeModel.tmp" -Force -ErrorAction SilentlyContinue
            Write-Warn "Downloaded BGE model is too small ($FileSize bytes) - may be corrupted"
        }
    } catch {
        $ProgressPreference = $OldProgress
        Remove-Item "$BgeModel.tmp" -Force -ErrorAction SilentlyContinue
        Remove-Item $BgeModel -Force -ErrorAction SilentlyContinue
        Write-Warn "Could not download BGE model - embeddings will fall back to OpenAI if available"
    }
} else {
    Write-Success "BGE embedding model already present"
}

$BgeTokenizer = "$LucidModels\bge-base-en-v1.5-tokenizer.json"
if (-not (Test-Path $BgeTokenizer)) {
    Write-Host "Downloading BGE tokenizer..."
    try {
        $OldProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri $BgeTokenizerUrl -OutFile "$BgeTokenizer.tmp"
        $ProgressPreference = $OldProgress
        Move-Item "$BgeTokenizer.tmp" $BgeTokenizer -Force
        Write-Success "BGE tokenizer downloaded"
    } catch {
        $ProgressPreference = $OldProgress
        Remove-Item "$BgeTokenizer.tmp" -Force -ErrorAction SilentlyContinue
        Remove-Item $BgeTokenizer -Force -ErrorAction SilentlyContinue
        Write-Warn "Could not download BGE tokenizer"
    }
} else {
    Write-Success "BGE tokenizer already present"
}

# Whisper model for video transcription (74MB)
$WhisperModel = "$LucidModels\ggml-base.en.bin"
if (-not (Test-Path $WhisperModel)) {
    Write-Host ""
    Write-Host "Downloading Whisper model for video transcription (74MB)..."
    try {
        $OldProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" -OutFile "$WhisperModel.tmp"
        $ProgressPreference = $OldProgress
        Move-Item "$WhisperModel.tmp" $WhisperModel -Force
        Write-Success "Whisper model downloaded"
    } catch {
        $ProgressPreference = $OldProgress
        Remove-Item "$WhisperModel.tmp" -Force -ErrorAction SilentlyContinue
        Remove-Item $WhisperModel -Force -ErrorAction SilentlyContinue
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

# Write config file with multi-client support
$Clients = New-Object PSObject
if ($InstallClaude) {
    $Clients | Add-Member -NotePropertyName "claude" -NotePropertyValue ([PSCustomObject]@{ enabled = $true; profile = $ClaudeProfile })
}
if ($InstallCodex) {
    $Clients | Add-Member -NotePropertyName "codex" -NotePropertyValue ([PSCustomObject]@{ enabled = $true; profile = $CodexProfile })
}
if ($InstallOpenCode) {
    $Clients | Add-Member -NotePropertyName "opencode" -NotePropertyValue ([PSCustomObject]@{ enabled = $true; profile = $OpenCodeProfile })
}

$Profiles = New-Object PSObject
$Profiles | Add-Member -NotePropertyName "default" -NotePropertyValue ([PSCustomObject]@{ dbPath = "~/.lucid/memory.db" })
$SeenProfiles = @("default")
foreach ($prof in @($ClaudeProfile, $CodexProfile, $OpenCodeProfile)) {
    if ($prof -ne "default" -and $prof -notin $SeenProfiles) {
        $Profiles | Add-Member -NotePropertyName $prof -NotePropertyValue ([PSCustomObject]@{ dbPath = "~/.lucid/memory-$prof.db" })
        $SeenProfiles += $prof
    }
}

$ConfigContent = [PSCustomObject]@{
    autoUpdate = $AutoUpdate
    installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    databaseMode = $DbMode
    clients = $Clients
    profiles = $Profiles
}
Write-Utf8 "$LucidDir\config.json" ($ConfigContent | ConvertTo-Json -Depth 10)

if ($AutoUpdate) {
    Write-Success "Auto-updates enabled"
} else {
    Write-Success "Auto-updates disabled (run 'lucid update' manually)"
}

# === Configure Clients ===

$ServerPath = "$LucidBin\lucid-server.cmd"

# === Configure Claude Code ===

if ($InstallClaude) {
    Write-Host ""
    Write-Host "Configuring Claude Code..."

    if (Test-Path $McpConfig) {
        Copy-Item $McpConfig "$McpConfig.backup"
        Write-Success "Backed up existing config"

        $Config = Get-Content $McpConfig -Raw | ConvertFrom-Json
        if (-not $Config.mcpServers) {
            $Config | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue (New-Object PSObject) -Force
        }
        $Config.mcpServers | Add-Member -NotePropertyName "lucid-memory" -NotePropertyValue ([PSCustomObject]@{
            type = "stdio"
            command = $ServerPath
            args = @()
            env = [PSCustomObject]@{ LUCID_CLIENT = "claude" }
        }) -Force
        Write-Utf8 $McpConfig ($Config | ConvertTo-Json -Depth 10)
    } else {
        $NewConfig = [PSCustomObject]@{
            mcpServers = [PSCustomObject]@{
                "lucid-memory" = [PSCustomObject]@{
                    type = "stdio"
                    command = $ServerPath
                    args = @()
                    env = [PSCustomObject]@{ LUCID_CLIENT = "claude" }
                }
            }
        }
        Write-Utf8 $McpConfig ($NewConfig | ConvertTo-Json -Depth 10)
    }
    Write-Success "Claude Code MCP configured"
}

# === Configure OpenAI Codex ===

if ($InstallCodex) {
    Write-Host ""
    Write-Host "Configuring OpenAI Codex..."

    $CodexDir = "$env:USERPROFILE\.codex"
    $CodexConfig = "$CodexDir\config.toml"
    New-Item -ItemType Directory -Force -Path $CodexDir | Out-Null

    if (Test-Path $CodexConfig) {
        Copy-Item $CodexConfig "$CodexConfig.backup"
    }

    # Remove existing lucid-memory section if present
    if ((Test-Path $CodexConfig) -and (Select-String -Path $CodexConfig -Pattern '^\[mcp_servers\.lucid-memory\]' -Quiet)) {
        $Lines = Get-Content $CodexConfig
        $NewLines = @()
        $Skip = $false
        foreach ($line in $Lines) {
            if ($line -match '^\[mcp_servers\.lucid-memory\]') { $Skip = $true; continue }
            if ($line -match '^\[' -and $Skip) { $Skip = $false }
            if (-not $Skip) { $NewLines += $line }
        }
        $NewLines | Set-Content $CodexConfig
    }

    # Append new config
    $CodexToml = @"

[mcp_servers.lucid-memory]
enabled = true
command = "$env:USERPROFILE\.lucid\bin\lucid-server.cmd"
args = []

[mcp_servers.lucid-memory.env]
LUCID_CLIENT = "codex"
"@
    Add-Content -Path $CodexConfig -Value $CodexToml
    Write-Success "Codex MCP configured"
}

# === Configure OpenCode ===

if ($InstallOpenCode) {
    Write-Host ""
    Write-Host "Configuring OpenCode..."

    $OpenCodeDir = "$env:USERPROFILE\.config\opencode"
    $OpenCodeConfig = "$OpenCodeDir\opencode.json"
    New-Item -ItemType Directory -Force -Path $OpenCodeDir | Out-Null

    if (Test-Path $OpenCodeConfig) {
        Copy-Item $OpenCodeConfig "$OpenCodeConfig.backup"
        $OcConfig = Get-Content $OpenCodeConfig -Raw | ConvertFrom-Json
    } else {
        $OcConfig = New-Object PSObject
    }

    if (-not $OcConfig.mcp) {
        $OcConfig | Add-Member -NotePropertyName "mcp" -NotePropertyValue (New-Object PSObject) -Force
    }
    $OcConfig.mcp | Add-Member -NotePropertyName "lucid-memory" -NotePropertyValue ([PSCustomObject]@{
        type = "local"
        command = @("powershell", "-ExecutionPolicy", "Bypass", "-File", "$env:USERPROFILE\.lucid\bin\lucid-server.cmd")
        environment = [PSCustomObject]@{ LUCID_CLIENT = "opencode" }
    }) -Force
    Write-Utf8 $OpenCodeConfig ($OcConfig | ConvertTo-Json -Depth 10)

    # Install plugin
    $PluginDir = "$OpenCodeDir\plugins"
    New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
    $PluginSource = "$LucidDir\server\plugins\opencode-lucid-memory.ts"
    if (Test-Path $PluginSource) {
        Copy-Item $PluginSource "$PluginDir\lucid-memory.ts"
        Write-Success "OpenCode plugin installed"
    } else {
        Write-Warn "OpenCode plugin not found in server package"
    }
    Write-Success "OpenCode MCP configured"
}

Show-Progress  # Step 6: Configure clients

# === Install Hooks ===

Write-Host ""
Write-Host "Installing memory hooks..."

# Create hooks directory in lucid folder
$LucidHooksDir = "$LucidDir\hooks"
New-Item -ItemType Directory -Force -Path $LucidHooksDir | Out-Null

if ($InstallClaude) {
    # Copy hook script from server package
    $HookSource = "$LucidDir\server\hooks\user-prompt-submit.ps1"
    if (Test-Path $HookSource) {
        Copy-Item $HookSource "$LucidHooksDir\user-prompt-submit.ps1"
        Write-Success "Claude hook script installed"
    } else {
        Write-Warn "Claude hook script not found - automatic context injection disabled"
    }

    # Configure hook in Claude Code settings.json
    $ClaudeSettings = "$ClaudeSettingsDir\settings.json"
    $HookCommand = "$LucidHooksDir\user-prompt-submit.ps1"

    try {
        if (Test-Path $ClaudeSettings) {
            $Config = Get-Content $ClaudeSettings -Raw | ConvertFrom-Json
        } else {
            $Config = New-Object PSObject
        }

        if (-not $Config.hooks) {
            $Config | Add-Member -NotePropertyName "hooks" -NotePropertyValue (New-Object PSObject) -Force
        }

        $LucidHookEntry = [PSCustomObject]@{
            hooks = @(
                [PSCustomObject]@{
                    type = "command"
                    command = "powershell -ExecutionPolicy Bypass -File `"$HookCommand`""
                }
            )
        }
        $ExistingHooks = @()
        if ($Config.hooks.UserPromptSubmit) {
            $ExistingHooks = @($Config.hooks.UserPromptSubmit | Where-Object {
                $IsLucid = $false
                if ($_.hooks) {
                    foreach ($h in $_.hooks) {
                        if ($h.command -and $h.command -match 'lucid|user-prompt-submit') { $IsLucid = $true }
                    }
                }
                -not $IsLucid
            })
        }
        $Config.hooks | Add-Member -NotePropertyName "UserPromptSubmit" -NotePropertyValue @($ExistingHooks + $LucidHookEntry) -Force

        Write-Utf8 $ClaudeSettings ($Config | ConvertTo-Json -Depth 10)
        Write-Success "Claude hook configured in settings.json"
    } catch {
        Write-Warn "Could not configure Claude hook in settings.json - manual setup may be needed"
    }
}

if ($InstallCodex) {
    # Copy codex hook script if available
    $CodexHookSource = "$LucidDir\server\hooks\codex-notify.sh"
    if (Test-Path $CodexHookSource) {
        Copy-Item $CodexHookSource "$LucidHooksDir\codex-notify.sh"
        Write-Success "Codex hook script installed"
    }
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

if ($InstallClaude -and -not (Test-Path $McpConfig)) {
    $InstallErrors += "Claude MCP config not created"
}

if ($InstallOpenCode) {
    $OcConfigPath = "$env:USERPROFILE\.config\opencode\opencode.json"
    if ((Test-Path $OcConfigPath) -and -not (Select-String -Path $OcConfigPath -Pattern "lucid-memory" -Quiet)) {
        $InstallErrors += "OpenCode MCP config missing lucid-memory entry"
    }
    if (-not (Test-Path "$env:USERPROFILE\.config\opencode\plugins\lucid-memory.ts")) {
        $InstallErrors += "OpenCode plugin not installed"
    }
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

if ($InstallClaude) {
    Write-Host ""
    Write-Host "Restarting Claude Code to activate Lucid Memory..."

    $ClaudeProcess = Get-Process -Name "Claude*" -ErrorAction SilentlyContinue
    if ($ClaudeProcess) {
        $ClaudeProcess | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2

        # Try to restart Claude
        $ClaudePath = "$env:LOCALAPPDATA\Programs\Claude\Claude.exe"
        if (Test-Path $ClaudePath) {
            Start-Process -FilePath $ClaudePath
        }
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
Write-Host "  Just use your AI coding assistant normally -"
Write-Host "  your memories build automatically over time."
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
