<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-server/scripts

## Purpose
Package-level installation and setup scripts for lucid-server.

## Key Files
| File | Description |
|------|-------------|
| `install.sh` | Post-install script — configures lucid-server in Claude Code MCP settings at `~/.claude/` |

## For AI Agents

### Working In This Directory
- `install.sh` is invoked after package installation to register the MCP server with Claude Code.
- Modifies client config files under `~/.claude/` or equivalent — test carefully to avoid corrupting user config.

<!-- MANUAL -->
