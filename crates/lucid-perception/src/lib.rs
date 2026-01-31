//! # Lucid Perception
//!
//! Video processing for lucid-memory: frame extraction, scene detection,
//! and audio transcription.
//!
//! ## Architecture
//!
//! This crate handles compute-intensive perception tasks in Rust while
//! the TypeScript layer handles I/O operations. This follows the pattern
//! established in lucid-core.
//!
//! ## Features
//!
//! - **Frame Extraction**: Extract frames from videos using `FFmpeg` CLI
//! - **Scene Detection**: Detect scene changes using perceptual hashing
//! - **Transcription**: Transcribe audio using Whisper (optional)
//! - **Pipeline**: Parallel processing of video analysis tasks
//!
//! ## Example
//!
//! ```no_run
//! use lucid_perception::{video::VideoConfig, extract_frames};
//! use std::path::Path;
//!
//! # async fn example() -> lucid_perception::error::Result<()> {
//! let config = VideoConfig::default();
//! let frames = extract_frames(Path::new("video.mp4"), &config).await?;
//! println!("Extracted {} frames", frames.len());
//! # Ok(())
//! # }
//! ```
//!
//! ## Optional Features
//!
//! - `transcription`: Enable Whisper-based audio transcription
//! - `cuda`: Enable CUDA acceleration for Whisper (requires `transcription`)

#![warn(missing_docs)]
#![warn(clippy::all)]
#![allow(clippy::needless_return)]

pub mod error;
pub mod scene;
pub mod video;

#[cfg(feature = "transcription")]
pub mod transcribe;

pub mod pipeline;

// Re-exports for convenience
pub use error::{PerceptionError, Result};
pub use scene::{
	compute_phash, detect_scene_changes, hamming_distance, FrameCandidate, SceneConfig,
};
pub use video::{
	check_ffmpeg, check_ffprobe, extract_frame_at, extract_frames, get_video_metadata,
	ExtractedFrame, ImageFormat, VideoConfig, VideoMetadata,
};

#[cfg(feature = "transcription")]
pub use transcribe::{
	transcribe_video, TranscriptSegment, TranscriptionConfig, TranscriptionResult,
};

pub use pipeline::{process_video, process_video_sync, PipelineConfig, VideoProcessingOutput};

/// Library version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
