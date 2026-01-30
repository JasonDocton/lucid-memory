#!/bin/bash

# Lucid Memory Installer
#
# One-liner installation:
#   curl -fsSL https://raw.githubusercontent.com/JasonDocton/lucid-memory/main/install.sh | bash
#
# What this does:
#   1. Checks for Bun (required runtime)
#   2. Creates ~/.lucid directory
#   3. Downloads and installs lucid-server
#   4. Optionally sets up Ollama for local embeddings
#   5. Configures Claude Code MCP settings
#   6. Installs hooks for automatic memory capture

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "🧠 Lucid Memory Installer"
echo "========================="
echo -e "${NC}"

# === Check Prerequisites ===

echo "Checking system..."

# Check for Bun
if ! command -v bun &> /dev/null; then
    echo -e "${YELLOW}Bun not found. Installing Bun...${NC}"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi
echo -e "${GREEN}✓ Bun $(bun --version)${NC}"

# Check for Claude Code
CLAUDE_SETTINGS_DIR="$HOME/.claude"
if [ ! -d "$CLAUDE_SETTINGS_DIR" ]; then
    echo -e "${YELLOW}Claude Code settings directory not found.${NC}"
    echo "Please install Claude Code first: https://claude.ai/download"
    echo ""
    echo "After installing, run this installer again."
    exit 1
fi
echo -e "${GREEN}✓ Claude Code found${NC}"

# === Create Lucid Directory ===

LUCID_DIR="$HOME/.lucid"
LUCID_BIN="$LUCID_DIR/bin"

echo ""
echo "Creating Lucid Memory directory..."

mkdir -p "$LUCID_DIR"
mkdir -p "$LUCID_BIN"

# === Install Lucid Server ===

echo ""
echo "Installing Lucid Memory..."

# For now, we'll clone from the repo. In production, this would download a release.
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Clone the repository (shallow clone for speed)
git clone --depth 1 https://github.com/JasonDocton/lucid-memory.git 2>/dev/null || {
    echo -e "${RED}Error: Could not download Lucid Memory${NC}"
    echo "Please check your internet connection and try again."
    exit 1
}

# If we cloned successfully, copy the server
if [ -d "lucid-memory/packages/lucid-server" ]; then
    cp -r "lucid-memory/packages/lucid-server" "$LUCID_DIR/server"
fi

cd "$LUCID_DIR/server"
bun install --production 2>/dev/null

# Create CLI symlink
cat > "$LUCID_BIN/lucid" << 'EOF'
#!/bin/bash
exec bun run "$HOME/.lucid/server/src/cli.ts" "$@"
EOF
chmod +x "$LUCID_BIN/lucid"

# Create server launcher
cat > "$LUCID_BIN/lucid-server" << 'EOF'
#!/bin/bash
exec bun run "$HOME/.lucid/server/src/server.ts" "$@"
EOF
chmod +x "$LUCID_BIN/lucid-server"

echo -e "${GREEN}✓ Lucid Memory installed${NC}"

# === Embedding Provider ===

echo ""
echo "Embedding provider setup:"
echo "  [1] Local (Ollama) - Free, private, requires ~4GB disk"
echo "  [2] OpenAI API - Fast, requires API key"
echo ""
read -p "Choice [1]: " EMBED_CHOICE
EMBED_CHOICE=${EMBED_CHOICE:-1}

case $EMBED_CHOICE in
    1)
        if ! command -v ollama &> /dev/null; then
            echo "Installing Ollama..."
            curl -fsSL https://ollama.ai/install.sh | sh
        fi
        echo "Pulling nomic-embed-text model..."
        ollama pull nomic-embed-text 2>/dev/null || {
            echo -e "${YELLOW}Note: Ollama pull deferred. Run 'ollama pull nomic-embed-text' when ready.${NC}"
        }
        echo -e "${GREEN}✓ Ollama configured${NC}"
        ;;
    2)
        echo ""
        read -p "Enter OpenAI API key: " OPENAI_KEY
        if [ -n "$OPENAI_KEY" ]; then
            echo "OPENAI_API_KEY=$OPENAI_KEY" >> "$LUCID_DIR/.env"
            echo -e "${GREEN}✓ OpenAI configured${NC}"
        else
            echo -e "${RED}No API key provided. Please set OPENAI_API_KEY in ~/.lucid/.env${NC}"
        fi
        ;;
    *)
        echo -e "${YELLOW}Invalid choice. Defaulting to Ollama...${NC}"
        if ! command -v ollama &> /dev/null; then
            echo "Installing Ollama..."
            curl -fsSL https://ollama.ai/install.sh | sh
        fi
        ollama pull nomic-embed-text 2>/dev/null || true
        echo -e "${GREEN}✓ Ollama configured${NC}"
        ;;
esac

# === Configure Claude Code ===

echo ""
echo "Configuring Claude Code..."

MCP_CONFIG="$CLAUDE_SETTINGS_DIR/claude_desktop_config.json"

# Check if config exists
if [ -f "$MCP_CONFIG" ]; then
    # Backup existing config
    cp "$MCP_CONFIG" "$MCP_CONFIG.backup"

    # Add lucid-memory server using jq if available, otherwise simple append
    if command -v jq &> /dev/null; then
        jq '.mcpServers["lucid-memory"] = {
            "command": "'"$LUCID_BIN/lucid-server"'",
            "args": []
        }' "$MCP_CONFIG" > "$MCP_CONFIG.tmp" && mv "$MCP_CONFIG.tmp" "$MCP_CONFIG"
    else
        echo -e "${YELLOW}Note: Please manually add lucid-memory to your Claude Code MCP config${NC}"
        echo "Add this to $MCP_CONFIG:"
        echo '  "lucid-memory": { "command": "'$LUCID_BIN'/lucid-server", "args": [] }'
    fi
else
    # Create new config
    mkdir -p "$(dirname "$MCP_CONFIG")"
    cat > "$MCP_CONFIG" << EOF
{
  "mcpServers": {
    "lucid-memory": {
      "command": "$LUCID_BIN/lucid-server",
      "args": []
    }
  }
}
EOF
fi

echo -e "${GREEN}✓ Claude Code configured${NC}"

# === Install Hooks (Optional) ===

echo ""
read -p "Install hooks for automatic context injection? [Y/n]: " INSTALL_HOOKS
INSTALL_HOOKS=${INSTALL_HOOKS:-Y}

if [[ $INSTALL_HOOKS =~ ^[Yy]$ ]]; then
    HOOKS_DIR="$CLAUDE_SETTINGS_DIR/hooks"
    mkdir -p "$HOOKS_DIR"

    # Copy hook script
    cp "$LUCID_DIR/server/hooks/user-prompt-submit.sh" "$HOOKS_DIR/UserPromptSubmit.sh"
    chmod +x "$HOOKS_DIR/UserPromptSubmit.sh"

    echo -e "${GREEN}✓ Hooks installed${NC}"
fi

# === Add to PATH ===

echo ""
SHELL_CONFIG=""
if [ -f "$HOME/.zshrc" ]; then
    SHELL_CONFIG="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_CONFIG="$HOME/.bashrc"
fi

if [ -n "$SHELL_CONFIG" ]; then
    if ! grep -q "/.lucid/bin" "$SHELL_CONFIG"; then
        echo 'export PATH="$HOME/.lucid/bin:$PATH"' >> "$SHELL_CONFIG"
        echo -e "${GREEN}✓ Added to PATH in $SHELL_CONFIG${NC}"
    fi
fi

# === Cleanup ===

rm -rf "$TEMP_DIR"

# === Done! ===

echo ""
echo -e "${GREEN}🎉 Lucid Memory installed successfully!${NC}"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code to load the new MCP server"
echo "  2. Start using Claude Code normally - memories build automatically"
echo "  3. Run 'lucid status' to check memory stats"
echo ""
echo "Commands:"
echo "  lucid status        - Check system status"
echo "  lucid stats         - View memory statistics"
echo "  lucid context       - Get context for a task"
echo ""
