<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# scripts

## Purpose
Build, install validation, and release automation scripts used in CI and locally.

## Key Files
| File | Description |
|------|-------------|
| `lint-installers.sh` | Validates `install.sh` and `install.ps1` for shell linting issues |
| `test-install.sh` | End-to-end install script smoke test — runs the installer and verifies the server starts |
| `test-mcp.sh` | MCP server smoke test — starts the server and verifies tool responses via stdio |

## For AI Agents

### Working In This Directory
- `test-mcp.sh` requires a running lucid-server; exercises the MCP tool interface end-to-end.
- Run these in CI via `.github/workflows/ci.yml` — check that workflow before modifying script interfaces.
- Script changes should be validated locally before merging (`bash -n script.sh` for syntax check).

<!-- MANUAL -->
