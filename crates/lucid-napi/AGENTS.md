<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-napi

## Purpose
N-API binding crate that exposes `lucid-core` to Node.js/Bun as a native `.node` module. Contains only binding glue — no business logic. Built with napi-rs; output binaries are distributed in `packages/lucid-native`.

## Key Files
| File | Description |
|------|-------------|
| `Cargo.toml` | Crate manifest; depends on `lucid-core` and `napi`/`napi-derive` |
| `src/lib.rs` | All N-API exports — wraps lucid-core retrieval, activation, and spreading functions |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | N-API binding source (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- All logic belongs in `lucid-core`, not here. This crate only converts types and marshals calls.
- Built via napi-rs CLI (`napi build --release`); output `.node` files go to `packages/lucid-native/`.
- Do not add business logic here — changes should be in `lucid-core` with bindings updated to match.
- Error handling: convert `lucid_core` errors to `napi::Error` with descriptive messages.

### Testing Requirements
- Integration tested via `packages/lucid-server` TypeScript tests which import the compiled `.node` binary.
- No standalone Rust tests — binding correctness is verified at the TS integration layer.

## Dependencies

### Internal
- `crates/lucid-core`

### External
- `napi`, `napi-derive`, `napi-build`

<!-- MANUAL -->
