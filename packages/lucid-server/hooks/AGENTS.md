<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-server/hooks

## Purpose
Claude Code and Codex hook scripts injected into AI agent sessions. Scripts fire on AI lifecycle events (e.g. `UserPromptSubmit`) to trigger memory retrieval and inject context into the agent's context window.

## Key Files
| File | Description |
|------|-------------|
| `user-prompt-submit.sh` | Bash hook — fires on `UserPromptSubmit`; calls `memory_context` MCP tool and injects result |
| `user-prompt-submit.ps1` | PowerShell equivalent for Windows |
| `codex-notify.sh` | Bash hook for OpenAI Codex — notifies lucid-server of prompt events |

## For AI Agents

### Working In This Directory
- Hooks must be fast — they block the AI agent session until they return.
- `user-prompt-submit.sh` injects retrieved memory context into the session via stdout.
- Do not add heavy computation here; all work should delegate to the MCP server.

<!-- MANUAL -->
