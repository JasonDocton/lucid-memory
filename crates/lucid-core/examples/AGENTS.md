<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-core/examples

## Purpose
Runnable examples demonstrating lucid-core API usage. Serve as integration smoke tests and onboarding material for the retrieval and spreading activation APIs.

## Key Files
| File | Description |
|------|-------------|
| `basic_retrieval.rs` | Demonstrates store + retrieve with cosine similarity ranking |
| `spreading_activation.rs` | Demonstrates association graph construction and spreading activation |

## For AI Agents

### Working In This Directory
- Run with `cargo run --example basic_retrieval -p lucid-core`.
- Examples must compile and produce sensible output — treat as lightweight integration tests.
- Keep examples minimal and self-contained; no external dependencies beyond lucid-core.

<!-- MANUAL -->
