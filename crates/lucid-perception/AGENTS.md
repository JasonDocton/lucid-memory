<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-perception

## Purpose
Video processing pipeline for Lucid Memory: frame extraction via FFmpeg, scene change detection via perceptual hashing, and optional audio transcription via Whisper. Handles compute-intensive perception tasks in Rust while TypeScript manages I/O. Consumed by `lucid-perception-napi`.

## Key Files
| File | Description |
|------|-------------|
| `Cargo.toml` | Crate manifest; `transcription` and `cuda` feature flags |
| `src/lib.rs` | Public API — `extract_frames`, `detect_scenes`, transcription entrypoints |
| `src/pipeline.rs` | Parallel task coordinator using rayon — runs frame extraction and scene detection concurrently |
| `src/scene.rs` | Scene change detection using perceptual hashing (pHash) |
| `src/transcribe.rs` | Whisper-based audio transcription (feature-gated: `transcription`) |
| `src/video.rs` | `VideoConfig` and FFmpeg CLI invocation for frame extraction |
| `src/error.rs` | `PerceptionError` and `Result<T>` type alias |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | All Rust source (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Requires `ffmpeg` CLI available in PATH at runtime for frame extraction.
- `transcription` feature adds Whisper model loading; gated to avoid mandatory large model downloads.
- `cuda` feature requires CUDA toolkit — only used with `transcription`.
- Default build has no external model dependencies.

### Testing Requirements
- `cargo test -p lucid-perception` — unit tests
- Transcription tests require `--features transcription` and a Whisper model present.

## Dependencies

### Internal
- Consumed by `crates/lucid-perception-napi`

### External
- FFmpeg CLI (runtime dependency — spawned as child process)
- `rayon` (parallelism), `thiserror` (error types)
- Optional: Whisper model, CUDA toolkit

<!-- MANUAL -->
