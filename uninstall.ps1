# Lucid Memory Uninstaller for Windows
#
# One-liner uninstall (run in PowerShell):
#   irm https://lucidmemory.dev/uninstall.ps1 | iex
#
# What this does:
#   1. Removes ~/.lucid directory
#   2. Removes MCP server config from Claude Code
#   3. Removes hooks from Claude Code
#   4. Removes PATH entry
#   5. Removes downloaded models

$ErrorActionPreference = "Stop"

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

# Colors
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

function Write-Success { param($Message) Write-Host "  ${GREEN}✓${NC} $Message" }
function Write-Warn { param($Message) Write-Host "  ${YELLOW}⚠${NC}  $Message" }
function Write-Info { param($Message) Write-Host "  ${DIM}→${NC} $Message" }

function Show-Banner {
    Write-Host ""
    Write-Host "${C1}  ██╗     ██╗   ██╗ ██████╗██╗██████╗ ${NC}"
    Write-Host "${C2}  ██║     ██║   ██║██╔════╝██║██╔══██╗${NC}"
    Write-Host "${C3}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
    Write-Host "${C4}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
    Write-Host "${C5}  ███████╗╚██████╔╝╚██████╗██║██████╔╝${NC}"
    Write-Host "${C6}  ╚══════╝ ╚═════╝  ╚═════╝╚═╝╚═════╝ ${NC}"
    Write-Host "          ${C3}M ${C4}E ${C5}M ${C6}O ${C5}R ${C4}Y${NC}"
    Write-Host ""
    Write-Host "          ${DIM}Uninstaller${NC}"
    Write-Host ""
}

Show-Banner

$LucidDir = "$env:USERPROFILE\.lucid"
$ClaudeSettingsDir = "$env:USERPROFILE\.claude"
# Claude Code uses ~/.claude.json for MCP servers
$McpConfig = "$env:USERPROFILE\.claude.json"

# Check if Lucid is installed
if (-not (Test-Path $LucidDir)) {
    Write-Host "  ${YELLOW}Lucid Memory is not installed.${NC}"
    Write-Host ""
    return
}

# === Show removal summary ===

$RemoveList = @()
$RemoveList += "  ${C4}•${NC} ~/.lucid directory (server, models, database)"

if ((Test-Path $McpConfig) -and (Select-String -Path $McpConfig -Pattern "lucid-memory" -Quiet)) {
    $RemoveList += "  ${C4}•${NC} MCP server config from ~/.claude.json"
}

$ClaudeSettings = "$ClaudeSettingsDir\settings.json"
if ((Test-Path $ClaudeSettings) -and (Select-String -Path $ClaudeSettings -Pattern "UserPromptSubmit" -Quiet)) {
    $RemoveList += "  ${C4}•${NC} Hook config from ~/.claude/settings.json"
}

# Check for PATH entry
$LucidBin = "$LucidDir\bin"
$CurrentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($CurrentPath -like "*$LucidBin*") {
    $RemoveList += "  ${C4}•${NC} PATH entry"
}

Write-Host "${BOLD}The following will be removed:${NC}"
foreach ($item in $RemoveList) {
    Write-Host $item
}
Write-Host ""

# Confirm uninstall
$Confirm = Read-Host "  Continue with uninstall? [y/N]"
if ($Confirm -notmatch "^[Yy]$") {
    Write-Host ""
    Write-Host "  ${DIM}Uninstall cancelled.${NC}"
    Write-Host ""
    return
}
Write-Host ""

# === Remove MCP Config ===

if (Test-Path $McpConfig) {
    Write-Info "Removing MCP server config..."
    try {
        $Config = Get-Content $McpConfig -Raw | ConvertFrom-Json
        if ($Config.mcpServers -and $Config.mcpServers.'lucid-memory') {
            $Config.mcpServers.PSObject.Properties.Remove('lucid-memory')
            $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
            [System.IO.File]::WriteAllText($McpConfig, ($Config | ConvertTo-Json -Depth 10), $Utf8NoBom)
        }
        Write-Success "MCP server config removed"
    } catch {
        Write-Warn "Could not edit MCP config - please remove 'lucid-memory' manually"
    }
}

# === Remove Hooks ===

# Remove hook configuration from settings.json
$ClaudeSettings = "$ClaudeSettingsDir\settings.json"
if (Test-Path $ClaudeSettings) {
    Write-Info "Removing hook configuration..."
    try {
        $Config = Get-Content $ClaudeSettings -Raw | ConvertFrom-Json
        if ($Config.hooks -and $Config.hooks.UserPromptSubmit) {
            # Filter out only Lucid's hook entries, preserve others
            $Remaining = @($Config.hooks.UserPromptSubmit | Where-Object {
                $IsLucid = $false
                if ($_.hooks) {
                    foreach ($h in $_.hooks) {
                        if ($h.command -and $h.command -match 'lucid|user-prompt-submit') { $IsLucid = $true }
                    }
                }
                -not $IsLucid
            })
            if ($Remaining.Count -eq 0) {
                $Config.hooks.PSObject.Properties.Remove('UserPromptSubmit')
            } else {
                $Config.hooks.UserPromptSubmit = $Remaining
            }
            $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
            [System.IO.File]::WriteAllText($ClaudeSettings, ($Config | ConvertTo-Json -Depth 10), $Utf8NoBom)
        }
        Write-Success "Hook config removed from settings.json"
    } catch {
        Write-Warn "Could not remove hook config - please edit $ClaudeSettings manually"
    }
}

# Remove old hook file location (legacy)
$OldHooksDir = "$ClaudeSettingsDir\hooks"
$OldHookFile = "$OldHooksDir\UserPromptSubmit.ps1"
if (Test-Path $OldHookFile) {
    Remove-Item -Force $OldHookFile
}

# === Remove PATH Entry ===

Write-Info "Removing PATH entry..."
$LucidBin = "$LucidDir\bin"
$CurrentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($CurrentPath -like "*$LucidBin*") {
    $NewPath = ($CurrentPath -split ";" | Where-Object { $_ -ne $LucidBin }) -join ";"
    [Environment]::SetEnvironmentVariable("PATH", $NewPath, "User")
}
Write-Success "PATH entry removed"

# === Stop Running Server Processes ===

# Kill any Bun processes running Lucid Memory server/CLI files — these lock
# the ~/.lucid directory and prevent deletion.
# Use WMI for command line access (Get-Process lacks it in PS 5.1)
Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -like "*\.lucid*"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# === Remove Lucid Directory ===

Write-Info "Removing ~/.lucid directory..."
try {
    Remove-Item -Recurse -Force $LucidDir
} catch {
    # File may still be briefly locked — retry once
    Write-Host "  Waiting for file locks to release..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 3
    try {
        Remove-Item -Recurse -Force $LucidDir
    } catch {
        Write-Warn "Could not fully remove ~/.lucid — please delete it manually"
    }
}
if (-not (Test-Path $LucidDir)) {
    Write-Success "Lucid directory removed"
} else {
    Write-Warn "Some files in ~/.lucid could not be removed"
}

# === Done ===

Write-Host ""
Write-Host "${C1}  ██╗     ██╗   ██╗ ██████╗██╗██████╗ ${NC}"
Write-Host "${C2}  ██║     ██║   ██║██╔════╝██║██╔══██╗${NC}"
Write-Host "${C3}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
Write-Host "${C4}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
Write-Host "${C5}  ███████╗╚██████╔╝╚██████╗██║██████╔╝${NC}"
Write-Host "${C6}  ╚══════╝ ╚═════╝  ╚═════╝╚═╝╚═════╝ ${NC}"
Write-Host "          ${C3}M ${C4}E ${C5}M ${C6}O ${C5}R ${C4}Y${NC}"
Write-Host ""
Write-Host "        ${GREEN}✓${NC} ${BOLD}Uninstalled Successfully${NC}"
Write-Host ""
Write-Host "  ${DIM}Thank you for trying Lucid Memory!${NC}"
Write-Host ""
Write-Host "  ${DIM}Note: The following dependencies may have been installed${NC}"
Write-Host "  ${DIM}and can be removed manually if no longer needed:${NC}"
Write-Host ""
Write-Host "  ${DIM}  winget uninstall ffmpeg yt-dlp${NC}"
Write-Host "  ${DIM}  pip uninstall openai-whisper${NC}"
Write-Host ""
Write-Host "  ${DIM}To reinstall:${NC}"
Write-Host "  ${C4}irm https://lucidmemory.dev/install.ps1 | iex${NC}"
Write-Host ""
