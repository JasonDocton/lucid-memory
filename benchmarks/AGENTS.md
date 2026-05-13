<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# benchmarks

## Purpose
Quality and performance benchmarks for the retrieval and memory systems. Measures recall, token efficiency, and retrieval quality against baselines (Claude-mem, Pinecone RAG, Traditional RAG).

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `quality/` | TypeScript benchmark scripts for recall, RAG comparison, token efficiency, and episodic retrieval (see `quality/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Run via root scripts: `bun run bench:quality`, `bun run bench:rag`, `bun run bench:realistic`, `bun run bench:tokens`.
- Rust benchmarks live in `crates/lucid-core/benches/`; run with `bun run bench:rust`.
- Benchmarks are standalone scripts — no test framework, no assertions. Output is for human review.

<!-- MANUAL -->
