<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-core/src

## Purpose
Core retrieval engine implementation. Implements ACT-R spreading activation and MINERVA 2 reconstructive memory as pure Rust computation with no I/O.

## Key Files
| File | Description |
|------|-------------|
| `lib.rs` | Module declarations and algorithm documentation |
| `activation.rs` | Base-level activation: recency + frequency decay B(m) = ln[Σ(t_k)^(-d)] |
| `embedding.rs` | Local ONNX-based embedding computation (requires `embedding` feature) |
| `location.rs` | Spatial and temporal location metadata attached to memories |
| `retrieval.rs` | Full retrieval pipeline: similarity → activation → spreading → rank |
| `spreading.rs` | Association graph traversal and spreading activation: A_j = Σ(W_i/n_i) × S_ij |
| `visual.rs` | Visual memory: image embedding retrieval support |

## For AI Agents

### Working In This Directory
- No I/O, no database access, no async — pure deterministic computation.
- Retrieval order: cosine similarity → nonlinear activation A(i) = S(i)³ → base-level → spreading → combine → filter by probability threshold → rank.
- The `embedding` feature gates ONNX Runtime — never assume it is always compiled in.
- `smallvec` used for association lists to avoid heap allocation on small graphs.

<!-- MANUAL -->
