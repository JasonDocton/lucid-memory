#!/bin/bash

# Lucid Memory - UserPromptSubmit Hook
#
# This hook runs before each user prompt is processed.
# It does TWO things:
#   1. STORES the user message (continuous encoding - builds memory over time)
#   2. RETRIEVES relevant context (injects memories for Claude to use)
#
# Installation:
#   1. Copy this to ~/.claude/hooks/UserPromptSubmit.sh
#   2. Make executable: chmod +x ~/.claude/hooks/UserPromptSubmit.sh
#
# Environment:
#   LUCID_BIN - Path to lucid CLI (default: ~/.lucid/bin/lucid)
#   LUCID_DEBUG - Set to 1 to enable debug logging

# Log file for errors (check this if something seems wrong)
LOG_FILE="${HOME}/.lucid/logs/hook.log"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null

# Debug logging function
log_debug() {
    if [ "${LUCID_DEBUG:-0}" = "1" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
    fi
}

# Error logging function (always logs)
log_error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" >> "$LOG_FILE"
}

# Get the user prompt from stdin
USER_PROMPT=$(cat)

# Skip empty prompts or very short ones
if [ ${#USER_PROMPT} -lt 5 ]; then
    exit 0
fi

# Path to lucid CLI
LUCID="${LUCID_BIN:-$HOME/.lucid/bin/lucid}"

# Get current project from environment or pwd
PROJECT_PATH="${CLAUDE_PROJECT_PATH:-$(pwd)}"

# Skip if lucid CLI not available
if [ ! -x "$LUCID" ]; then
    log_error "Lucid CLI not found at $LUCID"
    exit 0
fi

log_debug "Processing prompt (${#USER_PROMPT} chars) for project: $PROJECT_PATH"

# ============================================
# 0. DETECT MEDIA: Check for image/video paths in prompt
# ============================================
# Detect media file paths (images and videos) in the prompt.
# Handles: quoted paths, ~ expansion, URLs, and simple paths.
# If found, output instructions for Claude to describe and remember them.

# Expand ~ to home directory
expand_path() {
    local path="$1"
    if [[ "$path" == ~* ]]; then
        echo "${path/#\~/$HOME}"
    else
        echo "$path"
    fi
}

# Check if path is a URL
is_url() {
    [[ "$1" == http://* ]] || [[ "$1" == https://* ]]
}

# Check if media exists (file or URL)
media_exists() {
    local path="$1"
    if is_url "$path"; then
        return 0  # Assume URLs are valid
    fi
    local expanded=$(expand_path "$path")
    [ -f "$expanded" ]
}

# Detect image path or URL in prompt
# Priority: quoted paths > URLs > simple paths
detect_image() {
    local prompt="$1"
    local path=""
    local extensions="jpg|jpeg|png|gif|webp|heic|heif"

    # Try double-quoted paths: "/path/to/my file.jpg"
    path=$(echo "$prompt" | grep -oE "\"[^\"]+\\.($extensions)\"" | head -1 | tr -d '"')
    if [ -n "$path" ]; then echo "$path"; return; fi

    # Try single-quoted paths: '/path/to/my file.jpg'
    path=$(echo "$prompt" | grep -oE "'[^']+\\.($extensions)'" | head -1 | tr -d "'")
    if [ -n "$path" ]; then echo "$path"; return; fi

    # Try URLs: https://example.com/image.jpg
    path=$(echo "$prompt" | grep -oE "https?://[^[:space:]]+\\.($extensions)" | head -1)
    if [ -n "$path" ]; then echo "$path"; return; fi

    # Fall back to simple paths (no spaces)
    echo "$prompt" | grep -oE "[^[:space:]]+\\.($extensions)" | head -1
}

# Detect video path or URL in prompt
detect_video() {
    local prompt="$1"
    local path=""
    local extensions="mp4|mov|avi|mkv|webm|m4v"

    # Try double-quoted paths
    path=$(echo "$prompt" | grep -oE "\"[^\"]+\\.($extensions)\"" | head -1 | tr -d '"')
    if [ -n "$path" ]; then echo "$path"; return; fi

    # Try single-quoted paths
    path=$(echo "$prompt" | grep -oE "'[^']+\\.($extensions)'" | head -1 | tr -d "'")
    if [ -n "$path" ]; then echo "$path"; return; fi

    # Try URLs (including YouTube, etc.)
    path=$(echo "$prompt" | grep -oE "https?://[^[:space:]]+" | grep -E "(youtube\\.com|youtu\\.be|vimeo\\.com|\\.($extensions))" | head -1)
    if [ -n "$path" ]; then echo "$path"; return; fi

    # Fall back to simple paths (no spaces)
    echo "$prompt" | grep -oE "[^[:space:]]+\\.($extensions)" | head -1
}

IMAGE_PATH=$(detect_image "$USER_PROMPT")
VIDEO_PATH=$(detect_video "$USER_PROMPT")

# Output visual memory instruction if image detected
if [ -n "$IMAGE_PATH" ] && media_exists "$IMAGE_PATH"; then
    EXPANDED_PATH=$(expand_path "$IMAGE_PATH")
    log_debug "Detected image: $EXPANDED_PATH"
    echo "<lucid-visual-memory>"
    if is_url "$IMAGE_PATH"; then
        echo "An image URL was shared: $IMAGE_PATH"
        echo "After responding, spawn a background Task (haiku model) to remember this image:"
        echo "1. Use WebFetch to retrieve the image, or if that fails, note the URL"
        echo "2. Describe what you see (2-3 sentences: objects, people, setting, mood)"
    else
        echo "An image was shared at: $EXPANDED_PATH"
        echo "After responding, spawn a background Task (haiku model) to remember this image:"
        echo "1. Use Read tool to view the image at: $EXPANDED_PATH"
        echo "2. Describe what you see (2-3 sentences: objects, people, setting, mood)"
    fi
    echo "3. Use ToolSearch to find visual_store, then call it with your description"
    echo "</lucid-visual-memory>"
fi

# Output visual memory instruction if video detected
if [ -n "$VIDEO_PATH" ] && media_exists "$VIDEO_PATH"; then
    EXPANDED_PATH=$(expand_path "$VIDEO_PATH")
    log_debug "Detected video: $EXPANDED_PATH"
    echo "<lucid-visual-memory>"
    if is_url "$VIDEO_PATH"; then
        echo "A video URL was shared: $VIDEO_PATH"
    else
        echo "A video was shared at: $EXPANDED_PATH"
    fi
    echo "After responding, spawn a background Task (haiku model) to remember this video:"
    echo "1. Use ToolSearch to find video_process, call it with videoPath='$EXPANDED_PATH'"
    echo "2. Read each extracted frame image to see the video content"
    echo "3. Use the transcript (if available) for audio context"
    echo "4. Synthesize a 2-3 sentence description of the entire video"
    echo "5. Use ToolSearch to find visual_store, save the description with mediaType='video'"
    echo "</lucid-visual-memory>"
fi

# ============================================
# 1. STORE: Continuous encoding of user messages
# ============================================
# This is the key part - every message gets stored as a memory.
# The retrieval algorithms (ACT-R, MINERVA 2) handle surfacing
# the right memories later based on relevance and recency.
#
# Run in background but log errors to file
(
    if ! "$LUCID" store "$USER_PROMPT" --type=conversation --project="$PROJECT_PATH" 2>> "$LOG_FILE"; then
        log_error "Failed to store memory"
    fi
) &

# ============================================
# 2. RETRIEVE: Get relevant context
# ============================================
# Search for memories relevant to what the user is asking about
# Errors go to log file, only context output goes to stdout
"$LUCID" context "$USER_PROMPT" --project="$PROJECT_PATH" 2>> "$LOG_FILE"

exit 0
