#!/bin/bash
# Compatibility entry point for existing Lucid Codex notification registrations.
server="$HOME/.lucid/server"
exec bun run --cwd "$server" --no-env-file --no-install "$server/src/codex-notify.ts" "$@"
