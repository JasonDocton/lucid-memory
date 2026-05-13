<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-napi/src

## Purpose
N-API binding glue connecting lucid-core Rust functions to the JavaScript/TypeScript interface. Converts Rust types to napi-rs JS-compatible types and delegates all computation to lucid-core.

## Key Files
| File | Description |
|------|-------------|
| `lib.rs` | All N-API exports; wraps lucid-core retrieval, activation, and spreading functions |

## For AI Agents

### Working In This Directory
- Keep this file thin: type conversion and delegation only. No logic.
- Use `#[napi]` and `#[napi(object)]` macros from napi-derive for exports.
- Convert `lucid_core` errors to `napi::Error` with descriptive messages.

<!-- MANUAL -->
