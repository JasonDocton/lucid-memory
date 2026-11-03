#!/usr/bin/env bash
# Apply only the response-capture source changes to an unmodified v0.6.5 install.
set -euo pipefail
usage() { echo "Usage: bash scripts/upgrade-v065-capture.sh [--rollback]" >&2; exit 1; }
case "${1:-}" in
    '') ;;
    --rollback) ;;
    *) usage ;;
esac
[ "$#" -le 1 ] || usage

repo=$(cd "$(dirname "$0")/.." && pwd -P)
server="$HOME/.lucid/server"
[[ -f "$server/package.json" && -d "$server/src" && ! -L "$server" && ! -L "$server/src" ]] || {
    echo "Expected a standard installed Lucid server at $server." >&2; exit 1;
}
base=57a582b0580e01a73154fbf8cbae130102683ff2
# Pin this one-time migration to its introduction, even when main advances.
release=$(git -C "$repo" log -1 --diff-filter=A --format=%H HEAD -- scripts/upgrade-v065-capture.sh)
[[ -n "$release" ]] || { echo "Run this from a full checkout containing the response-capture update." >&2; exit 1; }
git -C "$repo" merge-base --is-ancestor "$base" "$release" || { echo "The checkout needs full v0.6.5 history." >&2; exit 1; }
[[ $(bun --cwd "$repo" --no-env-file -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$server/package.json") == 0.6.5 ]] || {
    echo "This migration is only for Lucid server 0.6.5." >&2; exit 1;
}
if git -C "$server" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "This installation is Git-managed. Update its checkout directly." >&2; exit 1
fi

files=(cli.ts server.ts storage.ts claude-stop.ts database-path.ts)
from="$base"; to="$release"
if [[ ${1:-} == --rollback ]]; then from="$release"; to="$base"; fi
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/before/src" "$stage/after/src"
matches() {
    if [[ -f "$1" && -f "$2" ]]; then cmp -s "$1" "$2"
    else [[ ! -e "$1" && ! -e "$2" ]]; fi
}
all_from=true; all_to=true
for name in "${files[@]}"; do
    path="packages/lucid-server/src/$name"
    before="$stage/before/src/$name"; after="$stage/after/src/$name"; installed="$server/src/$name"
    [[ ! -L "$installed" ]] || { echo "Refusing to replace symlink $installed." >&2; exit 1; }
    # cat-file -e distinguishes a file added by the update from the stock sources.
    if git -C "$repo" cat-file -e "$from:$path" 2>/dev/null; then git -C "$repo" show "$from:$path" > "$before"; fi
    if git -C "$repo" cat-file -e "$to:$path" 2>/dev/null; then git -C "$repo" show "$to:$path" > "$after"; fi
    # Git for Windows can check out TypeScript as CRLF. Preserve the installed convention.
    if [[ -f "$installed" ]] && LC_ALL=C grep -q $'\r$' "$installed"; then
        for snapshot in "$before" "$after"; do
            if [[ -f "$snapshot" ]]; then
                LC_ALL=C awk '{printf "%s\r\n", $0}' "$snapshot" > "$stage/crlf"
                mv "$stage/crlf" "$snapshot"
            fi
        done
    fi
    matches "$before" "$installed" || all_from=false
    matches "$after" "$installed" || all_to=false
done
if [[ "$all_to" == true ]]; then echo "The requested sources are already installed."; exit 0; fi
[[ "$all_from" == true ]] || { echo "Installed sources differ from the expected revision. No files changed." >&2; exit 1; }
# Generate one patch with the verified byte sequences. Git checks every hunk before applying.
cd "$stage"
rc=0
git -c core.autocrlf=false diff --no-index --no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/ before after > changes.patch || rc=$?
[[ $rc == 1 ]] || { echo "Could not prepare the source update." >&2; exit 1; }
git -C "$server" -c core.autocrlf=false apply -p2 --whitespace=nowarn --check "$stage/changes.patch"
git -C "$server" -c core.autocrlf=false apply -p2 --whitespace=nowarn "$stage/changes.patch"
echo "Lucid server sources updated. Start a new session to load them."
