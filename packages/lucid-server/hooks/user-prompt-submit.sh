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
