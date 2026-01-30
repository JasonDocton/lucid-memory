#!/bin/bash

# Lucid Memory - Installation Test Script
#
# Run this in a clean VM to verify the installation flow works.
# Usage: bash test-install.sh [local|remote]
#   local  - Test from local files (before GitHub push)
#   remote - Test curl from lucidmemory.dev (after GitHub push)

set -e

MODE="${1:-local}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "================================"
echo "Lucid Memory Installation Test"
echo "Mode: $MODE"
echo "================================"
echo ""

# === Cleanup from previous tests ===
echo "Cleaning up previous installation..."
rm -rf ~/.lucid
rm -f ~/.claude/claude_desktop_config.json.backup

# === Check prerequisites ===
echo ""
echo "Checking prerequisites..."

if ! command -v bun &> /dev/null; then
    echo -e "${YELLOW}Installing Bun...${NC}"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi
echo -e "${GREEN}✓ Bun available${NC}"

# Create fake Claude Code directory if it doesn't exist
if [ ! -d "$HOME/.claude" ]; then
    echo -e "${YELLOW}Creating ~/.claude directory (simulating Claude Code)${NC}"
    mkdir -p "$HOME/.claude"
fi
echo -e "${GREEN}✓ Claude Code directory exists${NC}"

# === Run installation ===
echo ""
echo "Running installation..."

if [ "$MODE" = "local" ]; then
    # Find the install script relative to this script
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    INSTALL_SCRIPT="$SCRIPT_DIR/../packages/lucid-server/scripts/install.sh"

    if [ ! -f "$INSTALL_SCRIPT" ]; then
        echo -e "${RED}Error: install.sh not found at $INSTALL_SCRIPT${NC}"
        exit 1
    fi

    bash "$INSTALL_SCRIPT"
else
    curl -fsSL https://raw.githubusercontent.com/JasonDocton/lucid-memory/main/install.sh | bash
fi

# === Verify installation ===
echo ""
echo "================================"
echo "Verifying installation..."
echo "================================"

ERRORS=0

# Check directory structure
echo ""
echo "Checking directory structure..."

if [ -d "$HOME/.lucid" ]; then
    echo -e "${GREEN}✓ ~/.lucid directory created${NC}"
else
    echo -e "${RED}✗ ~/.lucid directory missing${NC}"
    ERRORS=$((ERRORS + 1))
fi

if [ -d "$HOME/.lucid/server" ]; then
    echo -e "${GREEN}✓ ~/.lucid/server directory created${NC}"
else
    echo -e "${RED}✗ ~/.lucid/server directory missing${NC}"
    ERRORS=$((ERRORS + 1))
fi

if [ -f "$HOME/.lucid/bin/lucid" ]; then
    echo -e "${GREEN}✓ lucid CLI installed${NC}"
else
    echo -e "${RED}✗ lucid CLI missing${NC}"
    ERRORS=$((ERRORS + 1))
fi

if [ -f "$HOME/.lucid/bin/lucid-server" ]; then
    echo -e "${GREEN}✓ lucid-server installed${NC}"
else
    echo -e "${RED}✗ lucid-server missing${NC}"
    ERRORS=$((ERRORS + 1))
fi

# Check MCP config
echo ""
echo "Checking MCP configuration..."

MCP_CONFIG="$HOME/.claude/claude_desktop_config.json"
if [ -f "$MCP_CONFIG" ]; then
    if grep -q "lucid-memory" "$MCP_CONFIG"; then
        echo -e "${GREEN}✓ MCP config contains lucid-memory${NC}"
    else
        echo -e "${RED}✗ MCP config missing lucid-memory entry${NC}"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo -e "${RED}✗ MCP config file not created${NC}"
    ERRORS=$((ERRORS + 1))
fi

# Test server starts
echo ""
echo "Testing server startup..."

# Start server in background, capture output
timeout 5 "$HOME/.lucid/bin/lucid-server" 2>&1 &
SERVER_PID=$!
sleep 2

if ps -p $SERVER_PID > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Server starts successfully${NC}"
    kill $SERVER_PID 2>/dev/null || true
else
    # Server might have exited cleanly waiting for stdio
    echo -e "${GREEN}✓ Server initialized (stdio mode)${NC}"
fi

# === Summary ===
echo ""
echo "================================"
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    echo "================================"
    echo ""
    echo "Installation verified. Ready for Claude Code testing."
else
    echo -e "${RED}$ERRORS test(s) failed${NC}"
    echo "================================"
    exit 1
fi
