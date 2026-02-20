#!/bin/bash

# Lucid Memory Installer
#
# One-liner installation:
#   curl -fsSL https://lucidmemory.dev/install | bash
#
# What this does:
#   1. Checks all prerequisites (git, disk space, etc.)
#   2. Installs Bun if needed
#   3. Creates ~/.lucid directory
#   4. Downloads and installs lucid-server
#   5. Downloads BGE embedding model (or configures OpenAI)
#   6. Configures Claude Code MCP settings
#   7. Installs hooks for automatic memory capture
#   8. Restarts Claude Code to activate

set -e

# Cleanup on exit: restore cursor, remove temp directory
INSTALL_TEMP_DIR=""
cleanup() {
    tput cnorm 2>/dev/null || true
    if [ -n "$INSTALL_TEMP_DIR" ] && [ -d "$INSTALL_TEMP_DIR" ]; then
        rm -rf "$INSTALL_TEMP_DIR"
    fi
}
trap cleanup EXIT

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
    echo -e "  ${DIM}AI coding assistants that remember.${NC}"
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
    # Use -P (POSIX) to prevent line-wrapping on long device names
    df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}'
}

# Check if JSON is valid
validate_json() {
    if command -v python3 &> /dev/null; then
        python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$1" 2>/dev/null
        return $?
    elif command -v python &> /dev/null; then
        python -c "import json,sys; json.load(open(sys.argv[1]))" "$1" 2>/dev/null
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
        jq --arg cmd "$server_path" '.mcpServers["lucid-memory"] = {"type": "stdio", "command": $cmd, "args": [], "env": {"LUCID_CLIENT": "claude"}}' \
            "$config_file" > "$config_file.tmp" && mv "$config_file.tmp" "$config_file"
        return 0
    fi

    # If python is available, use it
    if command -v python3 &> /dev/null; then
        python3 - "$config_file" "$server_path" << 'PYEOF'
import json, sys
config_file, server_path = sys.argv[1], sys.argv[2]
with open(config_file, 'r') as f:
    config = json.load(f)
if 'mcpServers' not in config:
    config['mcpServers'] = {}
config['mcpServers']['lucid-memory'] = {'type': 'stdio', 'command': server_path, 'args': [], 'env': {'LUCID_CLIENT': 'claude'}}
with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)
PYEOF
        return 0
    fi

    # Last resort: check if we can safely append
    if grep -q '"mcpServers"' "$config_file"; then
        warn "Cannot safely modify existing MCP config without jq or python"
        echo ""
        echo "Please manually add this to $config_file in the mcpServers section:"
        echo -e "${BOLD}  \"lucid-memory\": { \"type\": \"stdio\", \"command\": \"$server_path\", \"args\": [], \"env\": {\"LUCID_CLIENT\": \"claude\"} }${NC}"
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
      "args": [],
      "env": {"LUCID_CLIENT": "claude"}
    }
  }
}
EOF
    fi
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
        if pgrep -x "claude" > /dev/null; then
            pkill -x "claude" 2>/dev/null || true
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

# Check for Claude Code (optional - user may install for other clients only)
CLAUDE_SETTINGS_DIR="$HOME/.claude"
if [ ! -d "$CLAUDE_SETTINGS_DIR" ]; then
    warn "Claude Code not found (~/.claude does not exist)"
    echo "  If you plan to use Claude Code, install it first: https://claude.ai/download"
    echo ""
fi

# Check disk space
AVAILABLE_SPACE=$(get_available_space)
if [ -n "$AVAILABLE_SPACE" ] && [ "$AVAILABLE_SPACE" -lt "$MIN_DISK_SPACE" ] 2>/dev/null; then
    AVAILABLE_GB=$((AVAILABLE_SPACE / 1048576))
    fail "Insufficient disk space" \
        "Lucid Memory requires at least 5GB of free space.\nAvailable: ${AVAILABLE_GB}GB"
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

# Always installing these
INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} Lucid Memory server"
INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} BGE embedding model (~105MB)"
INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} Whisper model (74MB)"
INSTALL_LIST="${INSTALL_LIST}\n  ${C4}•${NC} Claude Code hooks"

# === Show installation summary ===

echo -e "${BOLD}The following will be installed:${NC}"
echo -e "$INSTALL_LIST"
echo ""

if [ -n "$AVAILABLE_SPACE" ] && [ "$AVAILABLE_SPACE" -gt 0 ] 2>/dev/null; then
    AVAILABLE_GB=$((AVAILABLE_SPACE / 1048576))
    echo -e "${DIM}Disk space available: ${AVAILABLE_GB}GB${NC}"
fi
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
BUN_VER=$(bun --version 2>/dev/null || echo "unknown")
success "Bun $BUN_VER"

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
        # Use sudo -n (non-interactive) when stdin isn't a terminal to avoid hanging
        SUDO_CMD="sudo"
        if [ "$INTERACTIVE" = false ]; then
            SUDO_CMD="sudo -n"
        fi

        if command -v apt-get &> /dev/null; then
            if $SUDO_CMD apt-get update -y && $SUDO_CMD apt-get install -y ffmpeg; then
                FFMPEG_INSTALLED=true
            fi
        elif command -v dnf &> /dev/null; then
            if $SUDO_CMD dnf install -y ffmpeg; then
                FFMPEG_INSTALLED=true
            fi
        elif command -v pacman &> /dev/null; then
            if $SUDO_CMD pacman -S --noconfirm ffmpeg; then
                FFMPEG_INSTALLED=true
            fi
        elif command -v apk &> /dev/null; then
            if $SUDO_CMD apk add ffmpeg; then
                FFMPEG_INSTALLED=true
            fi
        fi
    fi

    if [ "$FFMPEG_INSTALLED" = true ] && command -v ffmpeg &> /dev/null; then
        success "ffmpeg installed"
    else
        warn "Could not install ffmpeg (needed for video processing)"
        echo "  Install manually: sudo apt install ffmpeg (or equivalent for your distro)"
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
        # Use sudo -n (non-interactive) when stdin isn't a terminal to avoid hanging
        SUDO_CMD="sudo"
        if [ "$INTERACTIVE" = false ]; then
            SUDO_CMD="sudo -n"
        fi

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
            if $SUDO_CMD apt-get update -y && $SUDO_CMD apt-get install -y yt-dlp; then
                YTDLP_INSTALLED=true
            fi
        elif command -v dnf &> /dev/null; then
            if $SUDO_CMD dnf install -y yt-dlp; then
                YTDLP_INSTALLED=true
            fi
        elif command -v apk &> /dev/null; then
            if $SUDO_CMD apk add yt-dlp; then
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
        warn "Could not install yt-dlp (needed for video downloads)"
        echo "  Install manually: pip install --user yt-dlp"
    fi
else
    success "yt-dlp already installed"
fi

# Install whisper if needed (optional — native Rust module handles transcription via whisper.cpp)
if [ "$NEED_WHISPER" = true ]; then
    if [ "$NEED_PIP" = false ]; then
        echo "Installing OpenAI Whisper (this may take a few minutes)..."

        WHISPER_INSTALLED=false
        if command -v pip3 &> /dev/null; then
            if pip3 install --user openai-whisper 2>/dev/null; then
                WHISPER_INSTALLED=true
            fi
        elif command -v pip &> /dev/null; then
            if pip install --user openai-whisper 2>/dev/null; then
                WHISPER_INSTALLED=true
            fi
        fi

        # Add Python user bin to PATH (different locations on macOS vs Linux)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            for pyver in 3.13 3.12 3.11 3.10 3.9 3.8; do
                if [ -d "$HOME/Library/Python/$pyver/bin" ]; then
                    export PATH="$HOME/Library/Python/$pyver/bin:$PATH"
                    break
                fi
            done
        else
            export PATH="$HOME/.local/bin:$PATH"
        fi

        if [ "$WHISPER_INSTALLED" = true ] && command -v whisper &> /dev/null; then
            success "Whisper CLI installed"
        else
            warn "Whisper CLI not installed (video transcription will use native module or be skipped)"
        fi
    else
        warn "Whisper CLI skipped (pip not found — video transcription will use native module or be skipped)"
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
INSTALL_TEMP_DIR="$TEMP_DIR"
cd "$TEMP_DIR"

# Clone the repository (shallow clone for speed)
# GIT_TERMINAL_PROMPT=0 prevents git from asking for credentials if repo not found
DOWNLOAD_OK=false
if GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://github.com/JasonDocton/lucid-memory.git 2>/dev/null; then
    DOWNLOAD_OK=true
fi

# Fallback: download zip archive if git clone fails
if [ "$DOWNLOAD_OK" = false ]; then
    warn "Git clone failed, trying zip download..."
    # Clean up partial git clone directory if it exists
    rm -rf "lucid-memory" 2>/dev/null
    if curl -fsSL "https://github.com/JasonDocton/lucid-memory/archive/refs/heads/main.zip" -o "lucid-memory.zip" 2>/dev/null; then
        if command -v unzip &> /dev/null; then
            unzip -q "lucid-memory.zip" && mv "lucid-memory-main" "lucid-memory" && DOWNLOAD_OK=true
        elif command -v python3 &> /dev/null; then
            python3 -c "import zipfile; zipfile.ZipFile('lucid-memory.zip').extractall()" && mv "lucid-memory-main" "lucid-memory" && DOWNLOAD_OK=true
        fi
        rm -f "lucid-memory.zip"
    fi
fi

if [ "$DOWNLOAD_OK" = false ]; then
    fail "Could not download Lucid Memory" \
        "Please check your internet connection and try again.\n\nIf the problem persists, try downloading manually:\n  https://github.com/JasonDocton/lucid-memory"
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

# Detect if the system uses musl libc (Alpine, Void, etc.)
is_musl() {
    # Check for musl dynamic linker
    if [ -f /lib/ld-musl-x86_64.so.1 ] || [ -f /lib/ld-musl-aarch64.so.1 ]; then
        return 0
    fi
    # Check ldd version string
    if command -v ldd &> /dev/null; then
        if ldd --version 2>&1 | grep -qi musl; then
            return 0
        fi
    fi
    return 1
}

# Detect platform for pre-built binaries
detect_native_binary() {
    local arch=$(uname -m)
    local os=$(uname -s)
    local libc="gnu"
    if [ "$os" = "Linux" ] && is_musl; then
        libc="musl"
    fi

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
                echo "lucid-native.linux-arm64-${libc}.node"
            else
                echo "lucid-native.linux-x64-${libc}.node"
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
        # Validate the downloaded file is non-empty
        if [ -s "$LUCID_DIR/native/$NATIVE_BINARY" ]; then
            chmod +x "$LUCID_DIR/native/$NATIVE_BINARY"
            success "Downloaded native binary"
            NATIVE_READY=true
        else
            rm -f "$LUCID_DIR/native/$NATIVE_BINARY"
            echo "  Downloaded binary was empty, skipping"
        fi
    else
        rm -f "$LUCID_DIR/native/$NATIVE_BINARY" 2>/dev/null
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
    local libc="gnu"
    if [ "$os" = "Linux" ] && is_musl; then
        libc="musl"
    fi

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
                echo "lucid-perception.linux-arm64-${libc}.node"
            else
                echo "lucid-perception.linux-x64-${libc}.node"
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
        # Validate the downloaded file is non-empty
        if [ -s "$LUCID_DIR/perception/$PERCEPTION_BINARY" ]; then
            chmod +x "$LUCID_DIR/perception/$PERCEPTION_BINARY"
            success "Downloaded perception binary"
            PERCEPTION_READY=true
        else
            rm -f "$LUCID_DIR/perception/$PERCEPTION_BINARY"
            echo "  Downloaded perception binary was empty, skipping"
        fi
    else
        rm -f "$LUCID_DIR/perception/$PERCEPTION_BINARY" 2>/dev/null
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
        if jq '.dependencies["@lucid-memory/native"] = "file:../native"' package.json > package.json.tmp 2>/dev/null; then
            mv package.json.tmp package.json
        else
            rm -f package.json.tmp
        fi
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
        if jq 'del(.dependencies["@lucid-memory/native"])' package.json > package.json.tmp 2>/dev/null; then
            mv package.json.tmp package.json
        else
            rm -f package.json.tmp
        fi
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
        if jq 'del(.optionalDependencies["@lucid-memory/perception"]) | .dependencies["@lucid-memory/perception"] = "file:../perception"' package.json > package.json.tmp 2>/dev/null; then
            mv package.json.tmp package.json
        else
            rm -f package.json.tmp
        fi
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
        if jq 'del(.optionalDependencies["@lucid-memory/perception"]) | del(.dependencies["@lucid-memory/perception"])' package.json > package.json.tmp 2>/dev/null; then
            mv package.json.tmp package.json
        else
            rm -f package.json.tmp
        fi
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

# Built-in BGE-base-en-v1.5 model runs in-process (no external services needed)
# OpenAI API key is an optional override for power users
echo ""
echo -e "${BOLD}Embedding provider:${NC}"
echo "  Using built-in BGE-base-en-v1.5 model (no external services needed)"
echo ""
echo "  Optional: provide an OpenAI API key to use cloud embeddings instead."
echo ""

OPENAI_KEY=""
if [ "$INTERACTIVE" = true ]; then
    read -p "OpenAI API key (press Enter to skip): " OPENAI_KEY
fi
if [ -n "$OPENAI_KEY" ]; then
    echo "OPENAI_API_KEY=$OPENAI_KEY" > "$LUCID_DIR/.env"
    success "OpenAI configured as embedding provider"
else
    success "Using built-in BGE embeddings (recommended)"
fi
show_progress  # Step 5: Embedding provider

# === Client Selection ===

echo ""
echo -e "${BOLD}Which AI coding assistants do you use?${NC}"
echo "  [1] Claude Code"
echo "  [2] OpenAI Codex"
echo "  [3] OpenCode"
echo ""
echo "  Enter numbers separated by spaces (e.g. '1 3')"
echo "  Press Enter for all clients."
echo ""

INSTALL_CLAUDE=false
INSTALL_CODEX=false
INSTALL_OPENCODE=false

if [ "$INTERACTIVE" = true ]; then
    read -p "Choice: " CLIENT_INPUT
    CLIENT_INPUT=${CLIENT_INPUT:-"1 2 3"}
else
    echo "Non-interactive mode, defaulting to Claude Code only..."
    CLIENT_INPUT="1"
fi

# Parse space-separated numbers
VALID_SELECTION=false
for num in $CLIENT_INPUT; do
    case $num in
        1) INSTALL_CLAUDE=true; VALID_SELECTION=true ;;
        2) INSTALL_CODEX=true; VALID_SELECTION=true ;;
        3) INSTALL_OPENCODE=true; VALID_SELECTION=true ;;
    esac
done

if [ "$VALID_SELECTION" = false ]; then
    warn "Invalid selection, defaulting to Claude Code"
    INSTALL_CLAUDE=true
fi

# === Database Mode (only if multiple clients) ===

DB_MODE="shared"
CLAUDE_PROFILE="default"
CODEX_PROFILE="default"
OPENCODE_PROFILE="default"

# Count selected clients
SELECTED_COUNT=0
[ "$INSTALL_CLAUDE" = true ] && SELECTED_COUNT=$((SELECTED_COUNT + 1))
[ "$INSTALL_CODEX" = true ] && SELECTED_COUNT=$((SELECTED_COUNT + 1))
[ "$INSTALL_OPENCODE" = true ] && SELECTED_COUNT=$((SELECTED_COUNT + 1))

if [ "$SELECTED_COUNT" -ge 2 ]; then
    echo ""
    echo -e "${BOLD}Database configuration:${NC}"
    echo "  [1] Shared - Same memories for all clients (recommended)"
    echo "  [2] Separate - Each client has its own database"
    echo "  [3] Profiles - Custom profiles (e.g., work vs home)"
    echo ""

    if [ "$INTERACTIVE" = true ]; then
        read -p "Choice [1]: " DB_CHOICE
        DB_CHOICE=${DB_CHOICE:-1}
    else
        DB_CHOICE=1
    fi

    case $DB_CHOICE in
        2) DB_MODE="per-client" ;;
        3)
            DB_MODE="profiles"
            if [ "$INTERACTIVE" = true ]; then
                if [ "$INSTALL_CLAUDE" = true ]; then
                    read -p "Profile for Claude Code [home]: " CLAUDE_PROFILE
                    CLAUDE_PROFILE=${CLAUDE_PROFILE:-home}
                    CLAUDE_PROFILE=$(echo "$CLAUDE_PROFILE" | sed 's/[^a-zA-Z0-9_-]//g')
                fi
                if [ "$INSTALL_CODEX" = true ]; then
                    read -p "Profile for Codex [work]: " CODEX_PROFILE
                    CODEX_PROFILE=${CODEX_PROFILE:-work}
                    CODEX_PROFILE=$(echo "$CODEX_PROFILE" | sed 's/[^a-zA-Z0-9_-]//g')
                fi
                if [ "$INSTALL_OPENCODE" = true ]; then
                    read -p "Profile for OpenCode [default]: " OPENCODE_PROFILE
                    OPENCODE_PROFILE=${OPENCODE_PROFILE:-default}
                    OPENCODE_PROFILE=$(echo "$OPENCODE_PROFILE" | sed 's/[^a-zA-Z0-9_-]//g')
                fi
            else
                CLAUDE_PROFILE="home"
                CODEX_PROFILE="work"
                OPENCODE_PROFILE="default"
            fi
            ;;
    esac
fi

# === Download Models ===

LUCID_MODELS="$LUCID_DIR/models"
mkdir -p "$LUCID_MODELS"

# ── BGE embedding model configuration ──
# Change BGE_VARIANT to switch model (quantized | fp32).
# "quantized" = ~105 MB, "fp32" = ~416 MB.  Must match DEFAULT_MODEL_FILE in embedding.rs.
BGE_VARIANT="quantized"

if [ "$BGE_VARIANT" = "fp32" ]; then
    BGE_MODEL_FILE="bge-base-en-v1.5.onnx"
    BGE_MODEL_URL="https://huggingface.co/Xenova/bge-base-en-v1.5/resolve/main/onnx/model.onnx"
    BGE_MODEL_SIZE_DESC="~416MB"
    BGE_MIN_SIZE=400000000
else
    BGE_MODEL_FILE="bge-base-en-v1.5-quantized.onnx"
    BGE_MODEL_URL="https://huggingface.co/Xenova/bge-base-en-v1.5/resolve/main/onnx/model_quantized.onnx"
    BGE_MODEL_SIZE_DESC="~105MB"
    BGE_MIN_SIZE=100000000
fi
BGE_TOKENIZER_FILE="bge-base-en-v1.5-tokenizer.json"
BGE_TOKENIZER_URL="https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/tokenizer.json"

# Remove old incompatible model variants
rm -f "$LUCID_MODELS/bge-base-en-v1.5-fp16.onnx"
for f in "$LUCID_MODELS"/bge-base-en-v1.5*.onnx; do
    [ -f "$f" ] && [ "$(basename "$f")" != "$BGE_MODEL_FILE" ] && rm -f "$f"
done

if [ ! -f "$LUCID_MODELS/$BGE_MODEL_FILE" ]; then
    echo ""
    echo "Downloading BGE embedding model ($BGE_MODEL_SIZE_DESC)..."
    rm -f "$LUCID_MODELS/$BGE_MODEL_FILE.tmp"
    if curl -fL --progress-bar -o "$LUCID_MODELS/$BGE_MODEL_FILE.tmp" "$BGE_MODEL_URL"; then
        FILE_SIZE=$(wc -c < "$LUCID_MODELS/$BGE_MODEL_FILE.tmp" 2>/dev/null | tr -d ' ')
        if [ "${FILE_SIZE:-0}" -gt "$BGE_MIN_SIZE" ]; then
            mv "$LUCID_MODELS/$BGE_MODEL_FILE.tmp" "$LUCID_MODELS/$BGE_MODEL_FILE"
            success "BGE embedding model downloaded"
        else
            rm -f "$LUCID_MODELS/$BGE_MODEL_FILE.tmp"
            warn "Downloaded BGE model is too small (${FILE_SIZE} bytes) - may be corrupted"
        fi
    else
        rm -f "$LUCID_MODELS/$BGE_MODEL_FILE.tmp"
        warn "Could not download BGE model - embeddings will fall back to OpenAI if available"
    fi
else
    success "BGE embedding model already present"
fi

if [ ! -f "$LUCID_MODELS/$BGE_TOKENIZER_FILE" ]; then
    echo "Downloading BGE tokenizer..."
    rm -f "$LUCID_MODELS/$BGE_TOKENIZER_FILE.tmp"
    if curl -fL --progress-bar -o "$LUCID_MODELS/$BGE_TOKENIZER_FILE.tmp" "$BGE_TOKENIZER_URL" \
      && [ -s "$LUCID_MODELS/$BGE_TOKENIZER_FILE.tmp" ]; then
        mv "$LUCID_MODELS/$BGE_TOKENIZER_FILE.tmp" "$LUCID_MODELS/$BGE_TOKENIZER_FILE"
        success "BGE tokenizer downloaded"
    else
        rm -f "$LUCID_MODELS/$BGE_TOKENIZER_FILE.tmp"
        warn "Could not download BGE tokenizer"
    fi
else
    success "BGE tokenizer already present"
fi

# Whisper model for video transcription (74MB)
if [ ! -f "$LUCID_MODELS/ggml-base.en.bin" ]; then
    echo ""
    echo "Downloading Whisper model for video transcription (74MB)..."
    rm -f "$LUCID_MODELS/ggml-base.en.bin.tmp"
    if curl -fL --progress-bar -o "$LUCID_MODELS/ggml-base.en.bin.tmp" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" \
      && [ -s "$LUCID_MODELS/ggml-base.en.bin.tmp" ]; then
        mv "$LUCID_MODELS/ggml-base.en.bin.tmp" "$LUCID_MODELS/ggml-base.en.bin"
        success "Whisper model downloaded"
    else
        rm -f "$LUCID_MODELS/ggml-base.en.bin.tmp"
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

# Write config file with multi-client support
write_config() {
    local auto_update="$1"
    local db_mode="$2"
    local install_claude="$3"
    local install_codex="$4"
    local claude_profile="$5"
    local codex_profile="$6"
    local install_opencode="$7"
    local opencode_profile="$8"

    # Build clients section dynamically
    local client_entries=()
    if [ "$install_claude" = true ]; then
        client_entries+=("\"claude\": {\"enabled\": true, \"profile\": \"$claude_profile\"}")
    fi
    if [ "$install_codex" = true ]; then
        client_entries+=("\"codex\": {\"enabled\": true, \"profile\": \"$codex_profile\"}")
    fi
    if [ "$install_opencode" = true ]; then
        client_entries+=("\"opencode\": {\"enabled\": true, \"profile\": \"$opencode_profile\"}")
    fi

    # Join client entries with comma
    local clients=""
    local first=true
    for entry in "${client_entries[@]}"; do
        if [ "$first" = true ]; then
            clients="$entry"
            first=false
        else
            clients="$clients, $entry"
        fi
    done

    # Build profiles section - collect unique non-default profiles
    local profiles="\"default\": {\"dbPath\": \"~/.lucid/memory.db\"}"
    local seen_profiles="default"
    for prof in "$claude_profile" "$codex_profile" "$opencode_profile"; do
        if [ "$prof" != "default" ]; then
            # Check if already added (bash 3.x compatible string check)
            case " $seen_profiles " in
                *" $prof "*)
                    # Already added
                    ;;
                *)
                    profiles="$profiles, \"$prof\": {\"dbPath\": \"~/.lucid/memory-$prof.db\"}"
                    seen_profiles="$seen_profiles $prof"
                    ;;
            esac
        fi
    done

    cat > "$LUCID_DIR/config.json" << CONFIGEOF
{
  "autoUpdate": $auto_update,
  "installedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "databaseMode": "$db_mode",
  "clients": {$clients},
  "profiles": {$profiles}
}
CONFIGEOF
}

write_config "$AUTO_UPDATE" "$DB_MODE" "$INSTALL_CLAUDE" "$INSTALL_CODEX" "$CLAUDE_PROFILE" "$CODEX_PROFILE" "$INSTALL_OPENCODE" "$OPENCODE_PROFILE"

if [ "$AUTO_UPDATE" = true ]; then
    success "Auto-updates enabled"
else
    success "Auto-updates disabled (run 'lucid update' manually)"
fi

# === Configure Claude Code ===

if [ "$INSTALL_CLAUDE" = true ]; then
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
      "args": [],
      "env": {"LUCID_CLIENT": "claude"}
    }
  }
}
EOF
    fi

    success "Claude Code MCP configured"
fi

# === Configure OpenAI Codex ===

configure_codex_mcp() {
    local CODEX_DIR="$HOME/.codex"
    local CODEX_CONFIG="$CODEX_DIR/config.toml"

    mkdir -p "$CODEX_DIR"

    # Backup if exists
    [ -f "$CODEX_CONFIG" ] && cp "$CODEX_CONFIG" "$CODEX_CONFIG.backup"

    # Remove existing lucid-memory section if present
    if [ -f "$CODEX_CONFIG" ] && grep -q '^\[mcp_servers\.lucid-memory\]' "$CODEX_CONFIG"; then
        # Use awk to remove the section (everything from the header to next section or EOF)
        awk '
            /^\[mcp_servers\.lucid-memory\]/ { skip=1; next }
            /^\[/ { skip=0 }
            !skip
        ' "$CODEX_CONFIG" > "$CODEX_CONFIG.tmp"
        mv "$CODEX_CONFIG.tmp" "$CODEX_CONFIG"
    fi

    # Append new config
    cat >> "$CODEX_CONFIG" << CODEXEOF

[mcp_servers.lucid-memory]
enabled = true
command = "$HOME/.lucid/bin/lucid-server"
args = []

[mcp_servers.lucid-memory.env]
LUCID_CLIENT = "codex"
CODEXEOF

    success "Codex MCP configured"
}

if [ "$INSTALL_CODEX" = true ]; then
    echo ""
    echo "Configuring OpenAI Codex..."
    configure_codex_mcp
fi

# === Configure OpenCode ===

configure_opencode_mcp() {
    local OPENCODE_DIR="$HOME/.config/opencode"
    local OPENCODE_CONFIG="$OPENCODE_DIR/opencode.json"

    mkdir -p "$OPENCODE_DIR"

    # Backup if exists
    [ -f "$OPENCODE_CONFIG" ] && cp "$OPENCODE_CONFIG" "$OPENCODE_CONFIG.backup"

    local server_path="$HOME/.lucid/bin/lucid-server"

    # If jq is available, use it (safest)
    if command -v jq &> /dev/null; then
        if [ -f "$OPENCODE_CONFIG" ]; then
            jq --arg cmd "$server_path" '.mcp["lucid-memory"] = {"type": "local", "command": ["bash", $cmd], "environment": {"LUCID_CLIENT": "opencode"}}' \
                "$OPENCODE_CONFIG" > "$OPENCODE_CONFIG.tmp" && mv "$OPENCODE_CONFIG.tmp" "$OPENCODE_CONFIG"
        else
            jq -n --arg cmd "$server_path" '{"mcp": {"lucid-memory": {"type": "local", "command": ["bash", $cmd], "environment": {"LUCID_CLIENT": "opencode"}}}}' \
                > "$OPENCODE_CONFIG"
        fi
        return 0
    fi

    # If python is available, use it
    if command -v python3 &> /dev/null; then
        python3 - "$OPENCODE_CONFIG" "$server_path" << 'PYEOF'
import json, sys, os
config_file, server_path = sys.argv[1], sys.argv[2]
if os.path.exists(config_file):
    with open(config_file, 'r') as f:
        config = json.load(f)
else:
    config = {}
if 'mcp' not in config:
    config['mcp'] = {}
config['mcp']['lucid-memory'] = {
    'type': 'local',
    'command': ['bash', server_path],
    'environment': {'LUCID_CLIENT': 'opencode'}
}
with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)
PYEOF
        return 0
    fi

    # Fallback: write fresh config
    cat > "$OPENCODE_CONFIG" << EOF
{
  "mcp": {
    "lucid-memory": {
      "type": "local",
      "command": ["bash", "$server_path"],
      "environment": {"LUCID_CLIENT": "opencode"}
    }
  }
}
EOF
}

if [ "$INSTALL_OPENCODE" = true ]; then
    echo ""
    echo "Configuring OpenCode..."
    configure_opencode_mcp
    success "OpenCode MCP configured"
fi

show_progress  # Step 6: Configure clients

# === Install Hooks ===

echo ""
echo "Installing memory hooks..."

# Copy hook scripts to lucid directory
LUCID_HOOKS_DIR="$LUCID_DIR/hooks"
mkdir -p "$LUCID_HOOKS_DIR"

# Claude Code hook (UserPromptSubmit)
if [ "$INSTALL_CLAUDE" = true ]; then
    if [ -f "$LUCID_DIR/server/hooks/user-prompt-submit.sh" ]; then
        cp "$LUCID_DIR/server/hooks/user-prompt-submit.sh" "$LUCID_HOOKS_DIR/user-prompt-submit.sh"
        chmod +x "$LUCID_HOOKS_DIR/user-prompt-submit.sh"
        success "Claude hook script installed"
    else
        warn "Claude hook script not found - automatic context injection disabled"
    fi
fi

# Codex hook (notify on turn-complete)
if [ "$INSTALL_CODEX" = true ]; then
    if [ -f "$LUCID_DIR/server/hooks/codex-notify.sh" ]; then
        cp "$LUCID_DIR/server/hooks/codex-notify.sh" "$LUCID_HOOKS_DIR/codex-notify.sh"
        chmod +x "$LUCID_HOOKS_DIR/codex-notify.sh"
        success "Codex hook script installed"

        # Add notify hook to Codex config
        CODEX_CONFIG="$HOME/.codex/config.toml"
        if [ -f "$CODEX_CONFIG" ]; then
            # Check if notify is already configured
            if ! grep -q '^notify' "$CODEX_CONFIG"; then
                echo "" >> "$CODEX_CONFIG"
                echo "notify = [\"$LUCID_HOOKS_DIR/codex-notify.sh\"]" >> "$CODEX_CONFIG"
                success "Codex notify hook configured"
            fi
        fi
    else
        warn "Codex hook script not found - automatic memory capture disabled"
    fi
fi

# OpenCode plugin
if [ "$INSTALL_OPENCODE" = true ]; then
    if [ -f "$LUCID_DIR/server/plugins/opencode-lucid-memory.ts" ]; then
        mkdir -p "$HOME/.config/opencode/plugins"
        cp "$LUCID_DIR/server/plugins/opencode-lucid-memory.ts" \
           "$HOME/.config/opencode/plugins/lucid-memory.ts"
        success "OpenCode plugin installed"
    else
        warn "OpenCode plugin not found in server package"
    fi
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
            # Merge: keep existing non-Lucid hooks, add Lucid's entry
            jq --arg cmd "$hook_cmd" '
                .hooks.UserPromptSubmit = (
                    [(.hooks.UserPromptSubmit // [])[] | select(
                        (.hooks // []) | all(.command | test("lucid|user-prompt-submit") | not)
                    )] + [{"hooks": [{"type": "command", "command": $cmd}]}]
                )
            ' "$settings_file" > "$settings_file.tmp" && mv "$settings_file.tmp" "$settings_file"
        else
            jq -n --arg cmd "$hook_cmd" '
                {"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": $cmd}]}]}}
            ' > "$settings_file"
        fi
        return 0
    fi

    # If python is available, use it
    if command -v python3 &> /dev/null; then
        python3 - "$settings_file" "$hook_cmd" << 'PYEOF'
import json, sys, os, re
settings_file, hook_cmd = sys.argv[1], sys.argv[2]
if os.path.exists(settings_file):
    with open(settings_file, 'r') as f:
        config = json.load(f)
else:
    config = {}
if 'hooks' not in config:
    config['hooks'] = {}
existing = config['hooks'].get('UserPromptSubmit', [])
filtered = [e for e in existing if not any(
    re.search(r'lucid|user-prompt-submit', h.get('command', ''))
    for h in e.get('hooks', [])
)]
filtered.append({'hooks': [{'type': 'command', 'command': hook_cmd}]})
config['hooks']['UserPromptSubmit'] = filtered
with open(settings_file, 'w') as f:
    json.dump(config, f, indent=2)
PYEOF
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

if [ "$INSTALL_CLAUDE" = true ]; then
    if configure_hook "$CLAUDE_SETTINGS" "$HOOK_COMMAND"; then
        success "Claude hook configured in settings.json"
    else
        warn "Claude hook configuration requires manual setup"
    fi
fi

# === Add to PATH ===

SHELL_CONFIG=""
if [ -f "$HOME/.zshrc" ]; then
    SHELL_CONFIG="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_CONFIG="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_CONFIG="$HOME/.bash_profile"
elif [ -f "$HOME/.profile" ]; then
    SHELL_CONFIG="$HOME/.profile"
fi

if [ -n "$SHELL_CONFIG" ]; then
    if ! grep -q "/.lucid/bin" "$SHELL_CONFIG" 2>/dev/null; then
        echo '' >> "$SHELL_CONFIG"
        echo '# Lucid Memory' >> "$SHELL_CONFIG"
        echo 'export PATH="$HOME/.lucid/bin:$PATH"' >> "$SHELL_CONFIG"
        success "Added to PATH ($SHELL_CONFIG)"
    fi
fi

# Also add to Fish shell config if Fish is installed
FISH_CONFIG="$HOME/.config/fish/config.fish"
if [ -d "$HOME/.config/fish" ] || command -v fish &> /dev/null; then
    mkdir -p "$HOME/.config/fish"
    if ! grep -q "/.lucid/bin" "$FISH_CONFIG" 2>/dev/null; then
        echo '' >> "$FISH_CONFIG"
        echo '# Lucid Memory' >> "$FISH_CONFIG"
        echo 'set -gx PATH $HOME/.lucid/bin $PATH' >> "$FISH_CONFIG"
        success "Added to Fish PATH"
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

if [ "$INSTALL_CLAUDE" = true ] && [ ! -f "$MCP_CONFIG" ]; then
    INSTALL_ERRORS="${INSTALL_ERRORS}\n  - Claude MCP config not created"
fi

if [ "$INSTALL_OPENCODE" = true ]; then
    OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
    if [ -f "$OPENCODE_CONFIG" ] && ! grep -q "lucid-memory" "$OPENCODE_CONFIG" 2>/dev/null; then
        INSTALL_ERRORS="${INSTALL_ERRORS}\n  - OpenCode MCP config missing lucid-memory entry"
    fi
    if [ ! -f "$HOME/.config/opencode/plugins/lucid-memory.ts" ]; then
        INSTALL_ERRORS="${INSTALL_ERRORS}\n  - OpenCode plugin not installed"
    fi
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

if [ "$INSTALL_CLAUDE" = true ]; then
    restart_claude_code
fi
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
echo -e "  Just use your AI coding assistant normally -"
echo -e "  your memories build automatically over time."
echo ""
echo -e "  ${DIM}Troubleshooting:${NC}"
echo -e "  ${C4}lucid status${NC}  - Check if everything is working"
echo -e "  ${C4}lucid stats${NC}   - View memory statistics"
echo ""
echo -e "  ${DIM}To uninstall:${NC}"
echo -e "  ${C4}curl -fsSL https://lucidmemory.dev/uninstall | bash${NC}"
echo ""
echo -e "${DIM}  ─────────────────────────────────────────${NC}"
echo ""
echo -e "  ${YELLOW}Note:${NC} Please restart your terminal to use the 'lucid' command."
echo ""
