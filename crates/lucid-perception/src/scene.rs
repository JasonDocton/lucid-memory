//! Scene detection using perceptual hashing.
//!
//! This module provides scene change detection by comparing perceptual hashes
//! of consecutive frames. Perceptual hashes are robust to minor changes in
//! encoding, scaling, and compression.
//!
//! ## Algorithm
//!
//! 1. Compute perceptual hash (pHash) for each frame
//! 2. Compare consecutive frames using Hamming distance
//! 3. Frames with distance above threshold indicate scene changes

use std::path::Path;

use image_hasher::{HashAlg, HasherConfig, ImageHash};
use serde::{Deserialize, Serialize};
use tracing::{debug, instrument};

use crate::error::{PerceptionError, Result};
use crate::video::ExtractedFrame;

// ============================================================================
// Configuration
// ============================================================================

/// Configuration for scene detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneConfig {
	/// Hash size (larger = more accurate but slower)
	/// Must be a power of 2, typically 8 or 16
	pub hash_size: u32,

	/// Hamming distance threshold for scene change detection
	/// Higher = fewer scene changes detected
	pub scene_threshold: u32,

	/// Minimum distance to consider frames as duplicates
	/// Lower = more aggressive duplicate detection
	pub duplicate_threshold: u32,
}

impl Default for SceneConfig {
	fn default() -> Self {
		Self {
			hash_size: 8,           // 64-bit hash (8x8)
			scene_threshold: 12,    // ~20% of bits different = scene change
			duplicate_threshold: 3, // <=5% different = duplicate
		}
	}
}

// ============================================================================
// Perceptual Hash
// ============================================================================

/// A 64-bit perceptual hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerceptualHash {
	/// The raw hash bytes
	pub bytes: Vec<u8>,

	/// Hash as hexadecimal string (for storage)
	pub hex: String,
}

impl PerceptualHash {
	/// Create from `image_hasher`'s `ImageHash`.
	fn from_image_hash(hash: &ImageHash) -> Self {
		let bytes = hash.as_bytes().to_vec();
		let hex = hash.to_base64();
		Self { bytes, hex }
	}

	/// Compute Hamming distance to another hash.
	#[must_use]
	pub fn distance(&self, other: &Self) -> u32 {
		hamming_distance(&self.bytes, &other.bytes)
	}
}

/// Compute the perceptual hash of an image.
///
/// # Errors
///
/// Returns an error if the image cannot be read or decoded.
#[instrument(skip_all, fields(path = %image_path.as_ref().display()))]
pub fn compute_phash(image_path: impl AsRef<Path>) -> Result<PerceptualHash> {
	let image_path = image_path.as_ref();

	let image = image::open(image_path)?;

	let hasher = HasherConfig::new()
		.hash_alg(HashAlg::DoubleGradient)
		.hash_size(8, 8)
		.to_hasher();

	let hash = hasher.hash_image(&image);

	Ok(PerceptualHash::from_image_hash(&hash))
}

/// Compute perceptual hash with custom size.
///
/// # Errors
///
/// Returns an error if the image cannot be read or decoded.
#[instrument(skip_all, fields(path = %image_path.as_ref().display(), size = hash_size))]
pub fn compute_phash_sized(image_path: impl AsRef<Path>, hash_size: u32) -> Result<PerceptualHash> {
	let image_path = image_path.as_ref();

	let image = image::open(image_path)?;

	let hasher = HasherConfig::new()
		.hash_alg(HashAlg::DoubleGradient)
		.hash_size(hash_size, hash_size)
		.to_hasher();

	let hash = hasher.hash_image(&image);

	Ok(PerceptualHash::from_image_hash(&hash))
}

// ============================================================================
// Hamming Distance
// ============================================================================

/// Compute Hamming distance between two byte arrays.
///
/// Returns the number of bits that differ between the two arrays.
/// If arrays have different lengths, compares up to the shorter length.
#[must_use]
pub fn hamming_distance(a: &[u8], b: &[u8]) -> u32 {
	a.iter()
		.zip(b.iter())
		.map(|(x, y)| (x ^ y).count_ones())
		.sum()
}

// ============================================================================
// Frame Candidate
// ============================================================================

/// A frame with its perceptual hash and scene detection metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameCandidate {
	/// Original extracted frame info
	pub frame: ExtractedFrame,

	/// Perceptual hash of the frame
	pub hash: PerceptualHash,

	/// Whether this frame marks a scene change
	pub is_scene_change: bool,

	/// Whether this frame is a duplicate of the previous
	pub is_duplicate: bool,

	/// Hamming distance from previous frame (0 for first frame)
	pub distance_from_previous: u32,
}

// ============================================================================
// Scene Detection
// ============================================================================

/// Detect scene changes in a sequence of frames.
///
/// Returns indices of frames where scene changes occur.
///
/// # Errors
///
/// Returns an error if any frame image cannot be read or hashed.
#[instrument(skip_all, fields(num_frames = frames.len()))]
pub fn detect_scene_changes(
	frames: &[ExtractedFrame],
	config: &SceneConfig,
) -> Result<Vec<FrameCandidate>> {
	if frames.is_empty() {
		return Ok(Vec::new());
	}

	let mut candidates = Vec::with_capacity(frames.len());
	let mut previous_hash: Option<PerceptualHash> = None;

	for frame in frames {
		let hash = compute_phash_sized(&frame.path, config.hash_size)?;

		let (is_scene_change, is_duplicate, distance) = previous_hash.as_ref().map_or(
			(true, false, 0), // First frame is always a scene boundary
			|prev| {
				let dist = hash.distance(prev);
				(
					dist >= config.scene_threshold,
					dist <= config.duplicate_threshold,
					dist,
				)
			},
		);

		debug!(
			frame = frame.frame_number,
			distance, is_scene_change, is_duplicate, "Processed frame"
		);

		candidates.push(FrameCandidate {
			frame: frame.clone(),
			hash: hash.clone(),
			is_scene_change,
			is_duplicate,
			distance_from_previous: distance,
		});

		previous_hash = Some(hash);
	}

	let scene_changes = candidates.iter().filter(|c| c.is_scene_change).count();
	let duplicates = candidates.iter().filter(|c| c.is_duplicate).count();
	debug!(scene_changes, duplicates, "Scene detection complete");

	Ok(candidates)
}

/// Get only the scene change frames (filtering out duplicates and intermediate frames).
#[must_use]
pub fn get_scene_frames(candidates: &[FrameCandidate]) -> Vec<&FrameCandidate> {
	candidates.iter().filter(|c| c.is_scene_change).collect()
}

/// Get only non-duplicate frames.
#[must_use]
pub fn get_unique_frames(candidates: &[FrameCandidate]) -> Vec<&FrameCandidate> {
	candidates.iter().filter(|c| !c.is_duplicate).collect()
}

/// Find the most representative frame from each scene.
///
/// For each scene (defined by scene change boundaries), returns the frame
/// that is most similar to all other frames in that scene (the "centroid").
#[must_use]
pub fn get_representative_frames(candidates: &[FrameCandidate]) -> Vec<&FrameCandidate> {
	if candidates.is_empty() {
		return Vec::new();
	}

	let mut representatives = Vec::new();
	let mut scene_start = 0;

	for (i, candidate) in candidates.iter().enumerate() {
		if candidate.is_scene_change && i > 0 {
			// End of previous scene, find representative
			if let Some(rep) = find_scene_representative(&candidates[scene_start..i]) {
				representatives.push(rep);
			}
			scene_start = i;
		}
	}

	// Don't forget the last scene
	if let Some(rep) = find_scene_representative(&candidates[scene_start..]) {
		representatives.push(rep);
	}

	representatives
}

/// Find the most representative frame within a scene.
fn find_scene_representative(scene_frames: &[FrameCandidate]) -> Option<&FrameCandidate> {
	if scene_frames.is_empty() {
		return None;
	}

	if scene_frames.len() == 1 {
		return Some(&scene_frames[0]);
	}

	// For each frame, compute average distance to all other frames
	let mut min_avg_distance = u32::MAX;
	let mut best_frame = &scene_frames[0];

	for (i, frame) in scene_frames.iter().enumerate() {
		let total_distance: u32 = scene_frames
			.iter()
			.enumerate()
			.filter(|(j, _)| *j != i)
			.map(|(_, other)| frame.hash.distance(&other.hash))
			.sum();

		#[allow(clippy::cast_possible_truncation)]
		let avg_distance = total_distance / (scene_frames.len() - 1) as u32;

		if avg_distance < min_avg_distance {
			min_avg_distance = avg_distance;
			best_frame = frame;
		}
	}

	Some(best_frame)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_hamming_distance_identical() {
		let a = vec![0xFF, 0x00, 0xAA];
		let b = vec![0xFF, 0x00, 0xAA];
		assert_eq!(hamming_distance(&a, &b), 0);
	}

	#[test]
	fn test_hamming_distance_all_different() {
		let a = vec![0xFF]; // 11111111
		let b = vec![0x00]; // 00000000
		assert_eq!(hamming_distance(&a, &b), 8);
	}

	#[test]
	fn test_hamming_distance_partial() {
		let a = vec![0xFF]; // 11111111
		let b = vec![0xF0]; // 11110000
		assert_eq!(hamming_distance(&a, &b), 4);
	}

	#[test]
	fn test_scene_config_default() {
		let config = SceneConfig::default();
		assert_eq!(config.hash_size, 8);
		assert_eq!(config.scene_threshold, 12);
		assert_eq!(config.duplicate_threshold, 3);
	}

	#[test]
	fn test_perceptual_hash_distance() {
		let hash1 = PerceptualHash {
			bytes: vec![0xFF, 0x00],
			hex: "ff00".to_string(),
		};
		let hash2 = PerceptualHash {
			bytes: vec![0xF0, 0x0F],
			hex: "f00f".to_string(),
		};

		// 0xFF ^ 0xF0 = 0x0F (4 bits) + 0x00 ^ 0x0F = 0x0F (4 bits) = 8 bits
		assert_eq!(hash1.distance(&hash2), 8);
	}
}
