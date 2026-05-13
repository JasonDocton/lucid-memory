<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-server/src

## Purpose
TypeScript source for the Lucid Memory MCP server. Implements memory storage, retrieval, embedding, consolidation, episodic memory, gist extraction, video memory, and location tracking — all exposed as MCP tools.

## Key Files
| File | Description |
|------|-------------|
| `server.ts` | MCP server entrypoint — all tools registered here, stdio transport, multi-client config |
| `index.ts` | Public library re-exports (programmatic API surface) |
| `storage.ts` | `LucidStorage` — SQLite schema, migrations, and all DB operations |
| `retrieval.ts` | `LucidRetrieval` — orchestrates Rust native retrieval with TS fallback |
| `embeddings.ts` | `EmbeddingClient` — auto-detects provider, computes and normalizes embeddings |
| `config.ts` | Cognitive config types: `CognitiveConfig`, `ActivationConfig`, `ConsolidationConfig`, etc. |
| `consolidation.ts` | `ConsolidationEngine` — background loop: strengthen, decay, prune, manage visual lifecycle |
| `gist.ts` | Gist extraction: distills verbatim memory traces to compressed semantic essence |
| `episodic-memory.ts` | `EpisodicMemory` — episode boundary detection and temporal sequence reconstruction |
| `video.ts` | Video memory: frame extraction, visual storage, scene-based retrieval |
| `cli.ts` | `lucid` CLI — diagnostics, memory inspection, config management |

## Test Files
| File | Description |
|------|-------------|
| `storage.test.ts` | Storage CRUD, migrations, association graph |
| `consolidation.test.ts` | Consolidation engine: strengthen/decay/prune logic |
| `episodic-memory.test.ts` | Episode boundary detection and reconstruction |
| `embedding-migration.test.ts` | Embedding provider migration correctness |
| `gist.test.ts` | Gist extraction quality and idempotency |
| `temporal-retrieval.test.ts` | Temporal decay and recency scoring |
| `association-index.test.ts` | Association graph index operations |
| `location-rust-integration.test.ts` | Location tracking via Rust native module (requires binary) |

## For AI Agents

### Working In This Directory
- `LucidStorage` is the single DB access object — all modules receive it as a constructor arg.
- MCP tool registration lives entirely in `server.ts`; do not scatter it across files.
- `EmbeddingClient` is shared — instantiate once in `server.ts` and inject into dependents.
- Consolidation runs async in background — never await it on the MCP request hot path.
- Named exports only, no default exports.
- All embedding vectors are L2-normalized before storage; use `normalize()` from `embeddings.ts`.

### Common Patterns
- New MCP tool: add zod schema → handler function → `server.tool(name, schema, handler)` in `server.ts`.
- Storage schema changes require a versioned migration in `storage.ts`.

<!-- MANUAL -->
