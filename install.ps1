# Lucid Memory Installer for Windows
#
# One-liner installation (run in PowerShell as Administrator):
#   irm lucidmemory.dev/install.ps1 | iex
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

# Enable ANSI colors in Windows Terminal
$PSStyle.OutputRendering = 'Ansi' 2>$null

# Minimum disk space required (in bytes) - 5GB
$MIN_DISK_SPACE = 5GB

# Progress tracking
$script:TotalSteps = 7
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

Write-Host "Running pre-flight checks..."
Write-Host ""

# Check for git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Fail "Git is not installed" "Please install Git first: https://git-scm.com/download/win"
}
Write-Success "Git installed"

# Check disk space
$Drive = (Get-Item $env:USERPROFILE).PSDrive.Name
$FreeSpace = (Get-PSDrive $Drive).Free
if ($FreeSpace -lt $MIN_DISK_SPACE) {
    $FreeGB = [math]::Round($FreeSpace / 1GB, 1)
    Write-Fail "Insufficient disk space" "Lucid Memory requires at least 5GB of free space.`nAvailable: ${FreeGB}GB"
}
$FreeGB = [math]::Round($FreeSpace / 1GB, 1)
Write-Success "Disk space OK (${FreeGB}GB available)"

# Check for Bun
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host ""
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

# Check for Claude Code
$ClaudeSettingsDir = "$env:USERPROFILE\.claude"
if (-not (Test-Path $ClaudeSettingsDir)) {
    Write-Fail "Claude Code not found" "Please install Claude Code first: https://claude.ai/download`n`nAfter installing, run this installer again."
}
Write-Success "Claude Code found"

# Check existing MCP config (Claude Code uses ~/.claude.json, not claude_desktop_config.json)
$McpConfig = "$env:USERPROFILE\.claude.json"
if (Test-Path $McpConfig) {
    try {
        $null = Get-Content $McpConfig | ConvertFrom-Json
        Write-Success "MCP config valid"
    } catch {
        Write-Fail "Existing MCP config is malformed" "The file $McpConfig contains invalid JSON.`nPlease fix or remove it, then run this installer again."
    }
}

Write-Host ""
Write-Success "All pre-flight checks passed!"
Show-Progress  # Step 1: Pre-flight checks

# === Create Lucid Directory ===

$LucidDir = "$env:USERPROFILE\.lucid"
$LucidBin = "$LucidDir\bin"

Write-Host ""
Write-Host "Creating Lucid Memory directory..."

New-Item -ItemType Directory -Force -Path $LucidDir | Out-Null
New-Item -ItemType Directory -Force -Path $LucidBin | Out-Null

Write-Success "Created ~/.lucid"
Show-Progress  # Step 2: Create directory

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

Set-Location "$LucidDir\server"

Write-Host "Installing dependencies..."
try {
    bun install --production 2>$null
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
Show-Progress  # Step 3: Install server

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

        if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
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
Show-Progress  # Step 4: Embedding provider

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
Show-Progress  # Step 5: Configure Claude Code

# === Install Hooks ===

Write-Host ""
Write-Host "Installing memory hooks..."

# Create hooks directory in lucid folder
$LucidHooksDir = "$LucidDir\hooks"
New-Item -ItemType Directory -Force -Path $LucidHooksDir | Out-Null

# Create PowerShell version of the hook
$HookScript = @"
# Lucid Memory - UserPromptSubmit Hook
# Stores user messages and retrieves relevant context

`$UserPrompt = `$input | Out-String
if (`$UserPrompt.Length -lt 5) { exit 0 }

`$LucidCli = "`$env:USERPROFILE\.lucid\bin\lucid.cmd"
`$ProjectPath = if (`$env:CLAUDE_PROJECT_PATH) { `$env:CLAUDE_PROJECT_PATH } else { Get-Location }

if (Test-Path `$LucidCli) {
    # Store the user message (background job)
    Start-Job -ScriptBlock {
        param(`$cli, `$prompt, `$project)
        & `$cli store `$prompt --type=conversation --project=`$project 2>`$null
    } -ArgumentList `$LucidCli, `$UserPrompt, `$ProjectPath | Out-Null

    # Retrieve relevant context (outputs to stdout)
    & `$LucidCli context `$UserPrompt --project=`$ProjectPath 2>`$null
}
"@
$HookScript | Out-File -FilePath "$LucidHooksDir\user-prompt-submit.ps1" -Encoding UTF8
Write-Success "Hook script installed"

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
Show-Progress  # Step 6: Install hooks & PATH

# === Cleanup ===

Pop-Location
Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue

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
Show-Progress  # Step 7: Restart Claude Code

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
Write-Host "  ${C4}irm lucidmemory.dev/uninstall.ps1 | iex${NC}"
Write-Host ""
Write-Host "${DIM}  ─────────────────────────────────────────${NC}"
Write-Host ""
Write-Host "  ${YELLOW}Note:${NC} Please restart your terminal to use the 'lucid' command."
Write-Host ""
