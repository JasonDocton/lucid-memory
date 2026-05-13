<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-perception/src

## Purpose
Video perception pipeline implementation: FFmpeg-based frame extraction, perceptual hashing for scene detection, and optional Whisper audio transcription.

## Key Files
| File | Description |
|------|-------------|
| `lib.rs` | Public API: `extract_frames`, `detect_scenes`, transcription entrypoints |
| `pipeline.rs` | Parallel task coordinator — runs frame extraction and scene detection concurrently via rayon |
| `scene.rs` | Perceptual hashing (pHash) for scene change detection |
| `transcribe.rs` | Whisper integration for audio transcription (feature-gated: `transcription`) |
| `video.rs` | `VideoConfig` and FFmpeg CLI invocation for frame extraction |
| `error.rs` | `PerceptionError` and `Result<T>` type alias |

## For AI Agents

### Working In This Directory
- FFmpeg is spawned as a child process — verify PATH availability in test environments.
- `transcription` feature adds Whisper model loading; keep it gated to avoid large mandatory downloads.
- `pipeline.rs` uses rayon for parallelism — frame extraction and scene detection run concurrently.

<!-- MANUAL -->
