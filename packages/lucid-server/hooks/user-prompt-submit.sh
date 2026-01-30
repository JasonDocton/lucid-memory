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
    exit 0
fi

# ============================================
# 1. STORE: Continuous encoding of user messages
# ============================================
# This is the key part - every message gets stored as a memory.
# The retrieval algorithms (ACT-R, MINERVA 2) handle surfacing
# the right memories later based on relevance and recency.
"$LUCID" store "$USER_PROMPT" --type=conversation --project="$PROJECT_PATH" 2>/dev/null &

# ============================================
# 2. RETRIEVE: Get relevant context
# ============================================
# Search for memories relevant to what the user is asking about
"$LUCID" context "$USER_PROMPT" --project="$PROJECT_PATH" 2>/dev/null

exit 0
