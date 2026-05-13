<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# packages

## Purpose
TypeScript/Bun workspace packages. The MCP server (`lucid-server`) is the user-facing entry point; it depends on pre-built native binaries distributed as separate packages (`lucid-native`, `lucid-perception`) to avoid requiring users to compile Rust.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `lucid-server/` | MCP server: storage, retrieval, embeddings, consolidation, episodic memory (see `lucid-server/AGENTS.md`) |
| `lucid-native/` | Pre-built `.node` binaries for lucid-core N-API, one per platform (see `lucid-native/AGENTS.md`) |
| `lucid-perception/` | Pre-built `.node` binaries for lucid-perception N-API, one per platform (see `lucid-perception/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- All packages are Bun workspace members (declared in root `package.json` `workspaces`).
- Run tests with `bun --filter '*' test` or per-package with `bun test` inside the package directory.
- Named exports only — no default exports.
- `lucid-native` and `lucid-perception` are distribution packages — `.node` files are built by CI and committed; do not rebuild locally unless explicitly required.
- `lucid-server` depends on `lucid-native` and `lucid-perception` via `file:` workspace references.

<!-- MANUAL -->
