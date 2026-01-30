#!/bin/bash

# Lucid Memory Installer
#
# One-liner installation:
#   curl -fsSL lucidmemory.dev/install | bash
#
# What this does:
#   1. Checks all prerequisites (git, disk space, etc.)
#   2. Installs Bun if needed
#   3. Creates ~/.lucid directory
#   4. Downloads and installs lucid-server
#   5. Sets up Ollama for local embeddings (or OpenAI)
#   6. Configures Claude Code MCP settings
#   7. Installs hooks for automatic memory capture
#   8. Restarts Claude Code to activate

set -e

# Detect if we're running interactively (stdin is a terminal)
# When piped via curl | bash, stdin is NOT a terminal, so we use defaults
INTERACTIVE=false
if [ -t 0 ]; then
    INTERACTIVE=true
fi

# Colors - Gradient palette (purple → blue → cyan)
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color
DIM='\033[2m'

# Gradient colors for the banner
C1='\033[38;5;99m'   # Purple
C2='\033[38;5;105m'  # Light purple
C3='\033[38;5;111m'  # Purple-blue
C4='\033[38;5;117m'  # Blue
C5='\033[38;5;123m'  # Light blue
C6='\033[38;5;159m'  # Cyan

# Minimum disk space required (in KB) - 5GB
MIN_DISK_SPACE=5242880

# Installation steps for progress tracking
TOTAL_STEPS=7
CURRENT_STEP=0

# === Visual Functions ===

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
    echo -e "  ${DIM}Claude Code that remembers.${NC}"
    echo ""
}

# Spinner animation for long-running tasks
spinner() {
    local pid=$1
    local message=$2
    local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local i=0

    tput civis 2>/dev/null || true  # Hide cursor
    while kill -0 "$pid" 2>/dev/null; do
        i=$(( (i + 1) % ${#spin} ))
        printf "\r    ${C4}${spin:$i:1}${NC} ${message}"
        sleep 0.1
    done
    tput cnorm 2>/dev/null || true  # Show cursor
    printf "\r"
}

# Progress bar
show_progress() {
    CURRENT_STEP=$((CURRENT_STEP + 1))
    local percent=$((CURRENT_STEP * 100 / TOTAL_STEPS))
    local filled=$((CURRENT_STEP * 30 / TOTAL_STEPS))
    local empty=$((30 - filled))

    local bar="${C4}"
    for ((i=0; i<filled; i++)); do bar+="█"; done
    bar+="${DIM}"
    for ((i=0; i<empty; i++)); do bar+="░"; done
    bar+="${NC}"

    echo -e "\n    ${bar} ${DIM}${percent}%${NC}\n"
}

# Run command with spinner
run_with_spinner() {
    local message=$1
    shift

    "$@" &>/dev/null &
    local pid=$!
    spinner $pid "$message"
    wait $pid
    return $?
}

show_banner

# === Helper Functions ===

fail() {
    echo -e "${RED}❌ Error: $1${NC}"
    echo ""
    if [ -n "$2" ]; then
        echo -e "${YELLOW}$2${NC}"
    fi
    exit 1
}

warn() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

success() {
    echo -e "${GREEN}✓ $1${NC}"
}

# Check if running on Windows (Git Bash, WSL, etc.)
check_windows() {
    if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
        fail "Windows detected" \
            "Please use the PowerShell installer instead:\n  irm https://raw.githubusercontent.com/JasonDocton/lucid-memory/main/install.ps1 | iex"
    fi
}

# Get available disk space in KB
get_available_space() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        df -k "$HOME" | awk 'NR==2 {print $4}'
    else
        df -k "$HOME" | awk 'NR==2 {print $4}'
    fi
}

# Check if JSON is valid
validate_json() {
    if command -v python3 &> /dev/null; then
        python3 -c "import json; json.load(open('$1'))" 2>/dev/null
        return $?
    elif command -v python &> /dev/null; then
        python -c "import json; json.load(open('$1'))" 2>/dev/null
        return $?
    elif command -v jq &> /dev/null; then
        jq empty "$1" 2>/dev/null
        return $?
    else
        # Can't validate, assume it's fine
        return 0
    fi
}

# Add lucid-memory to MCP config (pure bash fallback)
add_to_mcp_config() {
    local config_file="$1"
    local server_path="$2"

    # If jq is available, use it (safest)
    if command -v jq &> /dev/null; then
        jq --arg cmd "$server_path" '.mcpServers["lucid-memory"] = {"command": $cmd, "args": []}' \
            "$config_file" > "$config_file.tmp" && mv "$config_file.tmp" "$config_file"
        return 0
    fi

    # If python is available, use it
    if command -v python3 &> /dev/null; then
        python3 << EOF
import json
with open('$config_file', 'r') as f:
    config = json.load(f)
if 'mcpServers' not in config:
    config['mcpServers'] = {}
config['mcpServers']['lucid-memory'] = {'command': '$server_path', 'args': []}
with open('$config_file', 'w') as f:
    json.dump(config, f, indent=2)
EOF
        return 0
    fi

    # Last resort: check if we can safely append
    if grep -q '"mcpServers"' "$config_file"; then
        warn "Cannot safely modify existing MCP config without jq or python"
        echo ""
        echo "Please manually add this to $config_file in the mcpServers section:"
        echo -e "${BOLD}  \"lucid-memory\": { \"command\": \"$server_path\", \"args\": [] }${NC}"
        echo ""
        if [ "$INTERACTIVE" = true ]; then
            read -p "Press Enter after you've added it (or Ctrl+C to abort)..."
        fi
    else
        # No mcpServers key, we can write fresh
        cat > "$config_file" << EOF
{
  "mcpServers": {
    "lucid-memory": {
      "command": "$server_path",
      "args": []
    }
  }
}
EOF
    fi
}

# Start Ollama service and ensure it persists
ensure_ollama_running() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS - check if Ollama is running
        if ! pgrep -x "ollama" > /dev/null && ! pgrep -f "Ollama" > /dev/null; then
            echo "Starting Ollama..."
            # Try to start Ollama app if installed via DMG
            if [ -d "/Applications/Ollama.app" ]; then
                open -a Ollama
                sleep 3
            else
                # Start ollama serve in background
                ollama serve &>/dev/null &
                sleep 2
            fi
        fi

        # Create launchd plist for auto-start
        local plist_dir="$HOME/Library/LaunchAgents"
        local plist_file="$plist_dir/com.lucid.ollama.plist"

        mkdir -p "$plist_dir"

        # Only create if Ollama was installed via CLI (not app)
        if [ ! -d "/Applications/Ollama.app" ] && command -v ollama &> /dev/null; then
            cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.lucid.ollama</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which ollama)</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/ollama.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/ollama.error.log</string>
</dict>
</plist>
EOF
            launchctl load "$plist_file" 2>/dev/null || true
        fi
    else
        # Linux - use systemd if available
        if command -v systemctl &> /dev/null; then
            if ! systemctl is-active --quiet ollama 2>/dev/null; then
                sudo systemctl start ollama 2>/dev/null || ollama serve &>/dev/null &
                sleep 2
            fi
            # Enable on boot
            sudo systemctl enable ollama 2>/dev/null || true
        else
            # Fallback: just start it
            if ! pgrep -x "ollama" > /dev/null; then
                ollama serve &>/dev/null &
                sleep 2
            fi
        fi
    fi

    # Verify it's running
    local retries=5
    while [ $retries -gt 0 ]; do
        if curl -s http://localhost:11434/api/tags &>/dev/null; then
            return 0
        fi
        sleep 1
        retries=$((retries - 1))
    done

    return 1
}

# Restart Claude Code
restart_claude_code() {
    echo ""
    echo "Restarting Claude Code to activate Lucid Memory..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if pgrep -f "Claude" > /dev/null; then
            osascript -e 'quit app "Claude"' 2>/dev/null || true
            sleep 2
            open -a "Claude" 2>/dev/null || true
        fi
    else
        # Linux - try common locations
        if pgrep -f "claude" > /dev/null; then
            pkill -f "claude" 2>/dev/null || true
            sleep 2
            # Try to restart - location varies
            if [ -f "/usr/bin/claude" ]; then
                nohup /usr/bin/claude &>/dev/null &
            elif [ -f "$HOME/.local/bin/claude" ]; then
                nohup "$HOME/.local/bin/claude" &>/dev/null &
            fi
        fi
    fi
}

# === Pre-flight Checks ===

echo "Running pre-flight checks..."
echo ""

# Check for Windows
check_windows

# Check for git
if ! command -v git &> /dev/null; then
    fail "Git is not installed" \
        "Please install Git first:\n  macOS: xcode-select --install\n  Ubuntu/Debian: sudo apt install git\n  Fedora: sudo dnf install git"
fi
success "Git installed"

# Check for curl (should exist if running this script, but just in case)
if ! command -v curl &> /dev/null; then
    fail "curl is not installed" \
        "Please install curl first:\n  Ubuntu/Debian: sudo apt install curl\n  Fedora: sudo dnf install curl"
fi
success "curl installed"

# Check disk space
AVAILABLE_SPACE=$(get_available_space)
if [ "$AVAILABLE_SPACE" -lt "$MIN_DISK_SPACE" ]; then
    AVAILABLE_GB=$((AVAILABLE_SPACE / 1048576))
    fail "Insufficient disk space" \
        "Lucid Memory requires at least 5GB of free space for the embedding model.\nAvailable: ${AVAILABLE_GB}GB"
fi
AVAILABLE_GB=$((AVAILABLE_SPACE / 1048576))
success "Disk space OK (${AVAILABLE_GB}GB available)"

# Check for Bun
if ! command -v bun &> /dev/null; then
    echo ""
    echo "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"

    # Verify installation
    if ! command -v bun &> /dev/null; then
        fail "Bun installation failed" \
            "Please install Bun manually: https://bun.sh"
    fi
fi
success "Bun $(bun --version)"

# Check for Claude Code
CLAUDE_SETTINGS_DIR="$HOME/.claude"
if [ ! -d "$CLAUDE_SETTINGS_DIR" ]; then
    fail "Claude Code not found" \
        "Please install Claude Code first: https://claude.ai/download\n\nAfter installing, run this installer again."
fi
success "Claude Code found"

# Check existing MCP config
MCP_CONFIG="$CLAUDE_SETTINGS_DIR/claude_desktop_config.json"
if [ -f "$MCP_CONFIG" ]; then
    if ! validate_json "$MCP_CONFIG"; then
        fail "Existing MCP config is malformed" \
            "The file $MCP_CONFIG contains invalid JSON.\nPlease fix or remove it, then run this installer again."
    fi
    success "MCP config valid"
fi

echo ""
success "All pre-flight checks passed!"
show_progress  # Step 1: Pre-flight checks

# === Create Lucid Directory ===

LUCID_DIR="$HOME/.lucid"
LUCID_BIN="$LUCID_DIR/bin"

echo ""
echo "Creating Lucid Memory directory..."

mkdir -p "$LUCID_DIR"
mkdir -p "$LUCID_BIN"

success "Created ~/.lucid"
show_progress  # Step 2: Create directory

# === Install Lucid Server ===

echo ""
echo "Downloading Lucid Memory..."

TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Clone the repository (shallow clone for speed)
# GIT_TERMINAL_PROMPT=0 prevents git from asking for credentials if repo not found
if ! GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://github.com/JasonDocton/lucid-memory.git 2>/dev/null; then
    fail "Could not download Lucid Memory" \
        "Please check your internet connection and try again.\n\nIf the problem persists, the repository may not be available yet.\nVisit: https://github.com/JasonDocton/lucid-memory"
fi

# Copy the server
if [ -d "lucid-memory/packages/lucid-server" ]; then
    rm -rf "$LUCID_DIR/server" 2>/dev/null || true
    cp -r "lucid-memory/packages/lucid-server" "$LUCID_DIR/server"
else
    fail "Invalid repository structure" \
        "The downloaded repository is missing required files."
fi

cd "$LUCID_DIR/server"

echo "Installing dependencies..."
if ! bun install --production 2>/dev/null; then
    fail "Failed to install dependencies" \
        "Bun package installation failed. Check your internet connection."
fi

# Create CLI wrapper
cat > "$LUCID_BIN/lucid" << 'EOF'
#!/bin/bash
exec bun run "$HOME/.lucid/server/src/cli.ts" "$@"
EOF
chmod +x "$LUCID_BIN/lucid"

# Copy server wrapper with auto-restart
cp "$LUCID_DIR/server/bin/lucid-server-wrapper.sh" "$LUCID_BIN/lucid-server"
chmod +x "$LUCID_BIN/lucid-server"

# Create logs directory
mkdir -p "$LUCID_DIR/logs"

success "Lucid Memory installed"
show_progress  # Step 3: Install server

# === Embedding Provider ===

echo ""
echo -e "${BOLD}Embedding provider setup:${NC}"
echo "  [1] Local (Ollama) - Free, private, runs on your machine (recommended)"
echo "  [2] OpenAI API - Faster, requires API key (\$0.0001/query)"
echo ""

if [ "$INTERACTIVE" = true ]; then
    read -p "Choice [1]: " EMBED_CHOICE
    EMBED_CHOICE=${EMBED_CHOICE:-1}
else
    echo "Non-interactive mode, defaulting to Ollama..."
    EMBED_CHOICE=1
fi

case $EMBED_CHOICE in
    2)
        echo ""
        if [ "$INTERACTIVE" = true ]; then
            read -p "Enter OpenAI API key: " OPENAI_KEY
        fi
        if [ -z "$OPENAI_KEY" ]; then
            fail "OpenAI API key is required" \
                "Please run the installer again and provide a valid API key,\nor choose option 1 for local embeddings."
        fi
        echo "OPENAI_API_KEY=$OPENAI_KEY" > "$LUCID_DIR/.env"
        success "OpenAI configured"
        ;;
    *)
        # Default to Ollama
        echo ""
        echo "Setting up Ollama..."

        # Install Ollama if not present
        if ! command -v ollama &> /dev/null; then
            echo "Installing Ollama..."

            if [[ "$OSTYPE" == "darwin"* ]]; then
                # macOS
                if ! command -v brew &> /dev/null; then
                    echo ""
                    echo "Homebrew is required to install Ollama on macOS."

                    if [ "$INTERACTIVE" = true ]; then
                        read -p "Install Homebrew now? [Y/n]: " INSTALL_BREW
                        INSTALL_BREW=${INSTALL_BREW:-Y}
                    else
                        echo "Non-interactive mode, auto-installing Homebrew..."
                        INSTALL_BREW="Y"
                    fi

                    if [[ "$INSTALL_BREW" =~ ^[Yy]$ ]]; then
                        echo "Installing Homebrew..."
                        NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

                        # Add brew to PATH for this session
                        if [[ -f "/opt/homebrew/bin/brew" ]]; then
                            eval "$(/opt/homebrew/bin/brew shellenv)"
                        elif [[ -f "/usr/local/bin/brew" ]]; then
                            eval "$(/usr/local/bin/brew shellenv)"
                        fi

                        if ! command -v brew &> /dev/null; then
                            fail "Homebrew installation failed" \
                                "Please install manually: https://brew.sh\nThen run this installer again."
                        fi
                        success "Homebrew installed"
                    else
                        echo ""
                        echo "Please install Ollama manually:"
                        echo "  Download from: https://ollama.com/download"
                        echo ""
                        fail "Ollama installation requires Homebrew or manual install"
                    fi
                fi

                echo "Installing Ollama via Homebrew..."
                brew install ollama
            else
                # Linux
                curl -fsSL https://ollama.com/install.sh | sh
            fi
        fi
        success "Ollama installed"

        # Ensure Ollama is running
        echo "Starting Ollama service..."
        if ! ensure_ollama_running; then
            fail "Could not start Ollama service" \
                "Please start Ollama manually and run this installer again:\n  ollama serve"
        fi
        success "Ollama service running"

        # Pull the embedding model
        echo "Downloading embedding model (this may take a few minutes)..."
        if ! ollama pull nomic-embed-text; then
            fail "Failed to download embedding model" \
                "Please try manually: ollama pull nomic-embed-text"
        fi
        success "Embedding model ready"
        ;;
esac
show_progress  # Step 4: Embedding provider

# === Configure Claude Code ===

echo ""
echo "Configuring Claude Code..."

# Backup existing config
if [ -f "$MCP_CONFIG" ]; then
    cp "$MCP_CONFIG" "$MCP_CONFIG.backup"
    success "Backed up existing config"

    # Add our server to existing config
    add_to_mcp_config "$MCP_CONFIG" "$LUCID_BIN/lucid-server"
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

success "MCP server configured"
show_progress  # Step 5: Configure Claude Code

# === Install Hooks ===

echo ""
echo "Installing memory hooks..."

HOOKS_DIR="$CLAUDE_SETTINGS_DIR/hooks"
mkdir -p "$HOOKS_DIR"

# Copy hook script
if [ -f "$LUCID_DIR/server/hooks/user-prompt-submit.sh" ]; then
    cp "$LUCID_DIR/server/hooks/user-prompt-submit.sh" "$HOOKS_DIR/UserPromptSubmit.sh"
    chmod +x "$HOOKS_DIR/UserPromptSubmit.sh"
    success "Hooks installed"
else
    warn "Hook script not found - automatic context injection disabled"
fi

# === Add to PATH ===

SHELL_CONFIG=""
if [ -f "$HOME/.zshrc" ]; then
    SHELL_CONFIG="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_CONFIG="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_CONFIG="$HOME/.bash_profile"
fi

if [ -n "$SHELL_CONFIG" ]; then
    if ! grep -q "/.lucid/bin" "$SHELL_CONFIG" 2>/dev/null; then
        echo '' >> "$SHELL_CONFIG"
        echo '# Lucid Memory' >> "$SHELL_CONFIG"
        echo 'export PATH="$HOME/.lucid/bin:$PATH"' >> "$SHELL_CONFIG"
        success "Added to PATH"
    fi
fi
show_progress  # Step 6: Install hooks & PATH

# === Cleanup ===

rm -rf "$TEMP_DIR"

# === Restart Claude Code ===

restart_claude_code
show_progress  # Step 7: Restart Claude Code

# === Done! ===

echo ""
echo -e "  ${GREEN}✓${NC} ${BOLD}Lucid Memory installed successfully!${NC}"
echo ""
echo -e "  Claude Code is restarting with Lucid Memory enabled."
echo -e "  Just use Claude normally - your memories build automatically."
echo ""
echo -e "  ${DIM}Troubleshooting:${NC}"
echo -e "  ${C4}lucid status${NC}  - Check if everything is working"
echo -e "  ${C4}lucid stats${NC}   - View memory statistics"
echo ""
