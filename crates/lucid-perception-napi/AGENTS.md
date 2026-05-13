<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-perception-napi

## Purpose
N-API binding crate exposing `lucid-perception` to Node.js/Bun as a native `.node` module. Binding glue only — no perception logic. Output binaries distributed in `packages/lucid-perception`.

## Key Files
| File | Description |
|------|-------------|
| `Cargo.toml` | Crate manifest; depends on `lucid-perception` and `napi`/`napi-derive` |
| `src/lib.rs` | All N-API exports for the perception pipeline — frame extraction, scene detection, transcription |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | N-API binding source (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- All perception logic belongs in `lucid-perception`, not here.
- Built via napi-rs CLI; output `.node` files go to `packages/lucid-perception/`.
- Frame extraction is async — use `napi::bindgen_prelude::AsyncTask` or tokio bridging pattern.

### Testing Requirements
- Integration tested via `packages/lucid-server` TypeScript tests.

## Dependencies

### Internal
- `crates/lucid-perception`

### External
- `napi`, `napi-derive`, `napi-build`

<!-- MANUAL -->
