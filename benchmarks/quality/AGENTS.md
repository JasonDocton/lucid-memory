<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# benchmarks/quality

## Purpose
Quality benchmarks measuring retrieval recall, token efficiency, and memory system performance against baseline approaches (Claude-mem, Pinecone RAG, Traditional RAG).

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Main quality benchmark suite: recall@k, precision, F1 across retrieval strategies |
| `rag-comparison.ts` | Side-by-side comparison: lucid-memory vs Pinecone RAG vs Traditional RAG |
| `membrane-comparison.ts` | Comparison against membrane-style memory architectures |
| `realistic-dev.ts` | Simulates a realistic developer session with code questions and context switching |
| `episodic-e2e.ts` | End-to-end episodic memory benchmark: episode boundary detection accuracy |
| `token-efficiency.ts` | Token budget benchmarks: recall at fixed token counts (5x efficiency target) |

## For AI Agents

### Working In This Directory
- Run individual benchmarks: `bun run benchmarks/quality/<file>.ts`
- Run all via root scripts: `bun run bench:quality`, `bun run bench:rag`, `bun run bench:realistic`, `bun run bench:tokens`
- Benchmarks use real retrieval calls — require initialized storage at `~/.lucid/`.
- Output is human-readable tables for comparison review, not assertions.

<!-- MANUAL -->
