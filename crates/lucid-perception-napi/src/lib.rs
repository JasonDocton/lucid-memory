//! Node.js bindings for lucid-perception video processing.
//!
//! Provides frame extraction, scene detection, and transcription via napi-rs.

// napi-rs requires owned types at the FFI boundary
#![allow(clippy::needless_pass_by_value)]
// napi-rs macro generates trailing_empty_array in FFI types - this is unavoidable
#![allow(clippy::trailing_empty_array)]

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use lucid_perception::{
	pipeline::{PipelineConfig, VideoProcessingOutput},
	scene::{FrameCandidate, SceneConfig},
	transcribe::{TranscriptionConfig, TranscriptionResult},
	video::{ExtractedFrame, ImageFormat, VideoConfig, VideoMetadata},
	PerceptionError,
};

// ============================================================================
// JS Types
// ============================================================================

/// Video metadata.
#[napi(object)]
pub struct JsVideoMetadata {
	/// Duration in seconds
	pub duration_seconds: f64,
	/// Frame rate
	pub frame_rate: f64,
	/// Total frames
	pub frame_count: i64,
	/// Width in pixels
	pub width: u32,
	/// Height in pixels
	pub height: u32,
	/// Codec name
	pub codec: String,
	/// Has audio
	pub has_audio: bool,
}

/// An extracted frame.
#[napi(object)]
pub struct JsExtractedFrame {
	/// Path to frame image
	pub path: String,
	/// Timestamp in seconds
	pub timestamp_seconds: f64,
	/// Frame number
	pub frame_number: u32,
	/// Is keyframe
	pub is_keyframe: bool,
}

/// Frame with scene detection info.
#[napi(object)]
pub struct JsFrameCandidate {
	/// Path to frame
	pub path: String,
	/// Timestamp
	pub timestamp_seconds: f64,
	/// Frame number
	pub frame_number: u32,
	/// Is keyframe
	pub is_keyframe: bool,
	/// Hash as hex string
	pub hash_hex: String,
	/// Is scene change
	pub is_scene_change: bool,
	/// Is duplicate
	pub is_duplicate: bool,
	/// Distance from previous
	pub distance_from_previous: u32,
}

/// Transcript segment.
#[napi(object)]
pub struct JsTranscriptSegment {
	/// Start time (ms)
	pub start_ms: i64,
	/// End time (ms)
	pub end_ms: i64,
	/// Text
	pub text: String,
	/// Confidence (optional)
	pub confidence: Option<f64>,
}

/// Transcription result.
#[napi(object)]
pub struct JsTranscriptionResult {
	/// Full text
	pub text: String,
	/// Segments
	pub segments: Vec<JsTranscriptSegment>,
	/// Detected language
	pub detected_language: Option<String>,
	/// Duration in seconds
	pub duration_seconds: f64,
}

/// Processing statistics.
#[napi(object)]
pub struct JsProcessingStats {
	/// Frames extracted
	pub frames_extracted: u32,
	/// Scene changes detected
	pub scene_changes: u32,
	/// Duplicates found
	pub duplicates: u32,
	/// Extraction time (ms)
	pub extraction_time_ms: i64,
	/// Scene detection time (ms)
	pub scene_detection_time_ms: i64,
	/// Transcription time (ms)
	pub transcription_time_ms: i64,
}

/// Video processing output.
#[napi(object)]
pub struct JsVideoProcessingOutput {
	/// Metadata
	pub metadata: JsVideoMetadata,
	/// Frames with scene info
	pub frames: Vec<JsFrameCandidate>,
	/// Transcript (if available)
	pub transcript: Option<JsTranscriptionResult>,
	/// No audio in video
	pub no_audio: bool,
	/// Stats
	pub stats: JsProcessingStats,
}

/// Video extraction config.
#[napi(object)]
#[derive(Clone)]
pub struct JsVideoConfig {
	/// Output directory
	pub output_dir: Option<String>,
	/// Max frames (0 = all)
	pub max_frames: Option<u32>,
	/// Interval between frames (seconds)
	pub interval_seconds: Option<f64>,
	/// Quality (1-31, lower is better)
	pub quality: Option<u32>,
	/// Output format: "jpeg" or "png"
	pub format: Option<String>,
	/// Extract keyframes only
	pub keyframes_only: Option<bool>,
}

/// Scene detection config.
#[napi(object)]
#[derive(Clone)]
pub struct JsSceneConfig {
	/// Hash size (8 or 16)
	pub hash_size: Option<u32>,
	/// Scene change threshold
	pub scene_threshold: Option<u32>,
	/// Duplicate threshold
	pub duplicate_threshold: Option<u32>,
}

/// Transcription config.
#[napi(object)]
#[derive(Clone)]
pub struct JsTranscriptionConfig {
	/// Model path
	pub model_path: Option<String>,
	/// Language code
	pub language: Option<String>,
	/// Thread count (0 = auto)
	pub threads: Option<u32>,
	/// Translate to English
	pub translate: Option<bool>,
}

/// Pipeline config.
#[napi(object)]
#[derive(Clone)]
pub struct JsPipelineConfig {
	/// Video config
	pub video: Option<JsVideoConfig>,
	/// Scene config
	pub scene: Option<JsSceneConfig>,
	/// Transcription config
	pub transcription: Option<JsTranscriptionConfig>,
	/// Enable scene detection
	pub enable_scene_detection: Option<bool>,
	/// Skip transcription
	pub skip_transcription: Option<bool>,
}

// ============================================================================
// Functions
// ============================================================================

/// Check if `FFmpeg` is available.
///
/// # Errors
///
/// Returns `Ok(false)` if `FFmpeg` is not found; does not error.
#[napi]
pub async fn video_check_ffmpeg() -> Result<bool> {
	match lucid_perception::check_ffmpeg().await {
		Ok(()) => Ok(true),
		Err(_) => Ok(false),
	}
}

/// Get video metadata.
///
/// # Errors
///
/// Returns an error if the video cannot be read or `FFmpeg` fails.
#[napi]
pub async fn video_get_metadata(video_path: String) -> Result<JsVideoMetadata> {
	let metadata = lucid_perception::get_video_metadata(&video_path)
		.await
		.map_err(perception_error_to_napi)?;

	Ok(metadata_to_js(metadata))
}

/// Extract frames from a video.
///
/// # Errors
///
/// Returns an error if frame extraction fails.
#[napi]
pub async fn video_extract_frames(
	video_path: String,
	config: Option<JsVideoConfig>,
) -> Result<Vec<JsExtractedFrame>> {
	let config = js_video_config_to_core(config);

	let frames = lucid_perception::extract_frames(&video_path, &config)
		.await
		.map_err(perception_error_to_napi)?;

	Ok(frames.into_iter().map(extracted_frame_to_js).collect())
}

/// Transcribe audio from a video.
///
/// # Errors
///
/// Returns an error if transcription fails or the model is unavailable.
#[napi]
pub async fn video_transcribe(
	video_path: String,
	config: Option<JsTranscriptionConfig>,
) -> Result<JsTranscriptionResult> {
	let config = js_transcription_config_to_core(config);

	let result = lucid_perception::transcribe_video(&video_path, &config)
		.await
		.map_err(perception_error_to_napi)?;

	Ok(transcription_to_js(result))
}

/// Full video processing pipeline.
///
/// # Errors
///
/// Returns an error if any pipeline stage fails.
#[napi]
pub async fn video_process(
	video_path: String,
	config: Option<JsPipelineConfig>,
) -> Result<JsVideoProcessingOutput> {
	let config = js_pipeline_config_to_core(config);

	let output = lucid_perception::process_video(&video_path, &config)
		.await
		.map_err(perception_error_to_napi)?;

	Ok(processing_output_to_js(output))
}

/// Check if Whisper model is available.
#[napi]
pub fn video_is_model_available(model_path: Option<String>) -> bool {
	let config = model_path.map_or_else(TranscriptionConfig::default, |path| TranscriptionConfig {
		model_path: PathBuf::from(path),
		..Default::default()
	});

	lucid_perception::transcribe::is_model_available(&config)
}

/// Get the download URL for the default Whisper model.
#[napi]
pub fn video_get_model_url() -> String {
	lucid_perception::transcribe::get_model_download_url().to_string()
}

/// Get the default model path.
#[napi]
pub fn video_get_default_model_path() -> String {
	TranscriptionConfig::default()
		.model_path
		.display()
		.to_string()
}

// ============================================================================
// Type Conversions
// ============================================================================

fn perception_error_to_napi(e: PerceptionError) -> Error {
	Error::new(Status::GenericFailure, e.to_string())
}

fn metadata_to_js(m: VideoMetadata) -> JsVideoMetadata {
	JsVideoMetadata {
		duration_seconds: m.duration_seconds,
		frame_rate: m.frame_rate,
		frame_count: i64::try_from(m.frame_count).unwrap_or(i64::MAX),
		width: m.width,
		height: m.height,
		codec: m.codec,
		has_audio: m.has_audio,
	}
}

fn extracted_frame_to_js(f: ExtractedFrame) -> JsExtractedFrame {
	JsExtractedFrame {
		path: f.path.display().to_string(),
		timestamp_seconds: f.timestamp_seconds,
		frame_number: f.frame_number,
		is_keyframe: f.is_keyframe,
	}
}

fn frame_candidate_to_js(f: FrameCandidate) -> JsFrameCandidate {
	JsFrameCandidate {
		path: f.frame.path.display().to_string(),
		timestamp_seconds: f.frame.timestamp_seconds,
		frame_number: f.frame.frame_number,
		is_keyframe: f.frame.is_keyframe,
		hash_hex: f.hash.hex,
		is_scene_change: f.is_scene_change,
		is_duplicate: f.is_duplicate,
		distance_from_previous: f.distance_from_previous,
	}
}

fn transcription_to_js(t: TranscriptionResult) -> JsTranscriptionResult {
	JsTranscriptionResult {
		text: t.text,
		segments: t
			.segments
			.into_iter()
			.map(|s| JsTranscriptSegment {
				start_ms: s.start_ms,
				end_ms: s.end_ms,
				text: s.text,
				confidence: s.confidence.map(f64::from),
			})
			.collect(),
		detected_language: t.detected_language,
		duration_seconds: t.duration_seconds,
	}
}

fn processing_output_to_js(o: VideoProcessingOutput) -> JsVideoProcessingOutput {
	JsVideoProcessingOutput {
		metadata: metadata_to_js(o.metadata),
		frames: o.frames.into_iter().map(frame_candidate_to_js).collect(),
		transcript: o.transcript.map(transcription_to_js),
		no_audio: o.no_audio,
		stats: JsProcessingStats {
			frames_extracted: u32::try_from(o.stats.frames_extracted).unwrap_or(u32::MAX),
			scene_changes: u32::try_from(o.stats.scene_changes).unwrap_or(u32::MAX),
			duplicates: u32::try_from(o.stats.duplicates).unwrap_or(u32::MAX),
			extraction_time_ms: i64::try_from(o.stats.extraction_time_ms).unwrap_or(i64::MAX),
			scene_detection_time_ms: i64::try_from(o.stats.scene_detection_time_ms)
				.unwrap_or(i64::MAX),
			transcription_time_ms: i64::try_from(o.stats.transcription_time_ms).unwrap_or(i64::MAX),
		},
	}
}

fn js_video_config_to_core(js: Option<JsVideoConfig>) -> VideoConfig {
	js.map_or_else(VideoConfig::default, |js| {
		let default = VideoConfig::default();
		VideoConfig {
			output_dir: js
				.output_dir
				.map(PathBuf::from)
				.unwrap_or(default.output_dir),
			max_frames: js.max_frames.map_or(default.max_frames, |m| m as usize),
			interval_seconds: js.interval_seconds.unwrap_or(default.interval_seconds),
			quality: js.quality.unwrap_or(default.quality),
			format: js.format.as_deref().map_or(default.format, |s| match s {
				"png" => ImageFormat::Png,
				_ => ImageFormat::Jpeg,
			}),
			keyframes_only: js.keyframes_only.unwrap_or(default.keyframes_only),
		}
	})
}

fn js_scene_config_to_core(js: Option<JsSceneConfig>) -> SceneConfig {
	js.map_or_else(SceneConfig::default, |js| {
		let default = SceneConfig::default();
		SceneConfig {
			hash_size: js.hash_size.unwrap_or(default.hash_size),
			scene_threshold: js.scene_threshold.unwrap_or(default.scene_threshold),
			duplicate_threshold: js
				.duplicate_threshold
				.unwrap_or(default.duplicate_threshold),
		}
	})
}

fn js_transcription_config_to_core(js: Option<JsTranscriptionConfig>) -> TranscriptionConfig {
	js.map_or_else(TranscriptionConfig::default, |js| {
		let default = TranscriptionConfig::default();
		TranscriptionConfig {
			model_path: js
				.model_path
				.map(PathBuf::from)
				.unwrap_or(default.model_path),
			language: js.language.unwrap_or(default.language),
			threads: js.threads.unwrap_or(default.threads),
			translate: js.translate.unwrap_or(default.translate),
			max_segment_length: default.max_segment_length,
		}
	})
}

fn js_pipeline_config_to_core(js: Option<JsPipelineConfig>) -> PipelineConfig {
	js.map_or_else(PipelineConfig::default, |js| {
		let default = PipelineConfig::default();
		PipelineConfig {
			video: js_video_config_to_core(js.video),
			scene: js_scene_config_to_core(js.scene),
			transcription: js
				.transcription
				.map(|t| js_transcription_config_to_core(Some(t))),
			enable_scene_detection: js
				.enable_scene_detection
				.unwrap_or(default.enable_scene_detection),
			skip_transcription: js.skip_transcription.unwrap_or(default.skip_transcription),
		}
	})
}
