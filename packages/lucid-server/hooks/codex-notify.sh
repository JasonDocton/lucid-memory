#!/bin/bash

# Lucid Memory - Codex Notification Hook
#
# This hook runs when Codex completes a turn (agent-turn-complete event).
# Unlike Claude's pre-response hook, Codex hooks fire AFTER the response,
# which means we can capture both user input AND assistant responses.
#
# The hook receives a JSON payload as the first argument with:
#   - type: event type (e.g., "agent-turn-complete")
#   - input-messages: user prompts from the turn
#   - last-assistant-message: the assistant's response
#   - thread-id: conversation identifier
#
# Installation:
#   1. Copy this to ~/.lucid/hooks/codex-notify.sh
#   2. Make executable: chmod +x ~/.lucid/hooks/codex-notify.sh
#   3. Add to ~/.codex/config.toml:
#      notify = ["~/.lucid/hooks/codex-notify.sh"]
#
# Environment:
#   LUCID_CLIENT - Set by Codex MCP config (should be "codex")
#   LUCID_BIN - Path to lucid CLI (default: ~/.lucid/bin/lucid)
#   LUCID_DEBUG - Set to 1 to enable debug logging

# Log file for debugging
LOG_FILE="${HOME}/.lucid/logs/codex-hook.log"
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

# Path to lucid CLI
LUCID="${LUCID_BIN:-$HOME/.lucid/bin/lucid}"

# Ensure LUCID_CLIENT is set for Codex
export LUCID_CLIENT="${LUCID_CLIENT:-codex}"

# Skip if lucid CLI not available
if [ ! -x "$LUCID" ]; then
    log_error "Lucid CLI not found at $LUCID"
    exit 0
fi

# JSON payload is the first argument
JSON_PAYLOAD="$1"

# Skip if no payload
if [ -z "$JSON_PAYLOAD" ]; then
    log_debug "No JSON payload received"
    exit 0
fi

log_debug "Received event payload"

# Check if jq is available
if ! command -v jq &> /dev/null; then
    log_error "jq not found - required for JSON parsing"
    exit 0
fi

# Parse event type
EVENT_TYPE=$(echo "$JSON_PAYLOAD" | jq -r '.type // empty')

log_debug "Event type: $EVENT_TYPE"

# Only process turn-complete events
if [ "$EVENT_TYPE" != "agent-turn-complete" ]; then
    log_debug "Skipping non-turn-complete event: $EVENT_TYPE"
    exit 0
fi

# Extract user messages from the turn
# input-messages is an array, we'll concatenate all user content
USER_CONTENT=$(echo "$JSON_PAYLOAD" | jq -r '
    .["input-messages"] // []
    | map(select(.role == "user") | .content)
    | join("\n")
' 2>/dev/null)

# Extract assistant's response
ASSISTANT_CONTENT=$(echo "$JSON_PAYLOAD" | jq -r '
    .["last-assistant-message"].content // empty
' 2>/dev/null)

# Extract thread ID for potential project tracking
THREAD_ID=$(echo "$JSON_PAYLOAD" | jq -r '.["thread-id"] // empty' 2>/dev/null)

log_debug "User content length: ${#USER_CONTENT}, Assistant content length: ${#ASSISTANT_CONTENT}"

# Store user messages as conversation memories
if [ -n "$USER_CONTENT" ] && [ ${#USER_CONTENT} -ge 5 ]; then
    log_debug "Storing user message"
    (
        if ! "$LUCID" store "$USER_CONTENT" --type=conversation 2>> "$LOG_FILE"; then
            log_error "Failed to store user message"
        fi
    ) &
fi

# Optionally store assistant responses as learnings
# This captures Claude's explanations and solutions
if [ -n "$ASSISTANT_CONTENT" ] && [ ${#ASSISTANT_CONTENT} -ge 20 ]; then
    # Only store if it looks like a substantive response (not just "ok" or "done")
    WORD_COUNT=$(echo "$ASSISTANT_CONTENT" | wc -w | tr -d ' ')
    if [ "$WORD_COUNT" -ge 10 ]; then
        log_debug "Storing assistant response ($WORD_COUNT words)"
        (
            # Store as learning - assistant responses often contain valuable info
            if ! "$LUCID" store "$ASSISTANT_CONTENT" --type=learning 2>> "$LOG_FILE"; then
                log_error "Failed to store assistant response"
            fi
        ) &
    fi
fi

exit 0
