<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# crates

## Purpose
Rust workspace members providing the high-performance computation layer. Two independent subsystems: the memory retrieval engine (`lucid-core` + `lucid-napi`) and the visual perception pipeline (`lucid-perception` + `lucid-perception-napi`). Each subsystem ships a pure Rust crate and an N-API binding crate that exposes it to TypeScript.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `lucid-core/` | ACT-R spreading activation + MINERVA 2 retrieval engine (see `lucid-core/AGENTS.md`) |
| `lucid-napi/` | N-API bindings exposing lucid-core to Node.js/Bun (see `lucid-napi/AGENTS.md`) |
| `lucid-perception/` | Video frame extraction, scene detection, audio transcription (see `lucid-perception/AGENTS.md`) |
| `lucid-perception-napi/` | N-API bindings exposing lucid-perception to Node.js/Bun (see `lucid-perception-napi/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- All crates are members of the Cargo workspace at the repo root. Never add a separate `[workspace]` block inside a crate.
- Shared dependencies are declared in root `Cargo.toml` under `[workspace.dependencies]`; crates reference them with `{ workspace = true }`.
- Lint rules (`[lints]`) are workspace-level; do not override per-crate without strong justification.

### Testing Requirements
- `cargo test` from repo root runs all crate tests.
- `cargo bench -p lucid-core` runs lucid-core criterion benchmarks.
- `cargo clippy --all-targets --all-features` must pass clean.

### Common Patterns
- Pure computation logic lives in the non-napi crate (`lucid-core`, `lucid-perception`).
- N-API crates contain only binding glue — no business logic.
- Optional heavy features (`embedding`, `transcription`, `cuda`) are feature-flagged; default build stays minimal.

## Dependencies

### External
- `napi` + `napi-derive` (N-API binding framework)
- `faer`, `nalgebra` (linear algebra), `rayon` (parallelism)
- `serde` + `rkyv` + `bincode` (serialization)
- `ort` + `tokenizers` (ONNX Runtime embedding, feature-gated)

<!-- MANUAL -->
