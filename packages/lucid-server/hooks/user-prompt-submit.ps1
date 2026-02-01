# Lucid Memory - UserPromptSubmit Hook (PowerShell)
#
# This hook runs before each user prompt is processed.
# It does TWO things:
#   1. STORES the user message (continuous encoding - builds memory over time)
#   2. RETRIEVES relevant context (injects memories for Claude to use)
#
# Installation:
#   The installer configures this automatically in ~/.claude/settings.json
#
# Environment:
#   LUCID_BIN - Path to lucid CLI (default: ~/.lucid/bin/lucid.cmd)
#   LUCID_DEBUG - Set to 1 to enable debug logging

$ErrorActionPreference = "SilentlyContinue"

# Log file for errors
$LogDir = "$env:USERPROFILE\.lucid\logs"
$LogFile = "$LogDir\hook.log"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

function Write-Log {
    param($Message, [switch]$Error)
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $Prefix = if ($Error) { "ERROR" } else { "DEBUG" }
    if ($Error -or $env:LUCID_DEBUG -eq "1") {
        Add-Content -Path $LogFile -Value "[$Timestamp] $Prefix`: $Message"
    }
}

# Get user prompt from stdin
$UserPrompt = $input | Out-String
$UserPrompt = $UserPrompt.Trim()

# Skip empty or very short prompts
if ($UserPrompt.Length -lt 5) { exit 0 }

# Path to lucid CLI
$LucidCli = if ($env:LUCID_BIN) { $env:LUCID_BIN } else { "$env:USERPROFILE\.lucid\bin\lucid.cmd" }

# Get current project from environment or current directory
$ProjectPath = if ($env:CLAUDE_PROJECT_PATH) { $env:CLAUDE_PROJECT_PATH } else { Get-Location }

# Skip if lucid CLI not available
if (-not (Test-Path $LucidCli)) {
    Write-Log "Lucid CLI not found at $LucidCli" -Error
    exit 0
}

Write-Log "Processing prompt ($($UserPrompt.Length) chars) for project: $ProjectPath"

# ============================================
# 0. DETECT MEDIA: Check for image/video paths in prompt
# ============================================

function Expand-TildePath {
    param($Path)
    if ($Path -match "^~") {
        return $Path -replace "^~", $env:USERPROFILE
    }
    return $Path
}

function Test-IsUrl {
    param($Path)
    return $Path -match "^https?://"
}

function Test-MediaExists {
    param($Path)
    if (Test-IsUrl $Path) { return $true }
    $Expanded = Expand-TildePath $Path
    return Test-Path $Expanded
}

function Find-ImagePath {
    param($Prompt)
    $Extensions = "jpg|jpeg|png|gif|webp|heic|heif"

    # Try double-quoted paths
    if ($Prompt -match "`"([^`"]+\.($Extensions))`"") { return $Matches[1] }

    # Try single-quoted paths
    if ($Prompt -match "'([^']+\.($Extensions))'") { return $Matches[1] }

    # Try URLs
    if ($Prompt -match "(https?://[^\s]+\.($Extensions))") { return $Matches[1] }

    # Simple paths (no spaces)
    if ($Prompt -match "([^\s]+\.($Extensions))") { return $Matches[1] }

    return $null
}

function Find-VideoPath {
    param($Prompt)
    $Extensions = "mp4|mov|avi|mkv|webm|m4v"

    # Try double-quoted paths
    if ($Prompt -match "`"([^`"]+\.($Extensions))`"") { return $Matches[1] }

    # Try single-quoted paths
    if ($Prompt -match "'([^']+\.($Extensions))'") { return $Matches[1] }

    # Try video URLs (YouTube, Vimeo, direct links)
    if ($Prompt -match "(https?://[^\s]*(youtube\.com|youtu\.be|vimeo\.com|\.($Extensions)))") { return $Matches[1] }

    # Simple paths (no spaces)
    if ($Prompt -match "([^\s]+\.($Extensions))") { return $Matches[1] }

    return $null
}

$ImagePath = Find-ImagePath $UserPrompt
$VideoPath = Find-VideoPath $UserPrompt

# Output visual memory instruction if image detected
if ($ImagePath -and (Test-MediaExists $ImagePath)) {
    $ExpandedPath = Expand-TildePath $ImagePath
    Write-Log "Detected image: $ExpandedPath"
    Write-Output "<lucid-visual-memory>"
    if (Test-IsUrl $ImagePath) {
        Write-Output "An image URL was shared: $ImagePath"
        Write-Output "After responding, spawn a background Task (haiku model) to remember this image:"
        Write-Output "1. Use WebFetch to retrieve the image, or if that fails, note the URL"
        Write-Output "2. Describe what you see (2-3 sentences: objects, people, setting, mood)"
    } else {
        Write-Output "An image was shared at: $ExpandedPath"
        Write-Output "After responding, spawn a background Task (haiku model) to remember this image:"
        Write-Output "1. Use Read tool to view the image at: $ExpandedPath"
        Write-Output "2. Describe what you see (2-3 sentences: objects, people, setting, mood)"
    }
    Write-Output "3. Use ToolSearch to find visual_store, then call it with your description"
    Write-Output "</lucid-visual-memory>"
}

# Output visual memory instruction if video detected
if ($VideoPath -and (Test-MediaExists $VideoPath)) {
    $ExpandedPath = Expand-TildePath $VideoPath
    Write-Log "Detected video: $ExpandedPath"
    Write-Output "<lucid-visual-memory>"
    if (Test-IsUrl $VideoPath) {
        Write-Output "A video URL was shared: $VideoPath"
    } else {
        Write-Output "A video was shared at: $ExpandedPath"
    }
    Write-Output "After responding, spawn a background Task (haiku model) to remember this video:"
    Write-Output "1. Use ToolSearch to find video_process, call it with videoPath='$ExpandedPath'"
    Write-Output "2. Read each extracted frame image to see the video content"
    Write-Output "3. Use the transcript (if available) for audio context"
    Write-Output "4. Synthesize a 2-3 sentence description of the entire video"
    Write-Output "5. Use ToolSearch to find visual_store, save the description with mediaType='video'"
    Write-Output "</lucid-visual-memory>"
}

# ============================================
# 1. STORE: Continuous encoding of user messages
# ============================================
# Run in background job
Start-Job -ScriptBlock {
    param($Cli, $Prompt, $Project, $Log)
    try {
        & $Cli store $Prompt --type=conversation --project=$Project 2>> $Log
    } catch {
        Add-Content -Path $Log -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERROR: Failed to store memory: $_"
    }
} -ArgumentList $LucidCli, $UserPrompt, $ProjectPath, $LogFile | Out-Null

# ============================================
# 2. RETRIEVE: Get relevant context
# ============================================
& $LucidCli context $UserPrompt --project=$ProjectPath 2>> $LogFile

exit 0
