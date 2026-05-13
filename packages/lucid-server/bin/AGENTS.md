<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-server/bin

## Purpose
Platform wrapper scripts that launch the lucid-server MCP process. Used by Claude Code and other clients to invoke the server with the correct environment.

## Key Files
| File | Description |
|------|-------------|
| `lucid-server-wrapper.sh` | Bash wrapper — sets env vars and execs `bun run src/server.ts` |
| `lucid-server-wrapper.ps1` | PowerShell equivalent for Windows |

## For AI Agents

### Working In This Directory
- Wrappers set `LUCID_CLIENT` and other env vars before delegating to the server.
- Changes here affect how Claude Code and Codex launch the server — validate with `scripts/test-mcp.sh`.

<!-- MANUAL -->
