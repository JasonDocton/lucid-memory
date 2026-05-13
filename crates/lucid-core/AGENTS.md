<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-core

## Purpose
High-performance memory retrieval engine implementing ACT-R spreading activation and MINERVA 2 reconstructive memory model. Pure Rust library with no I/O or database dependencies — all computation, no side effects. Consumed by `lucid-napi` for TypeScript exposure.

## Key Files
| File | Description |
|------|-------------|
| `Cargo.toml` | Crate manifest; `embedding` feature flag for ONNX Runtime support |
| `src/lib.rs` | Public API declarations and algorithm documentation |
| `src/activation.rs` | Base-level activation: recency/frequency decay B(m) = ln[Σ(t_k)^(-d)] |
| `src/embedding.rs` | Local ONNX-based embedding computation (requires `embedding` feature) |
| `src/location.rs` | Spatial and temporal location metadata for memories |
| `src/retrieval.rs` | Full retrieval pipeline: similarity → activation → spreading → rank |
| `src/spreading.rs` | Association graph traversal: A_j = Σ(W_i/n_i) × S_ij |
| `src/visual.rs` | Visual memory: image embedding retrieval support |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | All Rust source (see `src/AGENTS.md`) |
| `benches/` | Criterion benchmarks for activation and retrieval (see `benches/AGENTS.md`) |
| `examples/` | Runnable examples demonstrating retrieval and spreading activation (see `examples/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Pure computation — no filesystem access, no network, no database, no async.
- The `embedding` feature is optional; default build has no ONNX dependency.
- Retrieval pipeline order: cosine similarity → nonlinear activation A(i) = S(i)³ → base-level → spreading → combine → filter → rank.
- All public types implement `serde::{Serialize, Deserialize}`.

### Testing Requirements
- `cargo test -p lucid-core` — unit tests
- `cargo bench -p lucid-core` — criterion benchmarks (activation, retrieval)
- `cargo clippy -p lucid-core --all-targets --all-features` — must pass clean

### Common Patterns
- `smallvec` used for association lists to avoid heap allocation on small graphs.
- Benchmarks use `criterion` with `rand` for reproducible synthetic data.

## Dependencies

### Internal
- Consumed by `crates/lucid-napi`

### External
- `serde`, `smallvec`, `thiserror`
- Optional: `ort` (ONNX Runtime), `tokenizers`, `ndarray`, `dirs`, `parking_lot`
- Dev: `criterion`, `rand`

<!-- MANUAL -->
