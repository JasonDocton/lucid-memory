<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-perception-napi/src

## Purpose
N-API binding glue exposing lucid-perception frame extraction, scene detection, and transcription functions to JavaScript/TypeScript.

## Key Files
| File | Description |
|------|-------------|
| `lib.rs` | All N-API exports; wraps lucid-perception pipeline with async bridging for frame extraction |

## For AI Agents

### Working In This Directory
- Keep thin — type conversion and async bridging only, no perception logic.
- Frame extraction is async — bridge to napi async task pattern.

<!-- MANUAL -->
