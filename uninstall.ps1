# Lucid Memory Uninstaller for Windows
#
# One-liner uninstall (run in PowerShell):
#   irm lucidmemory.dev/uninstall.ps1 | iex
#
# What this does:
#   1. Removes ~/.lucid directory
#   2. Removes MCP server config from Claude Code
#   3. Removes hooks from Claude Code
#   4. Removes PATH entry
#   5. Optionally removes Ollama embedding model

$ErrorActionPreference = "Stop"

# Enable ANSI colors
$PSStyle.OutputRendering = 'Ansi' 2>$null

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
    exit 0
}

# Confirm uninstall
Write-Host "  This will remove Lucid Memory from your system."
Write-Host ""
$Confirm = Read-Host "  Continue? [y/N]"
if ($Confirm -notmatch "^[Yy]$") {
    Write-Host ""
    Write-Host "  ${DIM}Uninstall cancelled.${NC}"
    Write-Host ""
    exit 0
}
Write-Host ""

# === Remove MCP Config ===

if (Test-Path $McpConfig) {
    Write-Info "Removing MCP server config..."
    try {
        $Config = Get-Content $McpConfig | ConvertFrom-Json
        if ($Config.mcpServers -and $Config.mcpServers.'lucid-memory') {
            $Config.mcpServers.PSObject.Properties.Remove('lucid-memory')
            $Config | ConvertTo-Json -Depth 10 | Out-File -FilePath $McpConfig -Encoding UTF8
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
        $Config = Get-Content $ClaudeSettings | ConvertFrom-Json
        if ($Config.hooks -and $Config.hooks.UserPromptSubmit) {
            $Config.hooks.PSObject.Properties.Remove('UserPromptSubmit')
            $Config | ConvertTo-Json -Depth 10 | Out-File -FilePath $ClaudeSettings -Encoding UTF8
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

# === Remove Ollama Model (Optional) ===

Write-Host ""
$RemoveModel = Read-Host "  Remove Ollama embedding model (nomic-embed-text)? [y/N]"
if ($RemoveModel -match "^[Yy]$") {
    if (Get-Command ollama -ErrorAction SilentlyContinue) {
        Write-Info "Removing embedding model..."
        ollama rm nomic-embed-text 2>$null
        Write-Success "Embedding model removed"
    }
}

# === Remove Scheduled Task ===

$TaskName = "LucidOllamaKeepAlive"
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
    Write-Info "Removing Ollama scheduled task..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Success "Scheduled task removed"
}

# === Remove Lucid Directory ===

Write-Info "Removing ~/.lucid directory..."
Remove-Item -Recurse -Force $LucidDir
Write-Success "Lucid directory removed"

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
Write-Host "  ${DIM}To reinstall:${NC}"
Write-Host "  ${C4}irm lucidmemory.dev/install.ps1 | iex${NC}"
Write-Host ""
