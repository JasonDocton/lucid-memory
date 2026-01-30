#!/bin/bash

# Lucid Memory - UserPromptSubmit Hook
#
# This hook runs before each user prompt is processed.
# It retrieves relevant context and injects it for Claude to use.
#
# Installation:
#   1. Copy this to ~/.claude/hooks/UserPromptSubmit.sh
#   2. Make executable: chmod +x ~/.claude/hooks/UserPromptSubmit.sh
#
# Environment:
#   LUCID_BIN - Path to lucid CLI (default: ~/.lucid/bin/lucid)

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

# Get relevant context
# This runs quickly and outputs context for injection
if [ -x "$LUCID" ]; then
    "$LUCID" context "$USER_PROMPT" --project="$PROJECT_PATH" 2>/dev/null
fi

exit 0
