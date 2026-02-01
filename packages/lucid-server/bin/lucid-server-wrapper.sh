#!/bin/bash
# Lucid Memory Server Wrapper
# Auto-restarts the MCP server if it crashes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_SCRIPT="$HOME/.lucid/server/src/server.ts"
LOG_FILE="$HOME/.lucid/logs/server.log"

# Verify Bun is available
if ! command -v bun &> /dev/null; then
    echo "ERROR: Bun is not installed or not in PATH" >&2
    echo "Please install Bun: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi

# Verify server script exists
if [ ! -f "$SERVER_SCRIPT" ]; then
    echo "ERROR: Server script not found at $SERVER_SCRIPT" >&2
    echo "Please reinstall Lucid Memory: curl -fsSL lucidmemory.dev/install | bash" >&2
    exit 1
fi
RESTART_DELAY=2
MAX_RAPID_RESTARTS=5
RAPID_RESTART_WINDOW=60  # seconds

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
    echo "$1"
}

restart_times=()

while true; do
    # Check for rapid restart loop (crash loop detection)
    now=$(date +%s)
    restart_times=("${restart_times[@]}" "$now")

    # Keep only restarts within the window
    filtered=()
    for t in "${restart_times[@]}"; do
        if [ $((now - t)) -lt $RAPID_RESTART_WINDOW ]; then
            filtered+=("$t")
        fi
    done
    restart_times=("${filtered[@]}")

    if [ ${#restart_times[@]} -ge $MAX_RAPID_RESTARTS ]; then
        log "ERROR: Server crashed $MAX_RAPID_RESTARTS times in ${RAPID_RESTART_WINDOW}s. Stopping."
        log "Check logs and run 'lucid status' for diagnostics."
        exit 1
    fi

    log "Starting Lucid Memory server..."
    bun run "$SERVER_SCRIPT" 2>&1 | tee -a "$LOG_FILE"
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        log "Server exited cleanly."
        exit 0
    fi

    log "Server crashed with exit code $EXIT_CODE. Restarting in ${RESTART_DELAY}s..."
    sleep $RESTART_DELAY
done
