#!/bin/bash
if [ "${1:-}" = update ]; then
    entry="$HOME/.lucid/server/src/upgrade.ts"
    if [ ! -f "$entry" ]; then
        entry="$HOME/.lucid/.upgrade-work/old/server/src/upgrade.ts"
    fi
    exec bun run --cwd "$HOME/.lucid" --no-env-file --no-install "$entry"
fi
exec bun run "$HOME/.lucid/server/src/cli.ts" "$@"
