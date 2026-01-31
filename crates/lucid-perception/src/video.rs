//! Video frame extraction using `FFmpeg` CLI.
//!
//! This module provides frame extraction from videos using `FFmpeg` as an external process.
//! `FFmpeg` is preferred over linked libraries for:
//! - Simplicity and reliability
//! - No complex build dependencies
//! - Consistent behavior across platforms
//! - Support for all video formats `FFmpeg` supports

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::{debug, instrument, warn};

use crate::error::{PerceptionError, Result};

// ============================================================================
// Configuration
// ============================================================================

/// Configuration for video frame extraction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoConfig {
	/// Output directory for extracted frames
	pub output_dir: PathBuf,

	/// Maximum frames to extract (0 = all)
	pub max_frames: usize,

	/// Time interval between frames in seconds (0 = use scene detection)
	pub interval_seconds: f64,

	/// Output image quality (1-31, lower is better, 2 is recommended)
	pub quality: u32,

	/// Output image format
	pub format: ImageFormat,

	/// Whether to extract keyframes only (faster, less frames)
	pub keyframes_only: bool,
}

impl Default for VideoConfig {
	fn default() -> Self {
		Self {
			output_dir: std::env::temp_dir().join("lucid-frames"),
			max_frames: 100,
			interval_seconds: 1.0,
			quality: 2,
			format: ImageFormat::Jpeg,
			keyframes_only: false,
		}
	}
}

/// Output image format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ImageFormat {
	/// JPEG format (smaller files, lossy)
	#[default]
	Jpeg,
	/// PNG format (larger files, lossless)
	Png,
}

impl ImageFormat {
	/// Get the file extension for this format.
	#[must_use]
	pub const fn extension(&self) -> &'static str {
		match self {
			Self::Jpeg => "jpg",
			Self::Png => "png",
		}
	}

	/// Get the `FFmpeg` codec name for this format.
	#[must_use]
	pub const fn codec(&self) -> &'static str {
		match self {
			Self::Jpeg => "mjpeg",
			Self::Png => "png",
		}
	}
}

// ============================================================================
// Video Metadata
// ============================================================================

/// Metadata about a video file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMetadata {
	/// Duration in seconds
	pub duration_seconds: f64,

	/// Frame rate (frames per second)
	pub frame_rate: f64,

	/// Total number of frames (estimated)
	pub frame_count: u64,

	/// Video width in pixels
	pub width: u32,

	/// Video height in pixels
	pub height: u32,

	/// Video codec name
	pub codec: String,

	/// Whether the video has audio
	pub has_audio: bool,
}

/// Raw `FFprobe` stream data.
#[derive(Debug, Deserialize)]
struct FfprobeStream {
	codec_type: String,
	#[serde(default)]
	duration: Option<String>,
	#[serde(default)]
	r_frame_rate: Option<String>,
	#[serde(default)]
	nb_frames: Option<String>,
	#[serde(default)]
	width: Option<u32>,
	#[serde(default)]
	height: Option<u32>,
	#[serde(default)]
	codec_name: Option<String>,
}

/// Raw `FFprobe` format data.
#[derive(Debug, Deserialize)]
struct FfprobeFormat {
	#[serde(default)]
	duration: Option<String>,
}

/// Raw `FFprobe` output.
#[derive(Debug, Deserialize)]
struct FfprobeOutput {
	streams: Vec<FfprobeStream>,
	#[serde(default)]
	format: Option<FfprobeFormat>,
}

// ============================================================================
// Extracted Frame
// ============================================================================

/// An extracted video frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedFrame {
	/// Path to the frame image file
	pub path: PathBuf,

	/// Timestamp in seconds
	pub timestamp_seconds: f64,

	/// Frame number (0-indexed)
	pub frame_number: u32,

	/// Whether this is a keyframe
	pub is_keyframe: bool,
}

// ============================================================================
// FFmpeg Detection
// ============================================================================

/// Check if `FFmpeg` is available in PATH.
///
/// # Errors
///
/// Returns `FfmpegNotFound` if `FFmpeg` is not installed or not in PATH.
#[instrument]
pub async fn check_ffmpeg() -> Result<()> {
	let output = Command::new("ffmpeg")
		.arg("-version")
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.status()
		.await;

	match output {
		Ok(status) if status.success() => Ok(()),
		_ => Err(PerceptionError::FfmpegNotFound),
	}
}

/// Check if `FFprobe` is available in PATH.
///
/// # Errors
///
/// Returns `FfprobeNotFound` if `FFprobe` is not installed or not in PATH.
#[instrument]
pub async fn check_ffprobe() -> Result<()> {
	let output = Command::new("ffprobe")
		.arg("-version")
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.status()
		.await;

	match output {
		Ok(status) if status.success() => Ok(()),
		_ => Err(PerceptionError::FfprobeNotFound),
	}
}

// ============================================================================
// Video Metadata Extraction
// ============================================================================

/// Get metadata about a video file.
///
/// # Errors
///
/// Returns an error if the video file is not found, invalid, or `FFprobe` fails.
#[instrument(skip_all, fields(video = %video_path.as_ref().display()))]
pub async fn get_video_metadata(video_path: impl AsRef<Path>) -> Result<VideoMetadata> {
	let video_path = video_path.as_ref();

	if !video_path.exists() {
		return Err(PerceptionError::VideoNotFound(video_path.to_path_buf()));
	}

	let output = Command::new("ffprobe")
		.args([
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=duration,r_frame_rate,nb_frames,width,height,codec_name,codec_type",
			"-show_entries",
			"format=duration",
			"-of",
			"json",
		])
		.arg(video_path)
		.output()
		.await
		.map_err(|_| PerceptionError::FfprobeNotFound)?;

	if !output.status.success() {
		return Err(PerceptionError::InvalidVideo(video_path.to_path_buf()));
	}

	let stdout = String::from_utf8_lossy(&output.stdout);
	let probe: FfprobeOutput = serde_json::from_str(&stdout)
		.map_err(|e: serde_json::Error| PerceptionError::JsonParseError(e.to_string()))?;

	// Find video stream
	let video_stream = probe
		.streams
		.iter()
		.find(|s| s.codec_type == "video")
		.ok_or_else(|| PerceptionError::NoVideoStream(video_path.to_path_buf()))?;

	// Check for audio
	let has_audio = probe.streams.iter().any(|s| s.codec_type == "audio");

	// Parse duration (try stream first, then format)
	let duration_seconds = video_stream
		.duration
		.as_ref()
		.and_then(|d: &String| d.parse::<f64>().ok())
		.or_else(|| {
			probe
				.format
				.as_ref()
				.and_then(|f| f.duration.as_ref())
				.and_then(|d: &String| d.parse::<f64>().ok())
		})
		.unwrap_or(0.0);

	// Parse frame rate (format: "num/den")
	let frame_rate = video_stream
		.r_frame_rate
		.as_ref()
		.and_then(|r: &String| {
			let parts: Vec<&str> = r.split('/').collect();
			if parts.len() == 2 {
				let num: f64 = parts[0].parse().ok()?;
				let den: f64 = parts[1].parse().ok()?;
				if den > 0.0 {
					Some(num / den)
				} else {
					None
				}
			} else {
				r.parse().ok()
			}
		})
		.unwrap_or(30.0);

	// Parse frame count
	#[allow(
		clippy::cast_possible_truncation,
		clippy::cast_sign_loss,
		clippy::unnecessary_lazy_evaluations
	)]
	let frame_count = video_stream
		.nb_frames
		.as_ref()
		.and_then(|n: &String| n.parse::<u64>().ok())
		.unwrap_or_else(|| (duration_seconds * frame_rate) as u64);

	Ok(VideoMetadata {
		duration_seconds,
		frame_rate,
		frame_count,
		width: video_stream.width.unwrap_or(0),
		height: video_stream.height.unwrap_or(0),
		codec: video_stream
			.codec_name
			.clone()
			.unwrap_or_else(|| "unknown".to_string()),
		has_audio,
	})
}

// ============================================================================
// Frame Extraction
// ============================================================================

/// Extract a single frame at a specific timestamp.
///
/// # Errors
///
/// Returns an error if the video is not found or frame extraction fails.
#[instrument(skip_all, fields(video = %video_path.as_ref().display(), timestamp = timestamp_seconds))]
pub async fn extract_frame_at(
	video_path: impl AsRef<Path>,
	timestamp_seconds: f64,
	output_path: impl AsRef<Path>,
	quality: u32,
) -> Result<ExtractedFrame> {
	let video_path = video_path.as_ref();
	let output_path = output_path.as_ref();

	if !video_path.exists() {
		return Err(PerceptionError::VideoNotFound(video_path.to_path_buf()));
	}

	// Ensure output directory exists
	if let Some(parent) = output_path.parent() {
		tokio::fs::create_dir_all(parent).await?;
	}

	let output = Command::new("ffmpeg")
		.args(["-ss", &format!("{timestamp_seconds:.3}"), "-i"])
		.arg(video_path)
		.args([
			"-vframes",
			"1",
			"-q:v",
			&quality.to_string(),
			"-y", // Overwrite output
		])
		.arg(output_path)
		.output()
		.await
		.map_err(|_| PerceptionError::FfmpegNotFound)?;

	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr);
		return Err(PerceptionError::FrameExtractionFailed {
			timestamp: timestamp_seconds,
			reason: stderr.to_string(),
		});
	}

	// Verify output file exists
	if !output_path.exists() {
		return Err(PerceptionError::FrameExtractionFailed {
			timestamp: timestamp_seconds,
			reason: "Output file was not created".to_string(),
		});
	}

	Ok(ExtractedFrame {
		path: output_path.to_path_buf(),
		timestamp_seconds,
		frame_number: 0,
		is_keyframe: false,
	})
}

/// Extract frames at regular intervals.
///
/// # Errors
///
/// Returns an error if the video is not found or frame extraction fails.
#[instrument(skip_all, fields(video = %video_path.as_ref().display()))]
pub async fn extract_frames(
	video_path: impl AsRef<Path>,
	config: &VideoConfig,
) -> Result<Vec<ExtractedFrame>> {
	let video_path = video_path.as_ref();

	if !video_path.exists() {
		return Err(PerceptionError::VideoNotFound(video_path.to_path_buf()));
	}

	// Get video metadata
	let metadata = get_video_metadata(video_path).await?;
	debug!(?metadata, "Got video metadata");

	// Ensure output directory exists
	tokio::fs::create_dir_all(&config.output_dir).await?;

	// Generate unique prefix for this extraction
	let prefix = uuid::Uuid::new_v4();

	#[allow(clippy::if_not_else)]
	let frames = if config.keyframes_only {
		// Extract keyframes only using select filter
		extract_keyframes_internal(video_path, config, &prefix, &metadata).await?
	} else {
		// Extract at regular intervals
		let interval = if config.interval_seconds > 0.0 {
			config.interval_seconds
		} else {
			1.0
		};

		let mut timestamp = 0.0;
		let mut frame_number = 0u32;
		let mut extracted = Vec::new();

		#[allow(clippy::while_float)]
		while timestamp < metadata.duration_seconds {
			if config.max_frames > 0 && extracted.len() >= config.max_frames {
				break;
			}

			let output_path = config.output_dir.join(format!(
				"{prefix}-{frame_number:05}.{}",
				config.format.extension()
			));

			match extract_frame_at(video_path, timestamp, &output_path, config.quality).await {
				Ok(mut frame) => {
					frame.frame_number = frame_number;
					extracted.push(frame);
				}
				Err(e) => {
					warn!(?e, timestamp, "Failed to extract frame, skipping");
				}
			}

			timestamp += interval;
			frame_number += 1;
		}
		extracted
	};

	debug!(count = frames.len(), "Extracted frames");
	Ok(frames)
}

/// Internal function to extract keyframes.
async fn extract_keyframes_internal(
	video_path: &Path,
	config: &VideoConfig,
	prefix: &uuid::Uuid,
	metadata: &VideoMetadata,
) -> Result<Vec<ExtractedFrame>> {
	// Use FFmpeg's select filter to extract keyframes
	let output_pattern = config.output_dir.join(format!(
		"{}-keyframe-%05d.{}",
		prefix,
		config.format.extension()
	));

	let mut args = vec![
		"-i".to_string(),
		video_path.display().to_string(),
		"-vf".to_string(),
		"select='eq(pict_type\\,I)'".to_string(),
		"-vsync".to_string(),
		"vfr".to_string(),
		"-q:v".to_string(),
		config.quality.to_string(),
	];

	// Limit frames if configured
	if config.max_frames > 0 {
		args.push("-frames:v".to_string());
		args.push(config.max_frames.to_string());
	}

	args.push("-y".to_string());
	args.push(output_pattern.display().to_string());

	let output = Command::new("ffmpeg")
		.args(&args)
		.output()
		.await
		.map_err(|_| PerceptionError::FfmpegNotFound)?;

	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr);
		return Err(PerceptionError::FfmpegError {
			message: stderr.to_string(),
			exit_code: output.status.code(),
		});
	}

	// Collect extracted frames
	let mut frames = Vec::new();
	let mut entries = tokio::fs::read_dir(&config.output_dir).await?;

	let prefix_str = format!("{prefix}-keyframe-");

	while let Some(entry) = entries.next_entry().await? {
		let name = entry.file_name();
		let name_str = name.to_string_lossy();

		if name_str.starts_with(&prefix_str) {
			// Parse frame number from filename
			if let Some(num_part) = name_str
				.strip_prefix(&prefix_str)
				.and_then(|s| s.split('.').next())
			{
				if let Ok(frame_number) = num_part.parse::<u32>() {
					// Estimate timestamp based on frame number
					// This is approximate since FFmpeg doesn't output timestamps directly
					#[allow(clippy::cast_precision_loss)]
					let timestamp = if metadata.frame_rate > 0.0 && metadata.duration_seconds > 0.0 {
						// Rough estimate: keyframes are roughly evenly distributed
						let keyframe_interval =
							metadata.duration_seconds / (frames.len() + 1) as f64;
						f64::from(frame_number) * keyframe_interval
					} else {
						0.0
					};

					frames.push(ExtractedFrame {
						path: entry.path(),
						timestamp_seconds: timestamp,
						frame_number,
						is_keyframe: true,
					});
				}
			}
		}
	}

	// Sort by frame number
	frames.sort_by_key(|f| f.frame_number);

	// Update timestamps based on actual count
	let count = frames.len();
	#[allow(clippy::cast_precision_loss)]
	if count > 0 && metadata.duration_seconds > 0.0 {
		let interval = metadata.duration_seconds / count as f64;
		for (i, frame) in frames.iter_mut().enumerate() {
			frame.timestamp_seconds = i as f64 * interval;
		}
	}

	Ok(frames)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn test_check_ffmpeg() {
		// This test will pass on systems with FFmpeg installed
		let result = check_ffmpeg().await;
		// We just check it doesn't panic; actual availability depends on the system
		println!("FFmpeg available: {}", result.is_ok());
	}

	#[test]
	fn test_image_format() {
		assert_eq!(ImageFormat::Jpeg.extension(), "jpg");
		assert_eq!(ImageFormat::Png.extension(), "png");
		assert_eq!(ImageFormat::Jpeg.codec(), "mjpeg");
		assert_eq!(ImageFormat::Png.codec(), "png");
	}

	#[test]
	fn test_video_config_default() {
		let config = VideoConfig::default();
		assert_eq!(config.max_frames, 100);
		assert!((config.interval_seconds - 1.0).abs() < f64::EPSILON);
		assert_eq!(config.quality, 2);
		assert_eq!(config.format, ImageFormat::Jpeg);
		assert!(!config.keyframes_only);
	}
}
