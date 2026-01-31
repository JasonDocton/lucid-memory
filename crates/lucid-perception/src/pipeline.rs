//! Parallel video processing pipeline.
//!
//! This module coordinates frame extraction, scene detection, and transcription
//! to run in parallel where possible.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tracing::{debug, instrument};

use crate::error::{PerceptionError, Result};
use crate::scene::{detect_scene_changes, FrameCandidate, SceneConfig};
use crate::video::{
	extract_frames, get_video_metadata, ExtractedFrame, VideoConfig, VideoMetadata,
};

#[cfg(feature = "transcription")]
use crate::transcribe::{transcribe_video, TranscriptionConfig, TranscriptionResult};

// ============================================================================
// Configuration
// ============================================================================

/// Configuration for the full video processing pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineConfig {
	/// Video frame extraction config
	pub video: VideoConfig,

	/// Scene detection config
	pub scene: SceneConfig,

	/// Transcription config (optional, requires `transcription` feature)
	#[cfg(feature = "transcription")]
	pub transcription: Option<TranscriptionConfig>,

	/// Whether to run scene detection
	pub enable_scene_detection: bool,

	/// Whether to skip transcription even if configured
	#[cfg(feature = "transcription")]
	pub skip_transcription: bool,
}

impl Default for PipelineConfig {
	fn default() -> Self {
		Self {
			video: VideoConfig::default(),
			scene: SceneConfig::default(),
			#[cfg(feature = "transcription")]
			transcription: Some(TranscriptionConfig::default()),
			enable_scene_detection: true,
			#[cfg(feature = "transcription")]
			skip_transcription: false,
		}
	}
}

// ============================================================================
// Output
// ============================================================================

/// Output from the video processing pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoProcessingOutput {
	/// Video metadata
	pub metadata: VideoMetadata,

	/// Extracted frames with hashes and scene detection info
	pub frames: Vec<FrameCandidate>,

	/// Transcription result (if transcription was enabled and successful)
	#[cfg(feature = "transcription")]
	pub transcript: Option<TranscriptionResult>,

	/// Whether transcription was skipped due to no audio
	pub no_audio: bool,

	/// Processing statistics
	pub stats: ProcessingStats,
}

/// Statistics from processing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingStats {
	/// Total frames extracted
	pub frames_extracted: usize,

	/// Number of scene changes detected
	pub scene_changes: usize,

	/// Number of duplicate frames detected
	pub duplicates: usize,

	/// Time spent on frame extraction (ms)
	pub extraction_time_ms: u64,

	/// Time spent on scene detection (ms)
	pub scene_detection_time_ms: u64,

	/// Time spent on transcription (ms)
	pub transcription_time_ms: u64,
}

// ============================================================================
// Pipeline
// ============================================================================

/// Process a video file, extracting frames and optionally transcribing.
///
/// This runs frame extraction and transcription in parallel using `tokio::join!`.
///
/// # Errors
///
/// Returns an error if video metadata cannot be read, frame extraction fails,
/// or transcription fails (when enabled).
#[instrument(skip_all, fields(video = %video_path.as_ref().display()))]
pub async fn process_video(
	video_path: impl AsRef<Path>,
	config: &PipelineConfig,
) -> Result<VideoProcessingOutput> {
	let video_path = video_path.as_ref();

	// Get video metadata first
	let metadata = get_video_metadata(video_path).await?;
	debug!(?metadata, "Got video metadata");

	let mut stats = ProcessingStats {
		frames_extracted: 0,
		scene_changes: 0,
		duplicates: 0,
		extraction_time_ms: 0,
		scene_detection_time_ms: 0,
		transcription_time_ms: 0,
	};

	// Run frame extraction and transcription in parallel
	#[cfg(feature = "transcription")]
	let (frames_result, transcript_result) = {
		let video_path_clone = video_path.to_path_buf();

		let frames_task = async {
			let start = std::time::Instant::now();
			let result = extract_frames(video_path, &config.video).await;
			#[allow(clippy::cast_possible_truncation)]
			let elapsed = start.elapsed().as_millis() as u64;
			(result, elapsed)
		};

		let transcript_task = async {
			if config.skip_transcription {
				return (Ok(None), 0);
			}

			if let Some(ref t_config) = config.transcription {
				if !metadata.has_audio {
					return (Ok(None), 0);
				}

				let start = std::time::Instant::now();
				let result = transcribe_video(&video_path_clone, t_config).await;
				#[allow(clippy::cast_possible_truncation)]
				let elapsed = start.elapsed().as_millis() as u64;

				match result {
					Ok(t) => (Ok(Some(t)), elapsed),
					Err(e) if e.is_no_audio() => (Ok(None), elapsed),
					Err(e) => (Err(e), elapsed),
				}
			} else {
				(Ok(None), 0)
			}
		};

		tokio::join!(frames_task, transcript_task)
	};

	#[cfg(not(feature = "transcription"))]
	let frames_result = {
		let start = std::time::Instant::now();
		let result = extract_frames(video_path, &config.video).await;
		#[allow(clippy::cast_possible_truncation)]
		let elapsed = start.elapsed().as_millis() as u64;
		(result, elapsed)
	};

	// Process frame extraction result
	let (frames, extraction_time) = frames_result;
	stats.extraction_time_ms = extraction_time;
	let frames: Vec<ExtractedFrame> = frames?;
	stats.frames_extracted = frames.len();

	// Run scene detection
	let scene_start = std::time::Instant::now();
	let frame_candidates = if config.enable_scene_detection && !frames.is_empty() {
		detect_scene_changes(&frames, &config.scene)?
	} else {
		// Convert to FrameCandidates without scene detection
		frames
			.into_iter()
			.map(|f| FrameCandidate {
				frame: f,
				hash: crate::scene::PerceptualHash {
					bytes: vec![],
					hex: String::new(),
				},
				is_scene_change: true, // Treat all as scene changes if detection disabled
				is_duplicate: false,
				distance_from_previous: 0,
			})
			.collect()
	};
	#[allow(clippy::cast_possible_truncation)]
	{
		stats.scene_detection_time_ms = scene_start.elapsed().as_millis() as u64;
	}

	stats.scene_changes = frame_candidates
		.iter()
		.filter(|f| f.is_scene_change)
		.count();
	stats.duplicates = frame_candidates.iter().filter(|f| f.is_duplicate).count();

	// Process transcription result
	#[cfg(feature = "transcription")]
	let (transcript, no_audio) = {
		let (result, transcription_time) = transcript_result;
		stats.transcription_time_ms = transcription_time;
		match result {
			Ok(Some(t)) => (Some(t), false),
			Ok(None) => (None, !metadata.has_audio),
			Err(e) if e.is_no_audio() => (None, true),
			Err(e) => return Err(e),
		}
	};

	#[cfg(not(feature = "transcription"))]
	let no_audio = !metadata.has_audio;

	debug!(
		frames = stats.frames_extracted,
		scene_changes = stats.scene_changes,
		duplicates = stats.duplicates,
		"Processing complete"
	);

	Ok(VideoProcessingOutput {
		metadata,
		frames: frame_candidates,
		#[cfg(feature = "transcription")]
		transcript,
		no_audio,
		stats,
	})
}

/// Synchronous wrapper for `process_video` (blocks the current thread).
///
/// Use this when calling from a synchronous context. For async code,
/// prefer `process_video` directly.
///
/// # Errors
///
/// Returns an error if the tokio runtime cannot be created, or if video
/// processing fails.
pub fn process_video_sync(
	video_path: impl AsRef<Path>,
	config: &PipelineConfig,
) -> Result<VideoProcessingOutput> {
	let runtime = tokio::runtime::Runtime::new().map_err(|e| {
		PerceptionError::IoError(std::io::Error::other(format!(
			"Failed to create runtime: {e}"
		)))
	})?;

	runtime.block_on(process_video(video_path, config))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_pipeline_config_default() {
		let config = PipelineConfig::default();
		assert!(config.enable_scene_detection);
		assert_eq!(config.video.max_frames, 100);
	}

	#[test]
	fn test_processing_stats_default() {
		let stats = ProcessingStats {
			frames_extracted: 0,
			scene_changes: 0,
			duplicates: 0,
			extraction_time_ms: 0,
			scene_detection_time_ms: 0,
			transcription_time_ms: 0,
		};

		assert_eq!(stats.frames_extracted, 0);
	}
}
