//! Error types for perception operations.

use std::path::PathBuf;

/// Errors that can occur during perception operations.
#[derive(Debug, thiserror::Error)]
pub enum PerceptionError {
	/// `FFmpeg` is not installed or not found in PATH.
	#[error("FFmpeg not found. Please install FFmpeg: https://ffmpeg.org/download.html")]
	FfmpegNotFound,

	/// `FFprobe` is not installed or not found in PATH.
	#[error("FFprobe not found. Please install FFmpeg: https://ffmpeg.org/download.html")]
	FfprobeNotFound,

	/// Video file not found.
	#[error("Video file not found: {0}")]
	VideoNotFound(PathBuf),

	/// Invalid video file (corrupt or unsupported format).
	#[error("Invalid or unsupported video format: {0}")]
	InvalidVideo(PathBuf),

	/// `FFmpeg` command failed.
	#[error("FFmpeg failed: {message}")]
	FfmpegError {
		/// Error message from `FFmpeg`
		message: String,
		/// Exit code if available
		exit_code: Option<i32>,
	},

	/// Failed to extract frame at timestamp.
	#[error("Failed to extract frame at {timestamp}s: {reason}")]
	FrameExtractionFailed {
		/// Timestamp in seconds
		timestamp: f64,
		/// Reason for failure
		reason: String,
	},

	/// Video has no video streams.
	#[error("Video has no video streams: {0}")]
	NoVideoStream(PathBuf),

	/// Video has no audio streams (for transcription).
	#[error("Video has no audio stream: {0}")]
	NoAudioStream(PathBuf),

	/// Failed to read image file.
	#[error("Failed to read image: {0}")]
	ImageReadError(#[from] image::ImageError),

	/// I/O error.
	#[error("I/O error: {0}")]
	IoError(#[from] std::io::Error),

	/// JSON parsing error.
	#[error("Failed to parse FFprobe output: {0}")]
	JsonParseError(String),

	/// Whisper model not found.
	#[cfg(feature = "transcription")]
	#[error("Whisper model not found at: {0}. Run the install script to download it.")]
	WhisperModelNotFound(PathBuf),

	/// Whisper transcription failed.
	#[cfg(feature = "transcription")]
	#[error("Transcription failed: {0}")]
	TranscriptionFailed(String),

	/// Task was cancelled.
	#[error("Operation was cancelled")]
	Cancelled,

	/// Timeout while processing.
	#[error("Operation timed out after {seconds}s")]
	Timeout {
		/// Timeout duration in seconds
		seconds: u64,
	},
}

impl PerceptionError {
	/// Check if this error indicates no audio stream (not a fatal error for some operations).
	#[must_use]
	pub const fn is_no_audio(&self) -> bool {
		matches!(self, Self::NoAudioStream(_))
	}

	/// Check if this error is due to a missing dependency (`FFmpeg`, Whisper model).
	#[must_use]
	pub const fn is_missing_dependency(&self) -> bool {
		matches!(self, Self::FfmpegNotFound | Self::FfprobeNotFound) || {
			#[cfg(feature = "transcription")]
			{
				matches!(self, Self::WhisperModelNotFound(_))
			}
			#[cfg(not(feature = "transcription"))]
			{
				false
			}
		}
	}

	/// Check if the error is recoverable (e.g., try again later).
	#[must_use]
	pub const fn is_recoverable(&self) -> bool {
		matches!(self, Self::Timeout { .. } | Self::Cancelled)
	}
}

/// Result type alias for perception operations.
pub type Result<T> = std::result::Result<T, PerceptionError>;
