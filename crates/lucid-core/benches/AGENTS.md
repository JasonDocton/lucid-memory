<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-core/benches

## Purpose
Criterion benchmarks measuring performance of the activation and retrieval pipelines under synthetic load.

## Key Files
| File | Description |
|------|-------------|
| `activation.rs` | Benchmarks for base-level activation computation at varying memory counts |
| `retrieval.rs` | Benchmarks for full retrieval pipeline: similarity, spreading, ranking |

## For AI Agents

### Working In This Directory
- Run with `cargo bench -p lucid-core`.
- Uses `criterion` with `rand` for reproducible synthetic data generation.
- Benchmark names match the function or module they measure — keep them aligned when refactoring.

<!-- MANUAL -->
