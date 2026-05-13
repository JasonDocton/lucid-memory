<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-server

## Purpose
MCP server providing persistent AI memory via the Model Context Protocol. Exposes memory tools (store, query, context, forget, consolidation, episodic, location, video) over stdio transport. Entry point for Claude Code, OpenCode, and Codex integrations. Data stored in `~/.lucid/`.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Package manifest; bin entries `lucid-server` and `lucid` |
| `src/server.ts` | MCP server entrypoint — registers all tools, starts stdio transport |
| `src/index.ts` | Public library re-exports (programmatic API surface) |
| `src/storage.ts` | SQLite storage layer: memories, associations, episodes, consolidation state |
| `src/retrieval.ts` | `LucidRetrieval` — orchestrates Rust native retrieval with TS fallback |
| `src/embeddings.ts` | `EmbeddingClient` — auto-detects provider (local ONNX / OpenAI-compatible endpoint) |
| `src/config.ts` | Cognitive parameter config: activation, encoding, working memory, consolidation |
| `src/consolidation.ts` | `ConsolidationEngine` — background loop: strengthen recent, decay stale, prune weak |
| `src/gist.ts` | Gist extraction: distills verbatim memory traces to compressed semantic essence |
| `src/episodic-memory.ts` | `EpisodicMemory` — temporal episode boundary detection and sequence reconstruction |
| `src/video.ts` | Video memory: frame extraction, visual storage, scene-based retrieval |
| `src/cli.ts` | `lucid` CLI for diagnostics, memory inspection, config management |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | All TypeScript source and tests (see `src/AGENTS.md`) |
| `bin/` | Platform wrapper scripts that launch the MCP server process (see `bin/AGENTS.md`) |
| `hooks/` | Claude Code and Codex hook scripts fired on AI lifecycle events (see `hooks/AGENTS.md`) |
| `plugins/` | Third-party client adapter plugins (e.g. OpenCode) (see `plugins/AGENTS.md`) |
| `scripts/` | Package-level install and setup scripts (see `scripts/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- All MCP tools are registered in `src/server.ts`. Adding a tool: zod schema → handler → `server.tool(name, schema, handler)`.
- Database at `~/.lucid/` — shared by default; `LUCID_CLIENT` env selects per-client or profile mode.
- Embedding provider auto-detected: local ONNX model → OpenAI-compatible endpoint → fallback.
- Named exports only; `src/index.ts` is the public library surface.
- Storage changes require a migration in `storage.ts` — version schema incrementally.

### Testing Requirements
- `bun test` runs all `*.test.ts` files.
- Integration test `location-rust-integration.test.ts` requires native binary present.
- All 5 completion gates apply — see root `CLAUDE.md`.

### Common Patterns
- `LucidStorage` is the single DB access point — all modules receive it as a constructor argument.
- `LucidRetrieval` wraps the Rust native module for the hot retrieval path.
- Consolidation runs async in background — never await it on the MCP request hot path.
- All embedding vectors are L2-normalized before storage; use `normalize()` from `embeddings.ts`.

## Dependencies

### Internal
- `@lucid-memory/native` (lucid-core N-API bindings)
- `@lucid-memory/perception` (lucid-perception N-API bindings)

### External
- `@modelcontextprotocol/sdk` (MCP server + stdio transport)
- `zod` (tool schema validation)
- SQLite via Bun's built-in `bun:sqlite`

<!-- MANUAL -->
