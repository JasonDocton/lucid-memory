//! Audio transcription using Whisper.
//!
//! This module provides speech-to-text transcription using whisper.cpp via
//! the whisper-rs bindings. It supports:
//!
//! - Audio extraction from video files
//! - Multiple Whisper model sizes
//! - Timestamped transcript segments
//!
//! ## Model Setup
//!
//! Whisper models are downloaded during installation to `~/.lucid/models/`.
//! The default model is `ggml-base.en.bin` (English-only, ~74MB).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::{debug, instrument, warn};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::error::{PerceptionError, Result};

// ============================================================================
// Configuration
// ============================================================================

/// Configuration for transcription.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionConfig {
	/// Path to Whisper model file
	pub model_path: PathBuf,

	/// Language code (e.g., "en", "auto" for detection)
	pub language: String,

	/// Number of threads to use (0 = auto)
	pub threads: u32,

	/// Whether to translate to English
	pub translate: bool,

	/// Maximum segment length in characters
	pub max_segment_length: usize,
}

impl Default for TranscriptionConfig {
	fn default() -> Self {
		Self {
			model_path: default_model_path(),
			language: "en".to_string(),
			threads: 0,
			translate: false,
			max_segment_length: 0,
		}
	}
}

/// Get the default Whisper model path.
fn default_model_path() -> PathBuf {
	dirs::home_dir()
		.unwrap_or_else(|| PathBuf::from("."))
		.join(".lucid")
		.join("models")
		.join("ggml-base.en.bin")
}

/// Get the URL to download the default model.
#[must_use]
pub const fn get_model_download_url() -> &'static str {
	"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
}

/// Check if the Whisper model is available.
#[must_use]
pub fn is_model_available(config: &TranscriptionConfig) -> bool {
	config.model_path.exists()
}

// ============================================================================
// Transcript Types
// ============================================================================

/// A segment of transcribed audio.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
	/// Start time in milliseconds
	pub start_ms: i64,

	/// End time in milliseconds
	pub end_ms: i64,

	/// Transcribed text
	pub text: String,

	/// Confidence score (0-1) if available
	pub confidence: Option<f32>,
}

impl TranscriptSegment {
	/// Get start time in seconds.
	#[must_use]
	#[allow(clippy::cast_precision_loss)]
	pub fn start_seconds(&self) -> f64 {
		self.start_ms as f64 / 1000.0
	}

	/// Get end time in seconds.
	#[must_use]
	#[allow(clippy::cast_precision_loss)]
	pub fn end_seconds(&self) -> f64 {
		self.end_ms as f64 / 1000.0
	}

	/// Get duration in seconds.
	#[must_use]
	#[allow(clippy::cast_precision_loss)]
	pub fn duration_seconds(&self) -> f64 {
		(self.end_ms - self.start_ms) as f64 / 1000.0
	}
}

/// Result of a transcription.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResult {
	/// Full transcribed text
	pub text: String,

	/// Individual segments with timestamps
	pub segments: Vec<TranscriptSegment>,

	/// Detected language (if auto-detection was used)
	pub detected_language: Option<String>,

	/// Duration of the audio in seconds
	pub duration_seconds: f64,
}

impl TranscriptionResult {
	/// Check if transcription produced any text.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.text.trim().is_empty()
	}

	/// Get text within a time range.
	#[must_use]
	pub fn text_in_range(&self, start_ms: i64, end_ms: i64) -> String {
		self.segments
			.iter()
			.filter(|s| s.start_ms >= start_ms && s.end_ms <= end_ms)
			.map(|s| s.text.as_str())
			.collect::<Vec<_>>()
			.join(" ")
	}
}

// ============================================================================
// Audio Extraction
// ============================================================================

/// Extract audio from a video file to WAV format for Whisper.
#[instrument(skip_all, fields(video = %video_path.as_ref().display()))]
async fn extract_audio(video_path: impl AsRef<Path>, output_path: impl AsRef<Path>) -> Result<()> {
	let video_path = video_path.as_ref();
	let output_path = output_path.as_ref();

	// Ensure output directory exists
	if let Some(parent) = output_path.parent() {
		tokio::fs::create_dir_all(parent).await?;
	}

	// Extract audio as 16kHz mono WAV (required by Whisper)
	let output = Command::new("ffmpeg")
		.args([
			"-y", // Overwrite output
			"-i",
		])
		.arg(video_path)
		.args([
			"-vn", // No video
			"-acodec",
			"pcm_s16le", // 16-bit PCM
			"-ar",
			"16000", // 16kHz sample rate
			"-ac",
			"1", // Mono
		])
		.arg(output_path)
		.stdout(Stdio::null())
		.stderr(Stdio::piped())
		.output()
		.await
		.map_err(|_| PerceptionError::FfmpegNotFound)?;

	if !output.status.success() {
		let stderr = String::from_utf8_lossy(&output.stderr);

		// Check for "no audio" error
		if stderr.contains("does not contain any stream")
			|| stderr.contains("Output file is empty")
			|| stderr.contains("no audio")
		{
			return Err(PerceptionError::NoAudioStream(video_path.to_path_buf()));
		}

		return Err(PerceptionError::FfmpegError {
			message: stderr.to_string(),
			exit_code: output.status.code(),
		});
	}

	// Verify output file exists and has content
	let metadata = tokio::fs::metadata(output_path).await?;
	if metadata.len() == 0 {
		return Err(PerceptionError::NoAudioStream(video_path.to_path_buf()));
	}

	Ok(())
}

// ============================================================================
// Transcription
// ============================================================================

/// Transcribe audio from a video file.
///
/// # Errors
///
/// Returns an error if the Whisper model is not found, audio extraction fails,
/// or transcription fails.
#[instrument(skip_all, fields(video = %video_path.as_ref().display()))]
pub async fn transcribe_video(
	video_path: impl AsRef<Path>,
	config: &TranscriptionConfig,
) -> Result<TranscriptionResult> {
	let video_path = video_path.as_ref();

	// Check if model exists
	if !config.model_path.exists() {
		return Err(PerceptionError::WhisperModelNotFound(
			config.model_path.clone(),
		));
	}

	// Create temp file for audio
	let temp_dir = std::env::temp_dir().join("lucid-transcribe");
	tokio::fs::create_dir_all(&temp_dir).await?;

	let audio_path = temp_dir.join(format!("{}.wav", uuid::Uuid::new_v4()));

	// Extract audio
	debug!("Extracting audio from video");
	extract_audio(video_path, &audio_path).await?;

	// Clone paths for the closure and cleanup
	let audio_path_for_cleanup = audio_path.clone();

	// Run transcription in blocking task (Whisper is CPU-bound)
	let config = config.clone();
	let result = tokio::task::spawn_blocking(move || transcribe_audio_sync(&audio_path, &config))
		.await
		.map_err(|e| PerceptionError::TranscriptionFailed(e.to_string()))??;

	// Clean up temp file
	let _ = tokio::fs::remove_file(&audio_path_for_cleanup).await;

	Ok(result)
}

/// Synchronous transcription (for use in blocking context).
fn transcribe_audio_sync(
	audio_path: &Path,
	config: &TranscriptionConfig,
) -> Result<TranscriptionResult> {
	// Load Whisper model
	let ctx = WhisperContext::new_with_params(
		config.model_path.to_str().ok_or_else(|| {
			PerceptionError::TranscriptionFailed("Invalid model path".to_string())
		})?,
		WhisperContextParameters::default(),
	)
	.map_err(|e| PerceptionError::TranscriptionFailed(format!("Failed to load model: {e}")))?;

	// Read audio file
	let audio_data = std::fs::read(audio_path)?;

	// Parse WAV header and get samples
	let samples = parse_wav_samples(&audio_data).map_err(PerceptionError::TranscriptionFailed)?;

	// Create state
	let mut state = ctx.create_state().map_err(|e| {
		PerceptionError::TranscriptionFailed(format!("Failed to create state: {e}"))
	})?;

	// Configure transcription parameters
	let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

	// Set language
	if config.language != "auto" {
		params.set_language(Some(&config.language));
	}

	// Set thread count
	if config.threads > 0 {
		#[allow(clippy::cast_possible_wrap)]
		params.set_n_threads(config.threads as i32);
	}

	// Enable translation if requested
	params.set_translate(config.translate);

	// Disable printing to avoid cluttering output
	params.set_print_progress(false);
	params.set_print_realtime(false);
	params.set_print_timestamps(false);

	// Run transcription
	let _ = state
		.full(params, &samples)
		.map_err(|e| PerceptionError::TranscriptionFailed(format!("Transcription failed: {e}")))?;

	// Extract segments
	let num_segments = state.full_n_segments().map_err(|e| {
		PerceptionError::TranscriptionFailed(format!("Failed to get segment count: {e}"))
	})?;

	#[allow(clippy::cast_sign_loss)]
	let mut segments = Vec::with_capacity(num_segments as usize);
	let mut full_text = String::new();

	for i in 0..num_segments {
		let start_ms = state.full_get_segment_t0(i).map_err(|e| {
			PerceptionError::TranscriptionFailed(format!("Failed to get segment start: {e}"))
		})? * 10; // whisper uses 10ms units

		let end_ms = state.full_get_segment_t1(i).map_err(|e| {
			PerceptionError::TranscriptionFailed(format!("Failed to get segment end: {e}"))
		})? * 10;

		let text = state.full_get_segment_text(i).map_err(|e| {
			PerceptionError::TranscriptionFailed(format!("Failed to get segment text: {e}"))
		})?;

		let text = text.trim().to_string();

		if !text.is_empty() {
			if !full_text.is_empty() {
				full_text.push(' ');
			}
			full_text.push_str(&text);

			segments.push(TranscriptSegment {
				start_ms,
				end_ms,
				text,
				confidence: None,
			});
		}
	}

	#[allow(clippy::cast_precision_loss)]
	let duration_seconds = samples.len() as f64 / 16000.0;

	Ok(TranscriptionResult {
		text: full_text,
		segments,
		detected_language: None,
		duration_seconds,
	})
}

/// Parse WAV file and extract f32 samples.
fn parse_wav_samples(data: &[u8]) -> std::result::Result<Vec<f32>, String> {
	// Simple WAV parser - expects 16-bit PCM, 16kHz, mono
	if data.len() < 44 {
		return Err("WAV file too short".to_string());
	}

	// Check RIFF header
	if &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
		return Err("Not a valid WAV file".to_string());
	}

	// Find data chunk
	let mut pos = 12;
	while pos + 8 < data.len() {
		let chunk_id = &data[pos..pos + 4];
		#[allow(clippy::cast_possible_truncation)]
		let chunk_size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]])
			as usize;

		if chunk_id == b"data" {
			let samples_start = pos + 8;
			let samples_end = (samples_start + chunk_size).min(data.len());
			let samples_data = &data[samples_start..samples_end];

			// Convert i16 to f32
			let samples: Vec<f32> = samples_data
				.chunks_exact(2)
				.map(|chunk| {
					let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
					f32::from(sample) / 32768.0
				})
				.collect();

			return Ok(samples);
		}

		pos += 8 + chunk_size;
		// Align to 2-byte boundary
		if chunk_size % 2 != 0 {
			pos += 1;
		}
	}

	Err("No data chunk found in WAV file".to_string())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_transcript_segment_times() {
		let segment = TranscriptSegment {
			start_ms: 1500,
			end_ms: 3000,
			text: "Hello".to_string(),
			confidence: Some(0.95),
		};

		assert!((segment.start_seconds() - 1.5).abs() < f64::EPSILON);
		assert!((segment.end_seconds() - 3.0).abs() < f64::EPSILON);
		assert!((segment.duration_seconds() - 1.5).abs() < f64::EPSILON);
	}

	#[test]
	fn test_transcription_result_text_in_range() {
		let result = TranscriptionResult {
			text: "Hello world".to_string(),
			segments: vec![
				TranscriptSegment {
					start_ms: 0,
					end_ms: 1000,
					text: "Hello".to_string(),
					confidence: None,
				},
				TranscriptSegment {
					start_ms: 1000,
					end_ms: 2000,
					text: "world".to_string(),
					confidence: None,
				},
			],
			detected_language: None,
			duration_seconds: 2.0,
		};

		assert_eq!(result.text_in_range(0, 1000), "Hello");
		assert_eq!(result.text_in_range(0, 2000), "Hello world");
	}

	#[test]
	fn test_config_default() {
		let config = TranscriptionConfig::default();
		assert_eq!(config.language, "en");
		assert_eq!(config.threads, 0);
		assert!(!config.translate);
	}

	#[test]
	fn test_model_download_url() {
		let url = get_model_download_url();
		assert!(url.contains("huggingface.co"));
		assert!(url.contains("ggml-base.en.bin"));
	}
}
