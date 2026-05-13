<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-server/plugins

## Purpose
Third-party client adapter plugins. Each plugin adapts Lucid Memory MCP tools for a specific AI client that requires a custom integration format beyond the standard MCP stdio transport.

## Key Files
| File | Description |
|------|-------------|
| `opencode-lucid-memory.ts` | OpenCode plugin — exposes lucid-memory tools in OpenCode's plugin format |

## For AI Agents

### Working In This Directory
- Plugins re-export lucid-server tool logic in client-specific formats.
- When adding a new client integration, add a plugin file here rather than modifying `server.ts`.
- Plugin files must use named exports only.

<!-- MANUAL -->
