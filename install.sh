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

# Installation steps for progress tracking (adjusted dynamically based on what needs installing)
TOTAL_STEPS=8
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
        jq --arg cmd "$server_path" '.mcpServers["lucid-memory"] = {"type": "stdio", "command": $cmd, "args": []}' \
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
config['mcpServers']['lucid-memory'] = {'type': 'stdio', 'command': '$server_path', 'args': []}
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
        echo -e "${BOLD}  \"lucid-memory\": { \"type\": \"stdio\", \"command\": \"$server_path\", \"args\": [] }${NC}"
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
      "type": "stdio",
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

echo "Checking system requirements..."
echo ""

# Check for Windows
check_windows

# Check for git (required, cannot auto-install)
if ! command -v git &> /dev/null; then
    fail "Git is not installed" \
        "Please install Git first:\n  macOS: xcode-select --install\n  Ubuntu/Debian: sudo apt install git\n  Fedora: sudo dnf install git"
fi

# Check for curl (required, cannot auto-install)
if ! command -v curl &> /dev/null; then
    fail "curl is not installed" \
        "Please install curl first:\n  Ubuntu/Debian: sudo apt install curl\n  Fedora: sudo dnf install curl"
fi

# Check for Claude Code (required, cannot auto-install)
CLAUDE_SETTINGS_DIR="$HOME/.claude"
if [ ! -d "$CLAUDE_SETTINGS_DIR" ]; then
    fail "Claude Code not found" \
        "Please install Claude Code first: https://claude.ai/download\n\nAfter installing, run this installer again."
fi

# Check disk space
AVAILABLE_SPACE=$(get_available_space)
if [ "$AVAILABLE_SPACE" -lt "$MIN_DISK_SPACE" ]; then
    AVAILABLE_GB=$((AVAILABLE_SPACE / 1048576))
    fail "Insufficient disk space" \
        "Lucid Memory requires at least 5GB of free space for the embedding model.\nAvailable: ${AVAILABLE_GB}GB"
fi

# Check existing MCP config
MCP_CONFIG="$HOME/.claude.json"
if [ -f "$MCP_CONFIG" ]; then
    if ! validate_json "$MCP_CONFIG"; then
        fail "Existing MCP config is malformed" \
            "The file $MCP_CONFIG contains invalid JSON.\nPlease fix or remove it, then run this installer again."
    fi
fi

# === Detect what needs to be installed ===

INSTALL_LIST=""
NEED_BREW=false
NEED_BUN=false
NEED_FFMPEG=false
NEED_YTDLP=false
NEED_WHISPER=false
NEED_OLLAMA=false
NEED_PIP=false

# Add Python user bin to PATH for detection (pip installs go here)
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: ~/Library/Python/3.X/bin
    for pyver in 3.13 3.12 3.11 3.10 3.9 3.8; do
        if [ -d "$HOME/Library/Python/$pyver/bin" ]; then
            export PATH="$HOME/Library/Python/$pyver/bin:$PATH"
            break
        fi
    done
else
    # Linux: ~/.local/bin
    export PATH="$HOME/.local/bin:$PATH"
fi

# Check for Homebrew on macOS (needed for other installs)
if [[ "$OSTYPE" == "darwin"* ]] && ! command -v brew &> /dev/null; then
    NEED_BREW=true
    INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} Homebrew (package manager for macOS)"
fi

# Check for Bun
if ! command -v bun &> /dev/null; then
    NEED_BUN=true
    INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} Bun (JavaScript runtime)"
fi

# Check for ffmpeg
if ! command -v ffmpeg &> /dev/null; then
    NEED_FFMPEG=true
    INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} ffmpeg (video processing)"
fi

# Check for yt-dlp
if ! command -v yt-dlp &> /dev/null; then
    NEED_YTDLP=true
    INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} yt-dlp (video downloads)"
fi

# Check for pip (needed for whisper)
if ! command -v pip3 &> /dev/null && ! command -v pip &> /dev/null; then
    NEED_PIP=true
fi

# Check for whisper
if ! command -v whisper &> /dev/null; then
    NEED_WHISPER=true
    INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} OpenAI Whisper (audio transcription)"
fi

# Check for Ollama
if ! command -v ollama &> /dev/null; then
    NEED_OLLAMA=true
    INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} Ollama + nomic-embed-text (local embeddings)"
fi

# Always installing these
INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} Lucid Memory server"
INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} Whisper model (74MB)"
INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} Claude Code hooks"

# === Show installation summary ===

echo -e "${BOLD}The following will be installed:${NC}"
echo -e "$INSTALL_LIST"
echo ""

AVAILABLE_GB=$((AVAILABLE_SPACE / 1048576))
echo -e "${DIM}Disk space available: ${AVAILABLE_GB}GB${NC}"
echo ""

# Ask for confirmation
if [ "$INTERACTIVE" = true ]; then
    read -p "Continue with installation? [Y/n]: " CONFIRM
    CONFIRM=${CONFIRM:-Y}
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo ""
        echo "Installation cancelled."
        exit 0
    fi
else
    echo "Non-interactive mode, proceeding with installation..."
fi

echo ""
show_progress  # Step 1: Pre-flight checks

# === Install Dependencies ===

# Install Homebrew if needed (macOS only)
if [ "$NEED_BREW" = true ]; then
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
fi

# Install Bun if needed
if [ "$NEED_BUN" = true ]; then
    echo "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"

    if ! command -v bun &> /dev/null; then
        fail "Bun installation failed" \
            "Please install Bun manually: https://bun.sh"
    fi
fi
success "Bun $(bun --version)"

# Install ffmpeg if needed
if [ "$NEED_FFMPEG" = true ]; then
    echo "Installing ffmpeg..."
    FFMPEG_INSTALLED=false
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if brew install ffmpeg; then
            FFMPEG_INSTALLED=true
        fi
    else
        # Linux - try common package managers
        if command -v apt-get &> /dev/null; then
            if sudo apt-get update && sudo apt-get install -y ffmpeg; then
                FFMPEG_INSTALLED=true
            fi
        elif command -v dnf &> /dev/null; then
            if sudo dnf install -y ffmpeg; then
                FFMPEG_INSTALLED=true
            fi
        elif command -v pacman &> /dev/null; then
            if sudo pacman -S --noconfirm ffmpeg; then
                FFMPEG_INSTALLED=true
            fi
        fi
    fi

    if [ "$FFMPEG_INSTALLED" = true ] && command -v ffmpeg &> /dev/null; then
        success "ffmpeg installed"
    else
        fail "Could not install ffmpeg" \
            "Please install ffmpeg manually and run this installer again.\n  macOS: brew install ffmpeg\n  Ubuntu/Debian: sudo apt install ffmpeg\n  Fedora: sudo dnf install ffmpeg"
    fi
else
    success "ffmpeg already installed"
fi

# Install yt-dlp if needed
if [ "$NEED_YTDLP" = true ]; then
    echo "Installing yt-dlp..."
    YTDLP_INSTALLED=false
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if brew install yt-dlp; then
            YTDLP_INSTALLED=true
        fi
    else
        # Linux - try pip first, then package managers
        if command -v pip3 &> /dev/null; then
            if pip3 install --user yt-dlp; then
                YTDLP_INSTALLED=true
                # Add user bin to PATH for this session
                export PATH="$HOME/.local/bin:$PATH"
            fi
        elif command -v pip &> /dev/null; then
            if pip install --user yt-dlp; then
                YTDLP_INSTALLED=true
                export PATH="$HOME/.local/bin:$PATH"
            fi
        elif command -v apt-get &> /dev/null; then
            if sudo apt-get update && sudo apt-get install -y yt-dlp; then
                YTDLP_INSTALLED=true
            fi
        elif command -v dnf &> /dev/null; then
            if sudo dnf install -y yt-dlp; then
                YTDLP_INSTALLED=true
            fi
        fi
    fi

    # Add Python user bin to PATH (different locations on macOS vs Linux)
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: ~/Library/Python/3.X/bin
        for pyver in 3.13 3.12 3.11 3.10 3.9 3.8; do
            if [ -d "$HOME/Library/Python/$pyver/bin" ]; then
                export PATH="$HOME/Library/Python/$pyver/bin:$PATH"
                break
            fi
        done
    else
        # Linux: ~/.local/bin
        export PATH="$HOME/.local/bin:$PATH"
    fi

    if [ "$YTDLP_INSTALLED" = true ] && command -v yt-dlp &> /dev/null; then
        success "yt-dlp installed"
    else
        fail "Could not install yt-dlp" \
            "Please install yt-dlp manually and run this installer again.\n  pip install --user yt-dlp\n  Or: sudo apt install yt-dlp"
    fi
else
    success "yt-dlp already installed"
fi

# Install whisper if needed
if [ "$NEED_WHISPER" = true ]; then
    echo "Installing OpenAI Whisper (this may take a few minutes)..."

    # Check for pip
    if [ "$NEED_PIP" = true ]; then
        fail "pip is not installed" \
            "Please install Python and pip first:\n  macOS: brew install python\n  Ubuntu/Debian: sudo apt install python3-pip\n  Fedora: sudo dnf install python3-pip"
    fi

    WHISPER_INSTALLED=false
    if command -v pip3 &> /dev/null; then
        if pip3 install --user openai-whisper; then
            WHISPER_INSTALLED=true
        fi
    elif command -v pip &> /dev/null; then
        if pip install --user openai-whisper; then
            WHISPER_INSTALLED=true
        fi
    fi

    # Add Python user bin to PATH (different locations on macOS vs Linux)
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: ~/Library/Python/3.X/bin
        for pyver in 3.13 3.12 3.11 3.10 3.9 3.8; do
            if [ -d "$HOME/Library/Python/$pyver/bin" ]; then
                export PATH="$HOME/Library/Python/$pyver/bin:$PATH"
                break
            fi
        done
    else
        # Linux: ~/.local/bin
        export PATH="$HOME/.local/bin:$PATH"
    fi

    if [ "$WHISPER_INSTALLED" = true ] && command -v whisper &> /dev/null; then
        success "Whisper installed"
    else
        fail "Whisper installation failed" \
            "Please install manually: pip install --user openai-whisper\n\nNote: Whisper requires Python 3.8+ and may take several minutes to install."
    fi
else
    success "Whisper already installed"
fi

show_progress  # Step 2: Install dependencies

# === Create Lucid Directory ===

LUCID_DIR="$HOME/.lucid"
LUCID_BIN="$LUCID_DIR/bin"

echo ""
echo "Creating Lucid Memory directory..."

mkdir -p "$LUCID_DIR"
mkdir -p "$LUCID_BIN"

success "Created ~/.lucid"
show_progress  # Step 3: Create directory

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
    if ! cp -r "lucid-memory/packages/lucid-server" "$LUCID_DIR/server"; then
        fail "Failed to copy server files" \
            "Could not copy server to $LUCID_DIR/server"
    fi
    if [ ! -d "$LUCID_DIR/server" ]; then
        fail "Server installation failed" \
            "Server directory not created at $LUCID_DIR/server"
    fi
else
    fail "Invalid repository structure" \
        "The downloaded repository is missing required files."
fi

# Copy native package
if [ -d "lucid-memory/packages/lucid-native" ]; then
    rm -rf "$LUCID_DIR/native" 2>/dev/null || true
    cp -r "lucid-memory/packages/lucid-native" "$LUCID_DIR/native"
fi

# Copy perception package (video processing)
if [ -d "lucid-memory/packages/lucid-perception" ]; then
    rm -rf "$LUCID_DIR/perception" 2>/dev/null || true
    cp -r "lucid-memory/packages/lucid-perception" "$LUCID_DIR/perception"
fi

# Detect platform for pre-built binaries
detect_native_binary() {
    local arch=$(uname -m)
    local os=$(uname -s)

    case "$os" in
        Darwin)
            if [ "$arch" = "arm64" ]; then
                echo "lucid-native.darwin-arm64.node"
            else
                echo "lucid-native.darwin-x64.node"
            fi
            ;;
        Linux)
            if [ "$arch" = "aarch64" ]; then
                echo "lucid-native.linux-arm64-gnu.node"
            else
                echo "lucid-native.linux-x64-gnu.node"
            fi
            ;;
        *)
            echo ""
            ;;
    esac
}

NATIVE_BINARY=$(detect_native_binary)
NATIVE_READY=false

# Check if pre-built binary exists in the repo
if [ -n "$NATIVE_BINARY" ] && [ -f "$LUCID_DIR/native/$NATIVE_BINARY" ]; then
    success "Pre-built native binary found ($NATIVE_BINARY)"
    NATIVE_READY=true
fi

# If no pre-built binary, try to download from latest release
if [ "$NATIVE_READY" = false ] && [ -n "$NATIVE_BINARY" ]; then
    echo "Downloading pre-built native binary..."
    RELEASE_URL="https://github.com/JasonDocton/lucid-memory/releases/latest/download/$NATIVE_BINARY"
    if curl -fsSL "$RELEASE_URL" -o "$LUCID_DIR/native/$NATIVE_BINARY" 2>/dev/null; then
        chmod +x "$LUCID_DIR/native/$NATIVE_BINARY"
        success "Downloaded native binary"
        NATIVE_READY=true
    else
        echo "  No pre-built binary available for download"
    fi
fi

# If still no binary, try to build with Rust
if [ "$NATIVE_READY" = false ]; then
    # Copy Rust crates for building
    if [ -d "lucid-memory/crates" ]; then
        rm -rf "$LUCID_DIR/crates" 2>/dev/null || true
        cp -r "lucid-memory/crates" "$LUCID_DIR/crates"
        cp "lucid-memory/Cargo.toml" "$LUCID_DIR/Cargo.toml"
        cp "lucid-memory/Cargo.lock" "$LUCID_DIR/Cargo.lock" 2>/dev/null || true
    fi

    if command -v cargo &> /dev/null; then
        echo "Building native Rust module (this gives you 100x faster retrieval)..."
        cd "$LUCID_DIR/native"

        # Update the manifest path for installed location
        if command -v jq &> /dev/null; then
            jq '.scripts.build = "napi build --platform --release --manifest-path ../crates/lucid-napi/Cargo.toml --output-dir ."' package.json > package.json.tmp && mv package.json.tmp package.json
        elif command -v python3 &> /dev/null; then
            python3 << 'PYEOF'
import json
with open('package.json', 'r') as f:
    pkg = json.load(f)
pkg['scripts']['build'] = 'napi build --platform --release --manifest-path ../crates/lucid-napi/Cargo.toml --output-dir .'
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
PYEOF
        fi

        # Install napi-rs CLI and build
        if bun install 2>/dev/null && bun run build 2>/dev/null; then
            NATIVE_READY=true
            success "Native Rust module built"
        else
            warn "Native build failed"
        fi
        cd "$LUCID_DIR"
    else
        warn "Rust not installed"
    fi
fi

# Final status
if [ "$NATIVE_READY" = true ]; then
    success "Native module ready (100x faster retrieval)"
else
    warn "Using TypeScript fallback (still works, just slower)"
    echo "  To get 100x faster retrieval, install Rust: https://rustup.rs"
fi

# === Set up Perception Module (Video Processing) ===

detect_perception_binary() {
    local arch=$(uname -m)
    local os=$(uname -s)

    case "$os" in
        Darwin)
            if [ "$arch" = "arm64" ]; then
                echo "lucid-perception.darwin-arm64.node"
            else
                echo "lucid-perception.darwin-x64.node"
            fi
            ;;
        Linux)
            if [ "$arch" = "aarch64" ]; then
                echo "lucid-perception.linux-arm64-gnu.node"
            else
                echo "lucid-perception.linux-x64-gnu.node"
            fi
            ;;
        *)
            echo ""
            ;;
    esac
}

PERCEPTION_BINARY=$(detect_perception_binary)
PERCEPTION_READY=false

# Check if pre-built binary exists in the repo
if [ -n "$PERCEPTION_BINARY" ] && [ -d "$LUCID_DIR/perception" ] && [ -f "$LUCID_DIR/perception/$PERCEPTION_BINARY" ]; then
    success "Pre-built perception binary found ($PERCEPTION_BINARY)"
    PERCEPTION_READY=true
fi

# If no pre-built binary, try to download from latest release
if [ "$PERCEPTION_READY" = false ] && [ -n "$PERCEPTION_BINARY" ] && [ -d "$LUCID_DIR/perception" ]; then
    echo "Downloading pre-built perception binary..."
    PERCEPTION_RELEASE_URL="https://github.com/JasonDocton/lucid-memory/releases/latest/download/$PERCEPTION_BINARY"
    if curl -fsSL "$PERCEPTION_RELEASE_URL" -o "$LUCID_DIR/perception/$PERCEPTION_BINARY" 2>/dev/null; then
        chmod +x "$LUCID_DIR/perception/$PERCEPTION_BINARY"
        success "Downloaded perception binary"
        PERCEPTION_READY=true
    else
        echo "  No pre-built perception binary available for download"
    fi
fi

# If still no binary, try to build with Rust
if [ "$PERCEPTION_READY" = false ] && [ -d "$LUCID_DIR/perception" ]; then
    if command -v cargo &> /dev/null; then
        echo "Building perception module (video processing)..."
        cd "$LUCID_DIR/perception"

        # Update the manifest path for installed location
        if command -v jq &> /dev/null; then
            jq '.scripts.build = "napi build --platform --release --manifest-path ../crates/lucid-perception-napi/Cargo.toml --output-dir ."' package.json > package.json.tmp && mv package.json.tmp package.json
        elif command -v python3 &> /dev/null; then
            python3 << 'PYEOF'
import json
with open('package.json', 'r') as f:
    pkg = json.load(f)
pkg['scripts']['build'] = 'napi build --platform --release --manifest-path ../crates/lucid-perception-napi/Cargo.toml --output-dir .'
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
PYEOF
        fi

        # Install napi-rs CLI and build
        if bun install 2>/dev/null && bun run build 2>/dev/null; then
            PERCEPTION_READY=true
            success "Perception module built"
        else
            warn "Perception build failed"
        fi
        cd "$LUCID_DIR"
    fi
fi

# Final perception status
if [ "$PERCEPTION_READY" = true ]; then
    success "Perception module ready (video processing enabled)"
else
    warn "Perception module not available"
    echo "  Video processing will use fallback methods (slower)"
    echo "  To enable, install Rust: https://rustup.rs"
fi

cd "$LUCID_DIR/server"

# Update package.json to point to the correct native package location (only if native exists)
if [ -f "package.json" ] && [ -d "$LUCID_DIR/native" ]; then
    if command -v jq &> /dev/null; then
        jq '.dependencies["@lucid-memory/native"] = "file:../native"' package.json > package.json.tmp && mv package.json.tmp package.json
    elif command -v python3 &> /dev/null; then
        python3 << 'PYEOF'
import json
with open('package.json', 'r') as f:
    pkg = json.load(f)
if 'dependencies' not in pkg:
    pkg['dependencies'] = {}
pkg['dependencies']['@lucid-memory/native'] = 'file:../native'
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
PYEOF
    fi
elif [ -f "package.json" ]; then
    # Native package doesn't exist, remove the dependency to avoid errors
    if command -v jq &> /dev/null; then
        jq 'del(.dependencies["@lucid-memory/native"])' package.json > package.json.tmp && mv package.json.tmp package.json
    elif command -v python3 &> /dev/null; then
        python3 << 'PYEOF'
import json
with open('package.json', 'r') as f:
    pkg = json.load(f)
if 'dependencies' in pkg and '@lucid-memory/native' in pkg['dependencies']:
    del pkg['dependencies']['@lucid-memory/native']
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
PYEOF
    fi
fi

# Update package.json for perception module
if [ -f "package.json" ] && [ -d "$LUCID_DIR/perception" ]; then
    if command -v jq &> /dev/null; then
        # Move from optionalDependencies to dependencies and update path
        jq 'del(.optionalDependencies["@lucid-memory/perception"]) | .dependencies["@lucid-memory/perception"] = "file:../perception"' package.json > package.json.tmp && mv package.json.tmp package.json
    elif command -v python3 &> /dev/null; then
        python3 << 'PYEOF'
import json
with open('package.json', 'r') as f:
    pkg = json.load(f)
# Remove from optionalDependencies
if 'optionalDependencies' in pkg and '@lucid-memory/perception' in pkg['optionalDependencies']:
    del pkg['optionalDependencies']['@lucid-memory/perception']
# Add to dependencies
if 'dependencies' not in pkg:
    pkg['dependencies'] = {}
pkg['dependencies']['@lucid-memory/perception'] = 'file:../perception'
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
PYEOF
    fi
elif [ -f "package.json" ]; then
    # Perception package doesn't exist, remove the dependency to avoid errors
    if command -v jq &> /dev/null; then
        jq 'del(.optionalDependencies["@lucid-memory/perception"]) | del(.dependencies["@lucid-memory/perception"])' package.json > package.json.tmp && mv package.json.tmp package.json
    elif command -v python3 &> /dev/null; then
        python3 << 'PYEOF'
import json
with open('package.json', 'r') as f:
    pkg = json.load(f)
if 'optionalDependencies' in pkg and '@lucid-memory/perception' in pkg['optionalDependencies']:
    del pkg['optionalDependencies']['@lucid-memory/perception']
if 'dependencies' in pkg and '@lucid-memory/perception' in pkg['dependencies']:
    del pkg['dependencies']['@lucid-memory/perception']
with open('package.json', 'w') as f:
    json.dump(pkg, f, indent=2)
PYEOF
    fi
fi

echo "Installing dependencies..."
if ! bun install; then
    fail "Failed to install dependencies" \
        "Bun package installation failed.\n\nTry running manually:\n  cd ~/.lucid/server && bun install"
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
show_progress  # Step 4: Install server

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

        # Install Ollama if not present (Homebrew already installed if needed)
        if [ "$NEED_OLLAMA" = true ]; then
            echo "Installing Ollama..."

            if [[ "$OSTYPE" == "darwin"* ]]; then
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
show_progress  # Step 5: Embedding provider

# === Download Whisper Model for Transcription ===

LUCID_MODELS="$LUCID_DIR/models"
mkdir -p "$LUCID_MODELS"

if [ ! -f "$LUCID_MODELS/ggml-base.en.bin" ]; then
    echo ""
    echo "Downloading Whisper model for video transcription (74MB)..."
    if curl -L -o "$LUCID_MODELS/ggml-base.en.bin" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" 2>/dev/null; then
        success "Whisper model downloaded"
    else
        warn "Could not download Whisper model - video transcription will be unavailable"
        echo "  To download manually: curl -L -o $LUCID_MODELS/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
    fi
else
    success "Whisper model already present"
fi

# === Auto-Update Preference ===

echo ""
echo -e "${BOLD}Automatic updates:${NC}"
echo "  Lucid Memory can automatically check for and install updates"
echo "  when the server starts. Your data is always preserved."
echo ""

AUTO_UPDATE=false
if [ "$INTERACTIVE" = true ]; then
    read -p "Enable automatic updates? [Y/n]: " AUTO_UPDATE_CHOICE
    AUTO_UPDATE_CHOICE=${AUTO_UPDATE_CHOICE:-Y}
    if [[ "$AUTO_UPDATE_CHOICE" =~ ^[Yy]$ ]]; then
        AUTO_UPDATE=true
    fi
else
    echo "Non-interactive mode, enabling auto-updates by default..."
    AUTO_UPDATE=true
fi

# Write config file
cat > "$LUCID_DIR/config.json" << EOF
{
  "autoUpdate": $AUTO_UPDATE,
  "installedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

if [ "$AUTO_UPDATE" = true ]; then
    success "Auto-updates enabled"
else
    success "Auto-updates disabled (run 'lucid update' manually)"
fi

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
    cat > "$MCP_CONFIG" << EOF
{
  "mcpServers": {
    "lucid-memory": {
      "type": "stdio",
      "command": "$LUCID_BIN/lucid-server",
      "args": []
    }
  }
}
EOF
fi

success "MCP server configured"
show_progress  # Step 6: Configure Claude Code

# === Install Hooks ===

echo ""
echo "Installing memory hooks..."

# Copy hook script to lucid directory
LUCID_HOOKS_DIR="$LUCID_DIR/hooks"
mkdir -p "$LUCID_HOOKS_DIR"

if [ -f "$LUCID_DIR/server/hooks/user-prompt-submit.sh" ]; then
    cp "$LUCID_DIR/server/hooks/user-prompt-submit.sh" "$LUCID_HOOKS_DIR/user-prompt-submit.sh"
    chmod +x "$LUCID_HOOKS_DIR/user-prompt-submit.sh"
    success "Hook script installed"
else
    warn "Hook script not found - automatic context injection disabled"
fi

# Configure hook in Claude Code settings
CLAUDE_SETTINGS="$CLAUDE_SETTINGS_DIR/settings.json"
HOOK_COMMAND="$LUCID_HOOKS_DIR/user-prompt-submit.sh"

configure_hook() {
    local settings_file="$1"
    local hook_cmd="$2"

    # If jq is available, use it
    if command -v jq &> /dev/null; then
        if [ -f "$settings_file" ]; then
            # Add hook to existing settings
            jq --arg cmd "$hook_cmd" '
                .hooks.UserPromptSubmit = [
                    {
                        "hooks": [
                            {"type": "command", "command": $cmd}
                        ]
                    }
                ]
            ' "$settings_file" > "$settings_file.tmp" && mv "$settings_file.tmp" "$settings_file"
        else
            # Create new settings file
            jq -n --arg cmd "$hook_cmd" '
                {
                    "hooks": {
                        "UserPromptSubmit": [
                            {
                                "hooks": [
                                    {"type": "command", "command": $cmd}
                                ]
                            }
                        ]
                    }
                }
            ' > "$settings_file"
        fi
        return 0
    fi

    # If python is available, use it
    if command -v python3 &> /dev/null; then
        python3 << EOF
import json
import os

settings_file = '$settings_file'
hook_cmd = '$hook_cmd'

if os.path.exists(settings_file):
    with open(settings_file, 'r') as f:
        config = json.load(f)
else:
    config = {}

if 'hooks' not in config:
    config['hooks'] = {}

config['hooks']['UserPromptSubmit'] = [
    {
        'hooks': [
            {'type': 'command', 'command': hook_cmd}
        ]
    }
]

with open(settings_file, 'w') as f:
    json.dump(config, f, indent=2)
EOF
        return 0
    fi

    # Fallback: create minimal settings file
    if [ ! -f "$settings_file" ]; then
        cat > "$settings_file" << EOF
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {"type": "command", "command": "$hook_cmd"}
        ]
      }
    ]
  }
}
EOF
        return 0
    fi

    warn "Cannot safely modify settings.json without jq or python"
    echo ""
    echo "Please manually add this to $settings_file:"
    echo -e "${BOLD}\"hooks\": { \"UserPromptSubmit\": [{ \"hooks\": [{ \"type\": \"command\", \"command\": \"$hook_cmd\" }] }] }${NC}"
    return 1
}

if configure_hook "$CLAUDE_SETTINGS" "$HOOK_COMMAND"; then
    success "Hook configured in settings.json"
else
    warn "Hook configuration requires manual setup"
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
show_progress  # Step 7: Install hooks & PATH

# === Cleanup ===

rm -rf "$TEMP_DIR"

# === Post-Installation Verification ===

INSTALL_ERRORS=""

# Check critical files exist
if [ ! -f "$LUCID_DIR/server/src/server.ts" ]; then
    INSTALL_ERRORS="${INSTALL_ERRORS}\n  - Server script missing"
fi

if [ ! -x "$LUCID_BIN/lucid-server" ]; then
    INSTALL_ERRORS="${INSTALL_ERRORS}\n  - Server launcher missing"
fi

if [ ! -x "$LUCID_BIN/lucid" ]; then
    INSTALL_ERRORS="${INSTALL_ERRORS}\n  - CLI missing"
fi

if [ ! -f "$MCP_CONFIG" ]; then
    INSTALL_ERRORS="${INSTALL_ERRORS}\n  - MCP config not created"
fi

# Check Bun is available
if ! command -v bun &> /dev/null; then
    INSTALL_ERRORS="${INSTALL_ERRORS}\n  - Bun not in PATH (restart terminal)"
fi

if [ -n "$INSTALL_ERRORS" ]; then
    echo ""
    warn "Installation completed with issues:"
    echo -e "$INSTALL_ERRORS"
    echo ""
    echo "Run 'lucid status' after restarting your terminal to diagnose."
fi

# === Restart Claude Code ===

restart_claude_code
show_progress  # Step 8: Restart Claude Code

# === Done! ===

echo ""
echo -e "${C1}  ██╗     ██╗   ██╗ ██████╗██╗██████╗ ${NC}"
echo -e "${C2}  ██║     ██║   ██║██╔════╝██║██╔══██╗${NC}"
echo -e "${C3}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
echo -e "${C4}  ██║     ██║   ██║██║     ██║██║  ██║${NC}"
echo -e "${C5}  ███████╗╚██████╔╝╚██████╗██║██████╔╝${NC}"
echo -e "${C6}  ╚══════╝ ╚═════╝  ╚═════╝╚═╝╚═════╝ ${NC}"
echo -e "          ${C3}M ${C4}E ${C5}M ${C6}O ${C5}R ${C4}Y${NC}"
echo ""
echo -e "       ${GREEN}✓${NC} ${BOLD}Installed Successfully!${NC}"
echo ""
echo -e "  Just use Claude Code normally - your memories"
echo -e "  build automatically over time."
echo ""
echo -e "  ${DIM}Troubleshooting:${NC}"
echo -e "  ${C4}lucid status${NC}  - Check if everything is working"
echo -e "  ${C4}lucid stats${NC}   - View memory statistics"
echo ""
echo -e "  ${DIM}To uninstall:${NC}"
echo -e "  ${C4}curl -fsSL lucidmemory.dev/uninstall | bash${NC}"
echo ""
echo -e "${DIM}  ─────────────────────────────────────────${NC}"
echo ""
echo -e "  ${YELLOW}Note:${NC} Please restart your terminal to use the 'lucid' command."
echo ""
