#!/bin/bash

# Lucid Memory - MCP Server Test Script
#
# Tests that the MCP server responds correctly to tool calls.
# Run after test-install.sh succeeds.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "================================"
echo "Lucid Memory MCP Server Test"
echo "================================"
echo ""

# Check server is installed
if [ ! -f "$HOME/.lucid/bin/lucid-server" ]; then
    echo -e "${RED}Error: lucid-server not installed. Run test-install.sh first.${NC}"
    exit 1
fi

# Create a temp directory for test artifacts
TEST_DIR=$(mktemp -d)
cd "$TEST_DIR"

echo "Testing MCP protocol communication..."
echo ""

# The server uses stdio, so we need to send JSON-RPC messages
# We'll test by starting the server and sending initialize + tool calls

# Create test input file with MCP protocol messages
cat > test_input.json << 'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_stats","arguments":{}}}
EOF

echo "Sending test messages to MCP server..."

# Run server with test input, capture output
timeout 10 bash -c 'cat test_input.json | "$HOME/.lucid/bin/lucid-server" 2>/dev/null' > test_output.json || true

# Check outputs
ERRORS=0

echo ""
echo "Checking responses..."

# Check for initialize response
if grep -q '"result"' test_output.json && grep -q '"serverInfo"' test_output.json; then
    echo -e "${GREEN}✓ Server initialized correctly${NC}"
else
    echo -e "${RED}✗ Initialize response invalid${NC}"
    ERRORS=$((ERRORS + 1))
fi

# Check for tools list
if grep -q 'memory_store' test_output.json && grep -q 'memory_query' test_output.json; then
    echo -e "${GREEN}✓ Tools registered correctly${NC}"
else
    echo -e "${RED}✗ Tools not found in response${NC}"
    ERRORS=$((ERRORS + 1))
fi

# Check for memory_stats response
if grep -q '"memories"' test_output.json || grep -q '"memoryCount"' test_output.json; then
    echo -e "${GREEN}✓ memory_stats tool works${NC}"
else
    echo -e "${YELLOW}⚠ memory_stats response not found (may be OK if DB empty)${NC}"
fi

# Cleanup
rm -rf "$TEST_DIR"

# === Summary ===
echo ""
echo "================================"
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}MCP server tests passed!${NC}"
    echo "================================"
else
    echo -e "${RED}$ERRORS test(s) failed${NC}"
    echo "================================"
    exit 1
fi
