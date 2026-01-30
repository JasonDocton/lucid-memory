#!/bin/bash

# Lucid Memory Uninstaller
#
# One-liner uninstall:
#   curl -fsSL lucidmemory.dev/uninstall | bash
#
# What this does:
#   1. Removes ~/.lucid directory
#   2. Removes MCP server config from Claude Code
#   3. Removes hooks from Claude Code
#   4. Removes PATH entry from shell config
#   5. Optionally removes Ollama embedding model

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'
DIM='\033[2m'

# Gradient colors
C1='\033[38;5;99m'
C2='\033[38;5;105m'
C3='\033[38;5;111m'
C4='\033[38;5;117m'
C5='\033[38;5;123m'
C6='\033[38;5;159m'

# Detect if we're running interactively
INTERACTIVE=false
if [ -t 0 ]; then
    INTERACTIVE=true
fi

success() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}  $1"; }
info() { echo -e "  ${DIM}→${NC} $1"; }

show_banner() {
    echo ""
    echo -e "${C1}  ██╗     ██╗   ██╗ ██████╗██╗██████╗ ${NC}"
    echo -e "${C2}  ██║     ██║   ██║██╔════╝██║██╔══██╗${NC}"
    echo -e "${C3}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
    echo -e "${C4}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
    echo -e "${C5}  ███████╗╚██████╔╝╚██████╗██║██████╔╝${NC}"
    echo -e "${C6}  ╚══════╝ ╚═════╝  ╚═════╝╚═╝╚═════╝ ${NC}"
    echo -e "          ${C3}M ${C4}E ${C5}M ${C6}O ${C5}R ${C4}Y${NC}"
    echo ""
    echo -e "          ${DIM}Uninstaller${NC}"
    echo ""
}

show_banner

LUCID_DIR="$HOME/.lucid"
CLAUDE_SETTINGS_DIR="$HOME/.claude"
# Claude Code uses ~/.claude.json for MCP servers
MCP_CONFIG="$HOME/.claude.json"

# Check if Lucid is installed
if [ ! -d "$LUCID_DIR" ]; then
    echo -e "  ${YELLOW}Lucid Memory is not installed.${NC}"
    echo ""
    exit 0
fi

# Confirm uninstall
if [ "$INTERACTIVE" = true ]; then
    echo -e "  This will remove Lucid Memory from your system."
    echo ""
    read -p "  Continue? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo ""
        echo -e "  ${DIM}Uninstall cancelled.${NC}"
        echo ""
        exit 0
    fi
    echo ""
else
    echo -e "  ${DIM}Non-interactive mode - proceeding with uninstall...${NC}"
    echo ""
fi

# === Remove MCP Config ===

if [ -f "$MCP_CONFIG" ]; then
    info "Removing MCP server config..."

    # Use Python or Node to safely edit JSON
    if command -v python3 &> /dev/null; then
        python3 << 'PYTHON_SCRIPT'
import json
import os

config_path = os.path.expanduser("~/.claude.json")
try:
    with open(config_path, 'r') as f:
        config = json.load(f)

    if 'mcpServers' in config and 'lucid-memory' in config['mcpServers']:
        del config['mcpServers']['lucid-memory']

        with open(config_path, 'w') as f:
            json.dump(config, f, indent=2)
except Exception as e:
    pass  # Ignore errors, we'll try to clean up anyway
PYTHON_SCRIPT
        success "MCP server config removed"
    elif command -v node &> /dev/null; then
        node << 'NODE_SCRIPT'
const fs = require('fs');
const path = require('path');

const configPath = path.join(process.env.HOME, '.claude.json');
try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.mcpServers && config.mcpServers['lucid-memory']) {
        delete config.mcpServers['lucid-memory'];
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
} catch (e) {}
NODE_SCRIPT
        success "MCP server config removed"
    else
        warn "Could not edit MCP config - please remove 'lucid-memory' manually from $MCP_CONFIG"
    fi
fi

# === Remove Hooks ===

info "Removing hook configuration..."

# Remove hook config from settings.json
CLAUDE_SETTINGS="$CLAUDE_SETTINGS_DIR/settings.json"
if [ -f "$CLAUDE_SETTINGS" ]; then
    if command -v jq &> /dev/null; then
        jq 'del(.hooks.UserPromptSubmit)' "$CLAUDE_SETTINGS" > "$CLAUDE_SETTINGS.tmp" && mv "$CLAUDE_SETTINGS.tmp" "$CLAUDE_SETTINGS"
        success "Hook config removed from settings.json"
    elif command -v python3 &> /dev/null; then
        python3 << 'PYTHON_SCRIPT'
import json
import os

settings_path = os.path.expanduser("~/.claude/settings.json")
try:
    with open(settings_path, 'r') as f:
        config = json.load(f)
    if 'hooks' in config and 'UserPromptSubmit' in config['hooks']:
        del config['hooks']['UserPromptSubmit']
        with open(settings_path, 'w') as f:
            json.dump(config, f, indent=2)
except Exception:
    pass
PYTHON_SCRIPT
        success "Hook config removed from settings.json"
    else
        warn "Could not remove hook config - please remove 'UserPromptSubmit' from $CLAUDE_SETTINGS manually"
    fi
fi

# Remove old hook file location (legacy)
OLD_HOOKS_DIR="$CLAUDE_SETTINGS_DIR/hooks"
if [ -f "$OLD_HOOKS_DIR/UserPromptSubmit.sh" ]; then
    rm -f "$OLD_HOOKS_DIR/UserPromptSubmit.sh"
fi

# === Remove PATH Entry ===

info "Removing PATH entry..."

remove_path_entry() {
    local config_file=$1
    if [ -f "$config_file" ]; then
        # Create temp file without lucid lines
        grep -v "/.lucid/bin" "$config_file" | grep -v "# Lucid Memory" > "$config_file.tmp" 2>/dev/null || true
        mv "$config_file.tmp" "$config_file"
    fi
}

remove_path_entry "$HOME/.zshrc"
remove_path_entry "$HOME/.bashrc"
remove_path_entry "$HOME/.bash_profile"

success "PATH entry removed"

# === Remove Ollama Model (Optional) ===

if [ "$INTERACTIVE" = true ]; then
    echo ""
    read -p "  Remove Ollama embedding model (nomic-embed-text)? [y/N]: " REMOVE_MODEL
    if [[ "$REMOVE_MODEL" =~ ^[Yy]$ ]]; then
        if command -v ollama &> /dev/null; then
            info "Removing embedding model..."
            ollama rm nomic-embed-text 2>/dev/null || true
            success "Embedding model removed"
        fi
    fi
fi

# === Remove macOS LaunchAgent ===

PLIST_FILE="$HOME/Library/LaunchAgents/com.lucid.ollama.plist"
if [ -f "$PLIST_FILE" ]; then
    info "Removing Ollama LaunchAgent..."
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    rm -f "$PLIST_FILE"
    success "LaunchAgent removed"
fi

# === Remove Lucid Directory ===

info "Removing ~/.lucid directory..."
rm -rf "$LUCID_DIR"
success "Lucid directory removed"

# === Done ===

echo ""
echo -e "${C1}  ██╗     ██╗   ██╗ ██████╗██╗██████╗ ${NC}"
echo -e "${C2}  ██║     ██║   ██║██╔════╝██║██╔══██╗${NC}"
echo -e "${C3}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
echo -e "${C4}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
echo -e "${C5}  ███████╗╚██████╔╝╚██████╗██║██████╔╝${NC}"
echo -e "${C6}  ╚══════╝ ╚═════╝  ╚═════╝╚═╝╚═════╝ ${NC}"
echo -e "          ${C3}M ${C4}E ${C5}M ${C6}O ${C5}R ${C4}Y${NC}"
echo ""
echo -e "        ${GREEN}✓${NC} ${BOLD}Uninstalled Successfully${NC}"
echo ""
echo -e "  ${DIM}Thank you for trying Lucid Memory!${NC}"
echo ""
echo -e "  ${DIM}To reinstall:${NC}"
echo -e "  ${C4}curl -fsSL lucidmemory.dev/install | bash${NC}"
echo ""
