//! Visual Memory
//!
//! A visual memory system that models how humans remember images and video.
//!
//! ## Biological Basis
//!
//! Human visual memory operates differently than verbal memory:
//!
//! **Dual-Coding Theory** (Paivio, 1971)
//! - Images and words are stored in separate but connected systems
//! - Visual memories are often more durable than verbal ones
//! - Emotional content enhances visual memory consolidation
//!
//! **Gist vs. Detail** (Brainerd & Reyna, 2005)
//! - We remember the essence (gist) of images longer than details
//! - Details fade faster but can be reinstated with cues
//! - Emotional arousal preferentially preserves gist
//!
//! **Scene Gist** (Oliva, 2005)
//! - We extract the "gist" of a scene in ~100ms
//! - This informs what details we attend to and encode
//! - Scene categories (indoor/outdoor, natural/urban) are processed first
//!
//! ## Key Concepts
//!
//! - **Significance**: How memorable/important the image is (0-1)
//! - **Emotional Context**: Valence (-1 to 1) and arousal (0-1)
//! - **Consolidation**: Visual memories strengthen over time
//! - **Tagging**: Automatic categorization and importance scoring

use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

use crate::activation::{
	combine_activations, compute_base_level, cosine_similarity_batch, nonlinear_activation_batch,
	retrieval_probability,
};
use crate::spreading::{spread_activation, Association, SpreadingConfig, SpreadingResult};

// ============================================================================
// Source Types
// ============================================================================

/// Where a visual memory originated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum VisualSource {
	/// Received via Discord (shared by someone)
	Discord,
	/// Received via SMS/iMessage
	Sms,
	/// Direct upload or screenshot
	Direct,
	/// Extracted frame from video
	VideoFrame,
	/// Other/unknown source
	#[default]
	Other,
}

// ============================================================================
// Emotional Context
// ============================================================================

/// Emotional context of a visual memory.
///
/// Based on the circumplex model of affect (Russell, 1980):
/// - **Valence**: Pleasant (+1) to unpleasant (-1)
/// - **Arousal**: High activation (+1) to low activation (0)
///
/// Emotional arousal enhances memory consolidation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EmotionalContext {
	/// Pleasant (+1) to unpleasant (-1)
	pub valence: f64,
	/// High activation (1) to low activation (0)
	pub arousal: f64,
}

impl Default for EmotionalContext {
	fn default() -> Self {
		Self {
			valence: 0.0,
			arousal: 0.5,
		}
	}
}

impl EmotionalContext {
	/// Create a new emotional context.
	#[must_use]
	pub fn new(valence: f64, arousal: f64) -> Self {
		Self {
			valence: valence.clamp(-1.0, 1.0),
			arousal: arousal.clamp(0.0, 1.0),
		}
	}

	/// Compute emotional weight (0.5-1.5 multiplier for activation).
	///
	/// Higher arousal = stronger memory encoding.
	#[inline]
	#[must_use]
	pub fn emotional_weight(&self) -> f64 {
		// Base weight of 0.5, arousal adds up to 1.0
		0.5 + self.arousal
	}

	/// Check if this represents a strong emotional moment.
	#[inline]
	#[must_use]
	pub fn is_significant(&self) -> bool {
		self.arousal > 0.7 || self.valence.abs() > 0.7
	}
}

// ============================================================================
// Visual Memory
// ============================================================================

/// A visual memory with full metadata.
///
/// This represents a stored image or video frame with its associated
/// context, embeddings, and retrieval metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualMemory {
	/// Unique identifier
	pub id: u32,

	/// Short description (the "gist" of what's in the image)
	pub description: String,

	/// Detailed description (specific elements, decays faster)
	pub detailed_description: Option<String>,

	/// Visual embedding vector (from vision model)
	pub embedding: Vec<f64>,

	/// When the image was captured/received
	pub captured_at_ms: f64,

	/// Most recent access timestamp
	pub last_accessed_ms: f64,

	/// Access count (for familiarity computation)
	pub access_count: u32,

	/// Emotional context at capture time
	pub emotional_context: EmotionalContext,

	/// Significance score (0-1, how memorable/important)
	pub significance: f64,

	/// Where this image came from
	pub source: VisualSource,

	/// Who shared this (if applicable)
	pub shared_by: Option<String>,

	/// Video ID if this is a frame
	pub video_id: Option<String>,

	/// Frame number within video
	pub frame_number: Option<u32>,

	/// Detected objects/entities
	pub objects: Vec<String>,

	/// Semantic tags (auto-generated or manual)
	pub tags: Vec<String>,

	/// Whether this memory is pinned (protected from decay/pruning)
	pub pinned: bool,
}

impl VisualMemory {
	/// Check if this is a video frame.
	#[inline]
	#[must_use]
	pub const fn is_video_frame(&self) -> bool {
		self.video_id.is_some()
	}

	/// Compute emotional weight for retrieval.
	#[inline]
	#[must_use]
	pub fn emotional_weight(&self) -> f64 {
		self.emotional_context.emotional_weight()
	}
}

// ============================================================================
// Configuration
// ============================================================================

/// Configuration for visual memory operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualConfig {
	/// Significance threshold for automatic tagging
	pub tagging_significance_threshold: f64,

	/// Minimum emotional arousal to boost retention
	pub emotional_retention_threshold: f64,

	/// How much emotional arousal reduces decay rate (0-1)
	pub emotional_decay_reduction: f64,

	/// Decay rate for visual memories (per day after threshold)
	pub base_decay_rate: f64,

	/// Days before decay begins
	pub stale_threshold_days: u32,

	/// Minimum significance floor (never drops below this)
	pub significance_floor: f64,

	/// Pruning threshold - memories below this may be pruned
	pub pruning_threshold: f64,

	/// Maximum days since access before considering for pruning
	pub pruning_stale_days: u32,

	/// Whether to preserve video keyframes from pruning
	pub preserve_keyframes: bool,
}

impl Default for VisualConfig {
	fn default() -> Self {
		Self {
			tagging_significance_threshold: 0.6,
			emotional_retention_threshold: 0.7,
			emotional_decay_reduction: 0.5,
			base_decay_rate: 0.05,
			stale_threshold_days: 14,
			significance_floor: 0.1,
			pruning_threshold: 0.2,
			pruning_stale_days: 90,
			preserve_keyframes: true,
		}
	}
}

// ============================================================================
// Retrieval
// ============================================================================

/// Configuration for visual memory retrieval.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualRetrievalConfig {
	/// Decay rate for base-level activation
	pub decay_rate: f64,
	/// Retrieval threshold (tau)
	pub activation_threshold: f64,
	/// Noise parameter (s)
	pub noise_parameter: f64,
	/// Spreading activation depth
	pub spreading_depth: usize,
	/// Spreading decay per hop
	pub spreading_decay: f64,
	/// Minimum probability to include
	pub min_probability: f64,
	/// Maximum results to return
	pub max_results: usize,
	/// Whether to spread bidirectionally
	pub bidirectional: bool,
	/// Boost factor for emotionally significant memories
	pub emotional_boost: f64,
	/// Boost factor for high-significance memories
	pub significance_boost: f64,
}

impl Default for VisualRetrievalConfig {
	fn default() -> Self {
		Self {
			decay_rate: 0.5,
			activation_threshold: 0.3,
			noise_parameter: 0.1,
			spreading_depth: 3,
			spreading_decay: 0.7,
			min_probability: 0.1,
			max_results: 10,
			bidirectional: true,
			emotional_boost: 0.3,
			significance_boost: 0.2,
		}
	}
}

/// A candidate from visual memory retrieval.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualRetrievalCandidate {
	/// Visual memory index
	pub index: usize,
	/// Base-level activation from access history
	pub base_level: f64,
	/// Probe-trace activation (cubed similarity)
	pub probe_activation: f64,
	/// Spreading activation from associated memories
	pub spreading: f64,
	/// Emotional weight factor
	pub emotional_weight: f64,
	/// Significance boost
	pub significance_boost: f64,
	/// Combined total activation
	pub total_activation: f64,
	/// Retrieval probability (0-1)
	pub probability: f64,
	/// Estimated retrieval latency (ms)
	pub latency_ms: f64,
}

/// Input data for visual retrieval.
pub struct VisualRetrievalInput<'a> {
	/// Probe embedding vector
	pub probe_embedding: &'a [f64],
	/// All visual memory embeddings
	pub memory_embeddings: &'a [Vec<f64>],
	/// Access timestamps (ms) for each memory
	pub access_histories_ms: &'a [Vec<f64>],
	/// Emotional weights for each memory
	pub emotional_weights: &'a [f64],
	/// Significance scores for each memory
	pub significance_scores: &'a [f64],
	/// Association graph edges
	pub associations: &'a [Association],
	/// Current time (ms)
	pub current_time_ms: f64,
}

/// Retrieve visual memories based on probe embedding.
///
/// This uses the same ACT-R spreading activation model as text retrieval,
/// but adds boosts for emotional significance and memory importance.
#[must_use]
pub fn retrieve_visual(
	input: &VisualRetrievalInput<'_>,
	config: &VisualRetrievalConfig,
) -> Vec<VisualRetrievalCandidate> {
	let n = input.memory_embeddings.len();
	if n == 0 {
		return Vec::new();
	}

	// 1. Compute probe-trace similarities (batch)
	let similarities = cosine_similarity_batch(input.probe_embedding, input.memory_embeddings);

	// 2. Apply nonlinear activation (MINERVA 2)
	let probe_activations = nonlinear_activation_batch(&similarities);

	// 3. Compute base-level activation (batch)
	let base_levels: Vec<f64> = input
		.access_histories_ms
		.iter()
		.map(|history| compute_base_level(history, input.current_time_ms, config.decay_rate))
		.collect();

	// 4. Initial activation (before spreading)
	let initial_activations: Vec<f64> = (0..n)
		.map(|i| {
			let base = if base_levels[i].is_finite() {
				base_levels[i]
			} else {
				-10.0
			};
			let emotional = input.emotional_weights.get(i).copied().unwrap_or(0.5);
			let emotional_multiplier = 1.0 + (emotional - 0.5);
			(base + probe_activations[i]) * emotional_multiplier
		})
		.collect();

	// 5. Find seeds for spreading (top activated)
	let mut seeds: Vec<(usize, f64)> = initial_activations
		.iter()
		.enumerate()
		.filter(|(_, &a)| a > 0.0)
		.map(|(i, &a)| (i, a))
		.collect();
	seeds.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
	seeds.truncate(5);

	// 6. Spread activation
	let spreading_result = if !seeds.is_empty() && config.spreading_depth > 0 {
		let seed_indices: Vec<usize> = seeds.iter().map(|(i, _)| *i).collect();
		let seed_activations: Vec<f64> = seeds.iter().map(|(_, a)| *a).collect();

		let spreading_config = SpreadingConfig {
			decay_per_hop: config.spreading_decay,
			minimum_activation: 0.01,
			max_nodes: 1000,
			bidirectional: config.bidirectional,
		};

		spread_activation(
			n,
			input.associations,
			&seed_indices,
			&seed_activations,
			&spreading_config,
			config.spreading_depth,
		)
	} else {
		SpreadingResult {
			activations: vec![0.0; n],
			visited_by_depth: Vec::new(),
		}
	};

	// 7. Combine all activations and build candidates
	let mut candidates: Vec<VisualRetrievalCandidate> = (0..n)
		.filter_map(|i| {
			let base_level = if base_levels[i].is_finite() {
				base_levels[i]
			} else {
				-10.0
			};
			let probe_activation = probe_activations[i];
			let spreading = spreading_result.activations[i];
			let emotional_weight = input.emotional_weights.get(i).copied().unwrap_or(0.5);
			let significance = input.significance_scores.get(i).copied().unwrap_or(0.5);

			// Add significance boost
			let significance_boost = significance * config.significance_boost;
			let emotional_boost = if emotional_weight > 0.7 {
				(emotional_weight - 0.7) * config.emotional_boost
			} else {
				0.0
			};

			let breakdown =
				combine_activations(base_level, probe_activation, spreading, emotional_weight);

			let boosted_total = breakdown.total + significance_boost + emotional_boost;

			let probability = retrieval_probability(
				boosted_total,
				config.activation_threshold,
				config.noise_parameter,
			);

			// Filter by minimum probability
			if probability < config.min_probability {
				return None;
			}

			let latency_ms = 1000.0 * (-boosted_total).exp();

			Some(VisualRetrievalCandidate {
				index: i,
				base_level: breakdown.base_level,
				probe_activation: breakdown.probe_activation,
				spreading: breakdown.spreading,
				emotional_weight: breakdown.emotional_weight,
				significance_boost: significance_boost + emotional_boost,
				total_activation: boosted_total,
				probability,
				latency_ms,
			})
		})
		.collect();

	// 8. Sort by total activation and limit
	candidates.sort_by(|a, b| {
		b.total_activation
			.partial_cmp(&a.total_activation)
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	candidates.truncate(config.max_results);

	candidates
}

// ============================================================================
// Consolidation
// ============================================================================

/// State of memory consolidation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ConsolidationState {
	/// Fresh memory, not yet consolidated
	#[default]
	Fresh,
	/// Currently being consolidated (labile)
	Consolidating,
	/// Fully consolidated (stable)
	Consolidated,
	/// Undergoing reconsolidation after reactivation
	Reconsolidating,
}

/// A time window during which consolidation occurs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsolidationWindow {
	/// When the window opened
	pub started_at_ms: f64,
	/// When the window closes (memory becomes stable)
	pub ends_at_ms: f64,
	/// Current state
	pub state: ConsolidationState,
}

impl ConsolidationWindow {
	/// Create a new consolidation window starting now.
	#[must_use]
	pub fn new(current_time_ms: f64, duration_ms: f64) -> Self {
		Self {
			started_at_ms: current_time_ms,
			ends_at_ms: current_time_ms + duration_ms,
			state: ConsolidationState::Consolidating,
		}
	}

	/// Check if the window is still open.
	#[inline]
	#[must_use]
	pub fn is_open(&self, current_time_ms: f64) -> bool {
		current_time_ms < self.ends_at_ms
	}

	/// Progress through the window (0-1).
	#[must_use]
	pub fn progress(&self, current_time_ms: f64) -> f64 {
		if current_time_ms >= self.ends_at_ms {
			return 1.0;
		}
		let elapsed = current_time_ms - self.started_at_ms;
		let duration = self.ends_at_ms - self.started_at_ms;
		(elapsed / duration).clamp(0.0, 1.0)
	}
}

/// Full consolidation state for a visual memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualConsolidationState {
	/// Current consolidation state
	pub state: ConsolidationState,

	/// Active consolidation window (if consolidating)
	pub window: Option<ConsolidationWindow>,

	/// Consolidation strength (0-1, how well consolidated)
	pub strength: f64,

	/// Number of times reactivated/reconsolidated
	pub reactivation_count: u32,
}

impl Default for VisualConsolidationState {
	fn default() -> Self {
		Self {
			state: ConsolidationState::Fresh,
			window: None,
			strength: 0.0,
			reactivation_count: 0,
		}
	}
}

impl VisualConsolidationState {
	/// Check if the memory is currently labile (modifiable).
	#[inline]
	#[must_use]
	pub const fn is_labile(&self) -> bool {
		matches!(
			self.state,
			ConsolidationState::Consolidating | ConsolidationState::Reconsolidating
		)
	}

	/// Start consolidation.
	pub fn start_consolidation(&mut self, current_time_ms: f64, duration_ms: f64) {
		self.state = ConsolidationState::Consolidating;
		self.window = Some(ConsolidationWindow::new(current_time_ms, duration_ms));
	}

	/// Update consolidation state based on current time.
	pub fn update(&mut self, current_time_ms: f64) {
		if let Some(ref window) = self.window {
			if window.is_open(current_time_ms) {
				self.strength = window.progress(current_time_ms);
			} else {
				self.state = ConsolidationState::Consolidated;
				self.strength = 1.0;
				self.window = None;
			}
		}
	}
}

// ============================================================================
// Tagging
// ============================================================================

/// Why a tag was assigned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TagReason {
	/// Detected automatically by vision model
	AutoDetected,
	/// Inferred from context (e.g., who shared it, when)
	ContextInferred,
	/// Added by user manually
	UserAdded,
	/// Inherited from associated memory
	Inherited,
}

/// A tag with its source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisualTag {
	/// The tag value
	pub tag: String,
	/// Why this tag was assigned
	pub reason: TagReason,
	/// Confidence in this tag (0-1)
	pub confidence: f64,
}

/// Compute tag strength based on various factors.
///
/// Higher strength = more confident the tag applies.
///
/// # Arguments
///
/// * `base_confidence` - Initial confidence from detection (0-1)
/// * `access_count` - How many times the memory was accessed
/// * `significance` - Memory significance (0-1)
/// * `config` - Visual config
///
/// # Returns
///
/// Tag strength (0-1).
#[must_use]
pub fn compute_tag_strength(
	base_confidence: f64,
	access_count: u32,
	significance: f64,
	config: &VisualConfig,
) -> f64 {
	// Access count boost (using same asymptotic curve as familiarity)
	let access_boost = 1.0 - 1.0 / 0.1_f64.mul_add(f64::from(access_count), 1.0);

	// Significance boost
	let significance_boost = if significance > config.tagging_significance_threshold {
		(significance - config.tagging_significance_threshold) * 0.5
	} else {
		0.0
	};

	// Combine with diminishing returns
	let combined = base_confidence + (access_boost * 0.3) + significance_boost;
	combined.min(1.0)
}

/// Check if a tag should be applied based on thresholds.
#[inline]
#[must_use]
pub fn should_tag(strength: f64, threshold: f64) -> bool {
	strength >= threshold
}

// ============================================================================
// Pruning
// ============================================================================

/// A candidate for memory pruning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PruningCandidate {
	/// Memory index
	pub index: usize,
	/// Current significance
	pub significance: f64,
	/// Days since last access
	pub days_since_access: f64,
	/// Why this is a pruning candidate
	pub reason: PruningReason,
	/// Pruning score (higher = more likely to prune)
	pub score: f64,
}

/// Why a memory is a pruning candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PruningReason {
	/// Low significance and not accessed recently
	LowSignificance,
	/// Very stale (not accessed in a long time)
	Stale,
	/// Duplicate or near-duplicate of another memory
	Duplicate,
	/// Low-quality video frame (blurry, etc.)
	LowQuality,
}

/// Compute pruning candidates from a set of visual memories.
///
/// Returns memories that may be candidates for pruning, sorted by score.
#[must_use]
pub fn compute_pruning_candidates(
	memories: &[VisualMemory],
	current_time_ms: f64,
	config: &VisualConfig,
) -> SmallVec<[PruningCandidate; 32]> {
	let ms_per_day = 24.0 * 60.0 * 60.0 * 1000.0;

	let mut candidates: SmallVec<[PruningCandidate; 32]> = memories
		.iter()
		.enumerate()
		.filter_map(|(i, mem)| {
			// Never prune pinned memories
			if mem.pinned {
				return None;
			}

			// Preserve keyframes if configured
			if config.preserve_keyframes && mem.frame_number == Some(0) {
				return None;
			}

			let days_since_access = (current_time_ms - mem.last_accessed_ms) / ms_per_day;

			// Check for stale memories
			if days_since_access > f64::from(config.pruning_stale_days) {
				let score = (days_since_access / f64::from(config.pruning_stale_days))
					* (1.0 - mem.significance);
				return Some(PruningCandidate {
					index: i,
					significance: mem.significance,
					days_since_access,
					reason: PruningReason::Stale,
					score,
				});
			}

			// Check for low significance
			if mem.significance < config.pruning_threshold {
				let score = (config.pruning_threshold - mem.significance)
					* (days_since_access / f64::from(config.stale_threshold_days)).min(1.0);
				return Some(PruningCandidate {
					index: i,
					significance: mem.significance,
					days_since_access,
					reason: PruningReason::LowSignificance,
					score,
				});
			}

			None
		})
		.collect();

	// Sort by score (highest first = most prunable)
	candidates.sort_by(|a, b| {
		b.score
			.partial_cmp(&a.score)
			.unwrap_or(std::cmp::Ordering::Equal)
	});

	candidates
}

/// Check if a specific memory should be pruned.
#[must_use]
pub fn should_prune(
	significance: f64,
	days_since_access: f64,
	is_pinned: bool,
	is_keyframe: bool,
	config: &VisualConfig,
) -> bool {
	if is_pinned {
		return false;
	}

	if config.preserve_keyframes && is_keyframe {
		return false;
	}

	// Stale and low significance
	if days_since_access > f64::from(config.pruning_stale_days)
		&& significance < config.pruning_threshold
	{
		return true;
	}

	// Very stale regardless of significance (except high significance)
	if days_since_access > f64::from(config.pruning_stale_days) * 2.0 && significance < 0.5 {
		return true;
	}

	false
}

// ============================================================================
// Video Frame Selection
// ============================================================================

/// A candidate frame for description.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameCandidate {
	/// Frame index in the video
	pub index: usize,
	/// Timestamp in seconds
	pub timestamp_seconds: f64,
	/// Whether this is a keyframe (I-frame)
	pub is_keyframe: bool,
	/// Whether this is a scene change
	pub is_scene_change: bool,
	/// Quality score (0-1, based on blur/noise detection)
	pub quality_score: f64,
}

/// A transcript segment for context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
	/// Start timestamp in seconds
	pub start_seconds: f64,
	/// End timestamp in seconds
	pub end_seconds: f64,
	/// The transcribed text
	pub text: String,
}

/// Select frames for description, respecting rate limits.
///
/// Prioritizes: keyframes, scene changes, even distribution, transcript moments.
///
/// # Arguments
///
/// * `frames` - All available frame candidates
/// * `max_frames` - Maximum frames to select (respecting API rate limits)
/// * `transcript_segments` - Optional transcript for prioritizing frames with speech
///
/// # Returns
///
/// Indices of selected frames, in chronological order.
#[must_use]
pub fn select_frames_for_description(
	frames: &[FrameCandidate],
	max_frames: usize,
	transcript_segments: Option<&[TranscriptSegment]>,
) -> SmallVec<[usize; 32]> {
	if frames.is_empty() || max_frames == 0 {
		return SmallVec::new();
	}

	// Score each frame
	let mut scored: Vec<(usize, f64)> = frames
		.iter()
		.enumerate()
		.map(|(i, frame)| {
			let mut score = frame.quality_score;

			// Keyframes get priority
			if frame.is_keyframe {
				score += 0.3;
			}

			// Scene changes are important
			if frame.is_scene_change {
				score += 0.5;
			}

			// Boost frames near transcript segments (speech = important)
			if let Some(segments) = transcript_segments {
				for seg in segments {
					if frame.timestamp_seconds >= seg.start_seconds
						&& frame.timestamp_seconds <= seg.end_seconds
					{
						score += 0.2;
						break;
					}
				}
			}

			(i, score)
		})
		.collect();

	// Sort by score (highest first)
	scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

	// Take top candidates, but ensure temporal distribution
	let mut selected: SmallVec<[usize; 32]> = SmallVec::new();

	// Always include first and last frame if we have room
	if max_frames >= 2 && !frames.is_empty() {
		selected.push(0);
		if frames.len() > 1 {
			selected.push(frames.len() - 1);
		}
	}

	// Add remaining by score, avoiding clustering
	let min_gap = if frames.len() > max_frames * 2 {
		frames.len() / (max_frames * 2)
	} else {
		1
	};

	for (idx, _score) in scored {
		if selected.len() >= max_frames {
			break;
		}

		// Check minimum gap from already selected frames
		let too_close = selected.iter().any(|&s| idx.abs_diff(s) < min_gap);

		if !too_close {
			selected.push(idx);
		}
	}

	// Sort by frame index for chronological output
	selected.sort_unstable();

	selected
}

/// Configuration for frame description prompts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameDescriptionConfig {
	/// Whether to include emotional assessment
	pub include_emotion: bool,
	/// Whether to detect and list objects
	pub detect_objects: bool,
	/// Maximum description length guidance
	pub max_description_length: usize,
}

impl Default for FrameDescriptionConfig {
	fn default() -> Self {
		Self {
			include_emotion: true,
			detect_objects: true,
			max_description_length: 200,
		}
	}
}

/// Generate a prompt for Claude Haiku to describe a video frame.
///
/// The prompt is optimized for concise, structured output that includes:
/// - Scene description
/// - Detected objects
/// - Emotional context (if applicable)
/// - Temporal context
///
/// # Arguments
///
/// * `frame_path` - Path to the frame image file
/// * `timestamp_seconds` - When in the video this frame appears
/// * `video_duration_seconds` - Total video duration for context
/// * `transcript_near_frame` - Optional transcript text near this frame
/// * `is_scene_change` - Whether this frame starts a new scene
/// * `shared_by` - Who shared the video (for context)
/// * `config` - Prompt configuration
///
/// # Returns
///
/// A prompt string to send to Claude Haiku along with the image.
#[must_use]
pub fn prepare_frame_description_prompt(
	timestamp_seconds: f64,
	video_duration_seconds: f64,
	transcript_near_frame: Option<&str>,
	is_scene_change: bool,
	shared_by: Option<&str>,
	config: &FrameDescriptionConfig,
) -> String {
	let position = if video_duration_seconds > 0.0 {
		format!(
			"{:.0}s/{:.0}s ({:.0}% through)",
			timestamp_seconds,
			video_duration_seconds,
			(timestamp_seconds / video_duration_seconds) * 100.0
		)
	} else {
		format!("{timestamp_seconds:.0}s")
	};

	let scene_note = if is_scene_change {
		" This is a scene change."
	} else {
		""
	};

	let transcript_context = transcript_near_frame.map_or_else(String::new, |t| {
		format!("\n\nAudio at this moment: \"{t}\"")
	});

	let shared_context =
		shared_by.map_or_else(String::new, |s| format!(" This was shared by {s}."));

	let object_instruction = if config.detect_objects {
		"\n- objects: [list of key objects/people visible]"
	} else {
		""
	};

	let emotion_instruction = if config.include_emotion {
		"\n- valence: [-1 to 1, pleasant to unpleasant]\n- arousal: [0 to 1, calm to exciting]"
	} else {
		""
	};

	format!(
		"Describe this video frame concisely. Position: {position}.{scene_note}{shared_context}{transcript_context}

Respond with JSON:
{{
  \"description\": \"[{} chars max, what's happening in this frame]\"{object_instruction}{emotion_instruction},
  \"significance\": [0 to 1, how memorable/important is this moment]
}}",
		config.max_description_length
	)
}

/// Result of frame description from Haiku.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameDescriptionResult {
	/// The frame description
	pub description: String,
	/// Detected objects (if requested)
	pub objects: Vec<String>,
	/// Emotional valence (-1 to 1)
	pub valence: f64,
	/// Emotional arousal (0 to 1)
	pub arousal: f64,
	/// Significance score (0 to 1)
	pub significance: f64,
}

/// Synthesize multiple frame descriptions into a holistic video description.
///
/// # Arguments
///
/// * `frame_descriptions` - Descriptions of individual frames
/// * `frame_timestamps` - Timestamp for each frame
/// * `transcript` - Optional full transcript
/// * `video_duration_seconds` - Total video duration
///
/// # Returns
///
/// A prompt for synthesizing into a final description.
#[must_use]
pub fn prepare_synthesis_prompt(
	frame_descriptions: &[FrameDescriptionResult],
	frame_timestamps: &[f64],
	transcript: Option<&str>,
	video_duration_seconds: f64,
) -> String {
	use std::fmt::Write;

	let mut frame_summary = String::new();
	for (i, (desc, ts)) in frame_descriptions.iter().zip(frame_timestamps).enumerate() {
		let _ = write!(
			frame_summary,
			"\nFrame {} ({ts:.0}s): {}",
			i + 1,
			desc.description
		);
	}

	let transcript_section =
		transcript.map_or_else(String::new, |t| format!("\n\nTranscript:\n\"{t}\""));

	format!(
		"Synthesize these frame descriptions into a cohesive 2-3 sentence summary of what this {video_duration_seconds:.0}s video shows.
{frame_summary}{transcript_section}

Write a natural description that captures the essence of the video, not just a list of frames."
	)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
	use super::*;

	#[test]
	fn test_emotional_context_weight() {
		let low = EmotionalContext::new(0.0, 0.0);
		let high = EmotionalContext::new(0.0, 1.0);

		assert!((low.emotional_weight() - 0.5).abs() < 0.001);
		assert!((high.emotional_weight() - 1.5).abs() < 0.001);
	}

	#[test]
	fn test_emotional_context_significance() {
		let neutral = EmotionalContext::new(0.0, 0.5);
		let high_arousal = EmotionalContext::new(0.0, 0.8);
		let negative = EmotionalContext::new(-0.9, 0.5);

		assert!(!neutral.is_significant());
		assert!(high_arousal.is_significant());
		assert!(negative.is_significant());
	}

	#[test]
	fn test_consolidation_window() {
		let start = 1000.0;
		let duration = 1000.0;
		let window = ConsolidationWindow::new(start, duration);

		assert!(window.is_open(start + 500.0));
		assert!(!window.is_open(start + 1500.0));
		assert!((window.progress(start + 500.0) - 0.5).abs() < 0.001);
	}

	#[test]
	fn test_tag_strength() {
		let config = VisualConfig::default();

		// Low access, low significance
		let weak = compute_tag_strength(0.5, 1, 0.3, &config);

		// High access, high significance
		let strong = compute_tag_strength(0.8, 20, 0.9, &config);

		assert!(strong > weak);
		assert!(strong <= 1.0);
	}

	#[test]
	fn test_should_prune() {
		let config = VisualConfig::default();

		// Pinned memory should never be pruned
		assert!(!should_prune(0.1, 100.0, true, false, &config));

		// Keyframe should not be pruned by default
		assert!(!should_prune(0.1, 100.0, false, true, &config));

		// Low significance, very stale should be pruned
		assert!(should_prune(0.1, 100.0, false, false, &config));

		// High significance should not be pruned
		assert!(!should_prune(0.8, 100.0, false, false, &config));
	}

	const MS_PER_DAY: f64 = 1000.0 * 60.0 * 60.0 * 24.0;

	#[test]
	fn test_pruning_candidates() {
		let config = VisualConfig::default();
		let current_time = MS_PER_DAY * 100.0; // Day 100
		let old_time = 0.0; // Day 0 (100 days ago from current_time)

		let memories = vec![
			VisualMemory {
				id: 0,
				description: "Test 1".to_string(),
				detailed_description: None,
				embedding: vec![],
				captured_at_ms: old_time,
				last_accessed_ms: old_time,
				access_count: 1,
				emotional_context: EmotionalContext::default(),
				significance: 0.1,
				source: VisualSource::Direct,
				shared_by: None,
				video_id: None,
				frame_number: None,
				objects: vec![],
				tags: vec![],
				pinned: false,
			},
			VisualMemory {
				id: 1,
				description: "Test 2".to_string(),
				detailed_description: None,
				embedding: vec![],
				captured_at_ms: current_time,
				last_accessed_ms: current_time,
				access_count: 10,
				emotional_context: EmotionalContext::new(0.5, 0.8),
				significance: 0.9,
				source: VisualSource::Direct,
				shared_by: None,
				video_id: None,
				frame_number: None,
				objects: vec![],
				tags: vec![],
				pinned: false,
			},
		];

		let candidates = compute_pruning_candidates(&memories, current_time, &config);

		// Only the stale, low-significance memory should be a candidate
		assert_eq!(candidates.len(), 1);
		assert_eq!(candidates[0].index, 0);
	}

	#[test]
	fn test_retrieve_visual_empty() {
		let input = VisualRetrievalInput {
			probe_embedding: &[1.0, 0.0, 0.0],
			memory_embeddings: &[],
			access_histories_ms: &[],
			emotional_weights: &[],
			significance_scores: &[],
			associations: &[],
			current_time_ms: 1_000_000.0,
		};

		let config = VisualRetrievalConfig::default();
		let result = retrieve_visual(&input, &config);
		assert!(result.is_empty());
	}

	#[test]
	fn test_retrieve_visual_similarity_ordering() {
		let probe = vec![1.0, 0.0, 0.0];
		let memories = vec![
			vec![1.0, 0.0, 0.0], // Identical
			vec![0.5, 0.5, 0.0], // Partial
			vec![0.0, 1.0, 0.0], // Orthogonal
		];
		let now = 1_000_000.0;

		let input = VisualRetrievalInput {
			probe_embedding: &probe,
			memory_embeddings: &memories,
			access_histories_ms: &[vec![now], vec![now], vec![now]],
			emotional_weights: &[0.5, 0.5, 0.5],
			significance_scores: &[0.5, 0.5, 0.5],
			associations: &[],
			current_time_ms: now,
		};

		let config = VisualRetrievalConfig {
			spreading_depth: 0,
			min_probability: 0.0,
			..Default::default()
		};

		let result = retrieve_visual(&input, &config);

		// First result should be the identical memory
		assert!(!result.is_empty());
		assert_eq!(result[0].index, 0);
	}
}
