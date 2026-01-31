//! Location Intuitions
//!
//! Spatial memory for AI systems, modeling how humans develop intuitions
//! about locations (files) through repeated exposure.
//!
//! ## Biological Basis
//!
//! This module implements three brain systems:
//!
//! **Hippocampal Place Cells** (O'Keefe & Nadel, 1978)
//! - Neurons that fire when you're in a specific location
//! - Familiarity increases with repeated exposure
//! - Formula: `f(n) = 1 - 1/(1 + k*n)` where n = access count
//!
//! **Entorhinal Cortex** (Moser et al., 2008)
//! - Binds context to spatial memory — *where* + *what you were doing*
//! - We track activity type (reading, writing, debugging) bound to each file access
//!
//! **Procedural Memory** (Squire, 1992)
//! - "Knowing how" vs "knowing that" — you don't consciously recall how to ride a bike
//! - Direct file access (without searching) indicates procedural knowledge
//! - We track `searches_saved` as a signal of true familiarity
//!
//! **Associative Networks** (Hebb, 1949)
//! - "Neurons that fire together wire together"
//! - Files accessed for the same task form bidirectional associations
//! - Shared task context creates strong links; temporal proximity creates weaker links

use serde::{Deserialize, Serialize};

// ============================================================================
// Types
// ============================================================================

/// Activity type for context binding (entorhinal cortex model).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActivityType {
	/// Examining code without modification
	Reading,
	/// Creating or modifying code
	Writing,
	/// Investigating issues or errors
	Debugging,
	/// Restructuring existing code
	Refactoring,
	/// Code review or audit
	Reviewing,
	/// Could not be determined
	Unknown,
}

/// How the activity type was determined.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InferenceSource {
	/// User or tool explicitly provided the activity type
	Explicit,
	/// Inferred from keywords in context text
	Keyword,
	/// Inferred from tool name (Read, Edit, etc.)
	Tool,
	/// Fallback when nothing else matched
	Default,
}

/// Result of activity type inference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityInference {
	/// The inferred activity type
	pub activity_type: ActivityType,
	/// How it was determined
	pub source: InferenceSource,
	/// Confidence level (0-1)
	pub confidence: f64,
}

/// A location (file) with familiarity metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationIntuition {
	/// Index in the location array
	pub id: u32,
	/// Familiarity level (0-1, asymptotic curve)
	pub familiarity: f64,
	/// Number of times accessed
	pub access_count: u32,
	/// Number of searches avoided by direct navigation
	pub searches_saved: u32,
	/// Timestamp of last access (ms since epoch)
	pub last_accessed_ms: f64,
	/// Whether this location is pinned (immune to decay)
	pub pinned: bool,
}

/// Association between two locations (co-access network).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationAssociation {
	/// Source location index
	pub source: u32,
	/// Target location index
	pub target: u32,
	/// Association strength (0-1)
	pub strength: f64,
	/// Number of co-accesses
	pub co_access_count: u32,
}

/// Configuration for location-based operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationConfig {
	/// Familiarity curve coefficient: f(n) = 1 - 1/(1 + k*n)
	pub familiarity_k: f64,

	/// Days before decay begins
	pub stale_threshold_days: u32,

	/// Maximum decay rate (at familiarity = 0)
	pub max_decay_rate: f64,

	/// How much familiarity reduces decay (0-1)
	pub decay_dampening: f64,

	/// Minimum familiarity floor
	pub base_floor: f64,

	/// Extra floor protection for f > 0.5
	pub sticky_bonus: f64,

	/// Familiarity threshold for "well-known"
	pub well_known_threshold: f64,

	/// Multiplier for task-based + same activity associations
	pub task_same_activity_multiplier: f64,
	/// Multiplier for task-based + different activity associations
	pub task_diff_activity_multiplier: f64,
	/// Multiplier for time-based + same activity associations
	pub time_same_activity_multiplier: f64,
	/// Multiplier for time-based + different activity associations
	pub time_diff_activity_multiplier: f64,

	/// Backward association strength factor (relative to forward)
	pub backward_strength_factor: f64,
}

impl Default for LocationConfig {
	fn default() -> Self {
		Self {
			familiarity_k: 0.1,
			stale_threshold_days: 30,
			max_decay_rate: 0.10,
			decay_dampening: 0.8,
			base_floor: 0.1,
			sticky_bonus: 0.4,
			well_known_threshold: 0.7,
			task_same_activity_multiplier: 5.0,
			task_diff_activity_multiplier: 3.0,
			time_same_activity_multiplier: 2.0,
			time_diff_activity_multiplier: 1.0,
			backward_strength_factor: 0.7,
		}
	}
}

// ============================================================================
// Familiarity Computation
// ============================================================================

/// Compute new familiarity after an access.
///
/// Follows asymptotic curve: `f(n) = 1 - 1/(1 + k*n)`
///
/// Biological basis: Hippocampal trace strengthening shows
/// diminishing returns with repeated exposure.
///
/// # Examples
///
/// ```
/// use lucid_core::location::{compute_familiarity, LocationConfig};
///
/// let config = LocationConfig::default();
///
/// // First access: low familiarity
/// assert!((compute_familiarity(1, &config) - 0.091).abs() < 0.01);
///
/// // 10th access: medium familiarity
/// assert!((compute_familiarity(10, &config) - 0.5).abs() < 0.01);
///
/// // Many accesses: approaches 1.0 asymptotically
/// assert!(compute_familiarity(100, &config) > 0.9);
/// ```
#[inline]
#[must_use]
pub fn compute_familiarity(access_count: u32, config: &LocationConfig) -> f64 {
	let n = f64::from(access_count);
	1.0 - 1.0 / config.familiarity_k.mul_add(n, 1.0)
}

/// Compute familiarity for first access (aligns with curve).
#[inline]
#[must_use]
pub fn initial_familiarity(config: &LocationConfig) -> f64 {
	compute_familiarity(1, config)
}

// ============================================================================
// Decay Computation
// ============================================================================

/// Compute decayed familiarity for a single location.
///
/// Continuous decay function - rate decreases as familiarity increases:
/// - Pinned locations never decay (explicit user protection)
/// - High familiarity locations decay slowly (procedural memory is sticky)
/// - Low familiarity locations decay quickly (weak traces fade)
/// - Well-known locations have elevated floors
///
/// ```text
/// decayRate(f) = maxDecay * (1 - f * dampening)
/// floor(f) = baseFloor + (f > 0.5 ? stickyBonus * (f - 0.5) : 0)
/// ```
///
/// # Examples
///
/// ```
/// use lucid_core::location::{compute_decayed_familiarity, LocationConfig};
///
/// let config = LocationConfig::default();
/// let current_time = 1000.0 * 60.0 * 60.0 * 24.0 * 100.0; // Day 100
///
/// // Recently accessed - no decay
/// let recent = current_time - (10.0 * 24.0 * 60.0 * 60.0 * 1000.0);
/// assert_eq!(compute_decayed_familiarity(0.8, recent, current_time, false, &config), 0.8);
///
/// // Pinned - never decays
/// let old = current_time - (60.0 * 24.0 * 60.0 * 60.0 * 1000.0);
/// assert_eq!(compute_decayed_familiarity(0.8, old, current_time, true, &config), 0.8);
/// ```
#[must_use]
pub fn compute_decayed_familiarity(
	current_familiarity: f64,
	last_accessed_ms: f64,
	current_time_ms: f64,
	pinned: bool,
	config: &LocationConfig,
) -> f64 {
	// Pinned locations never decay
	if pinned {
		return current_familiarity;
	}

	// Handle invalid timestamps (NaN, Infinity, negative)
	if !last_accessed_ms.is_finite() || last_accessed_ms < 0.0 {
		return current_familiarity;
	}

	let ms_per_day = 24.0 * 60.0 * 60.0 * 1000.0;
	let days_since_access = (current_time_ms - last_accessed_ms) / ms_per_day;

	// No decay if accessed recently (or future timestamp)
	if days_since_access < f64::from(config.stale_threshold_days) {
		return current_familiarity;
	}

	// Continuous decay rate (decreases with familiarity)
	let decay_rate =
		config.max_decay_rate * current_familiarity.mul_add(-config.decay_dampening, 1.0);

	// Sliding floor (higher for well-known locations)
	let floor = if current_familiarity > 0.5 {
		config
			.sticky_bonus
			.mul_add(current_familiarity - 0.5, config.base_floor)
	} else {
		config.base_floor
	};

	// Apply decay with floor
	let decayed = current_familiarity * (1.0 - decay_rate);
	decayed.max(floor)
}

/// Batch compute decay for multiple locations.
///
/// Returns new familiarity values in the same order as input.
///
/// Note: For large datasets (100k+ locations), prefer SQL-based decay
/// in the TypeScript layer to avoid loading all data into memory.
#[must_use]
pub fn compute_batch_decay(
	locations: &[LocationIntuition],
	current_time_ms: f64,
	config: &LocationConfig,
) -> Vec<f64> {
	locations
		.iter()
		.map(|loc| {
			compute_decayed_familiarity(
				loc.familiarity,
				loc.last_accessed_ms,
				current_time_ms,
				loc.pinned,
				config,
			)
		})
		.collect()
}

// ============================================================================
// Activity Type Inference
// ============================================================================

/// Infer activity type from context string and/or tool name.
///
/// Precedence (matches entorhinal context binding model):
/// 1. Explicit (caller-provided) - highest priority
/// 2. Keyword-based (intent indicators in context) - medium priority
/// 3. Tool-based (Read/Edit/Write tool names) - lower priority
/// 4. Default (unknown) - fallback
///
/// Rationale: Keywords like "debug" indicate intent, while tool names
/// just indicate the action taken. "Reading a file to debug" → debugging.
///
/// # Examples
///
/// ```
/// use lucid_core::location::{infer_activity_type, ActivityType, InferenceSource};
///
/// // Explicit always wins
/// let result = infer_activity_type("reading code", Some("Read"), Some(ActivityType::Debugging));
/// assert_eq!(result.activity_type, ActivityType::Debugging);
/// assert_eq!(result.source, InferenceSource::Explicit);
///
/// // Keywords beat tool names
/// let result = infer_activity_type("debugging the issue", Some("Read"), None);
/// assert_eq!(result.activity_type, ActivityType::Debugging);
/// assert_eq!(result.source, InferenceSource::Keyword);
///
/// // Tool name as fallback
/// let result = infer_activity_type("opening the file", Some("Read"), None);
/// assert_eq!(result.activity_type, ActivityType::Reading);
/// assert_eq!(result.source, InferenceSource::Tool);
/// ```
#[must_use]
pub fn infer_activity_type(
	context: &str,
	tool_name: Option<&str>,
	explicit: Option<ActivityType>,
) -> ActivityInference {
	// 1. Explicit always wins
	if let Some(activity) = explicit {
		if activity != ActivityType::Unknown {
			return ActivityInference {
				activity_type: activity,
				source: InferenceSource::Explicit,
				confidence: 1.0,
			};
		}
	}

	// 2. Keyword-based inference (intent indicators)
	let lower = context.to_lowercase();

	let keyword_matches: &[(ActivityType, &[&str], f64)] = &[
		(
			ActivityType::Debugging,
			&["debug", "fix", "bug", "issue", "error", "trace"],
			0.9,
		),
		(
			ActivityType::Refactoring,
			&["refactor", "clean", "reorganize", "restructure"],
			0.9,
		),
		(
			ActivityType::Reviewing,
			&["review", "understand", "check", "examine", "audit"],
			0.8,
		),
		(
			ActivityType::Writing,
			&["implement", "add", "create", "write", "build"],
			0.7,
		),
		(
			ActivityType::Reading,
			&["read", "look", "see", "view", "inspect"],
			0.6,
		),
	];

	for (activity_type, keywords, confidence) in keyword_matches {
		if keywords.iter().any(|kw| lower.contains(kw)) {
			return ActivityInference {
				activity_type: *activity_type,
				source: InferenceSource::Keyword,
				confidence: *confidence,
			};
		}
	}

	// 3. Tool-based inference (action, not intent)
	if let Some(tool) = tool_name {
		let tool_activity = match tool {
			"Read" | "Grep" | "Glob" => Some(ActivityType::Reading),
			"Edit" | "Write" => Some(ActivityType::Writing),
			_ => None,
		};

		if let Some(activity) = tool_activity {
			return ActivityInference {
				activity_type: activity,
				source: InferenceSource::Tool,
				confidence: 0.5,
			};
		}
	}

	// 4. Default fallback
	ActivityInference {
		activity_type: ActivityType::Unknown,
		source: InferenceSource::Default,
		confidence: 0.0,
	}
}

// ============================================================================
// Association Strength
// ============================================================================

/// Compute new association strength after a co-access.
///
/// Follows the same asymptotic curve as familiarity.
/// Multiplier reflects association quality:
/// - 5x: Same task + same activity (strongest conceptual link)
/// - 3x: Same task, different activity (clear conceptual link)
/// - 2x: Time-based + same activity (probable link)
/// - 1x: Time-based only (possible link, fallback)
#[inline]
#[must_use]
pub fn compute_association_strength(
	current_count: u32,
	multiplier: f64,
	config: &LocationConfig,
) -> f64 {
	let effective_count = f64::from(current_count) * multiplier;
	1.0 - 1.0 / config.familiarity_k.mul_add(effective_count, 1.0)
}

/// Determine the appropriate multiplier for an association.
#[inline]
#[must_use]
#[allow(clippy::missing_const_for_fn)] // Can't be const due to config parameter
pub fn association_multiplier(
	same_task: bool,
	same_activity: bool,
	config: &LocationConfig,
) -> f64 {
	match (same_task, same_activity) {
		(true, true) => config.task_same_activity_multiplier,
		(true, false) => config.task_diff_activity_multiplier,
		(false, true) => config.time_same_activity_multiplier,
		(false, false) => config.time_diff_activity_multiplier,
	}
}

// ============================================================================
// Location Spreading Activation
// ============================================================================

use crate::spreading::{spread_activation, Association, SpreadingConfig};

/// Spread activation through location association network.
///
/// Biological basis: Hippocampal place field overlap.
/// When you think of one location, related locations activate.
///
/// # Returns
///
/// Activations as a vector parallel to the input (same indices).
#[must_use]
pub fn spread_location_activation(
	num_locations: usize,
	seed_location: u32,
	seed_activation: f64,
	associations: &[LocationAssociation],
	location_config: &LocationConfig,
	spreading_config: &SpreadingConfig,
) -> Vec<f64> {
	// Convert LocationAssociation to core Association
	let core_associations: Vec<Association> = associations
		.iter()
		.map(|la| Association {
			source: la.source as usize,
			target: la.target as usize,
			forward_strength: la.strength,
			backward_strength: la.strength * location_config.backward_strength_factor,
		})
		.collect();

	// Use existing spreading activation
	let result = spread_activation(
		num_locations,
		&core_associations,
		&[seed_location as usize],
		&[seed_activation],
		spreading_config,
		spreading_config.max_nodes.min(3), // Default depth of 3
	);

	result.activations
}

/// Find locations most strongly associated with a given location.
#[must_use]
pub fn get_associated_locations(
	location_id: u32,
	associations: &[LocationAssociation],
	limit: usize,
) -> Vec<(u32, f64)> {
	let mut results: Vec<_> = associations
		.iter()
		.filter(|a| a.source == location_id)
		.map(|a| (a.target, a.strength))
		.collect();

	results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
	results.truncate(limit);
	results
}

/// Check if a location is well-known based on familiarity threshold.
#[inline]
#[must_use]
pub fn is_well_known(familiarity: f64, config: &LocationConfig) -> bool {
	familiarity >= config.well_known_threshold
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[allow(clippy::float_cmp, clippy::suboptimal_flops)]
mod tests {
	use super::*;

	#[test]
	fn familiarity_curve_matches_specification() {
		let config = LocationConfig::default();

		// f(1) ≈ 0.091
		assert!((compute_familiarity(1, &config) - 0.091).abs() < 0.001);

		// f(10) ≈ 0.5
		assert!((compute_familiarity(10, &config) - 0.5).abs() < 0.01);

		// f(24) ≈ 0.7 (well-known threshold)
		assert!(compute_familiarity(24, &config) >= 0.7);

		// Asymptotic approach to 1
		assert!(compute_familiarity(1000, &config) > 0.99);
		assert!(compute_familiarity(1000, &config) < 1.0);
	}

	#[test]
	fn decay_respects_stale_threshold() {
		let config = LocationConfig::default();
		let current_time = 1000.0 * 60.0 * 60.0 * 24.0 * 100.0; // Day 100

		// Accessed 10 days ago - no decay
		let recent = current_time - (10.0 * 24.0 * 60.0 * 60.0 * 1000.0);
		assert_eq!(
			compute_decayed_familiarity(0.8, recent, current_time, false, &config),
			0.8
		);

		// Accessed 60 days ago - should decay
		let old = current_time - (60.0 * 24.0 * 60.0 * 60.0 * 1000.0);
		assert!(compute_decayed_familiarity(0.8, old, current_time, false, &config) < 0.8);
	}

	#[test]
	fn high_familiarity_has_sticky_floor() {
		let config = LocationConfig::default();
		let current_time = 1000.0 * 60.0 * 60.0 * 24.0 * 365.0; // Day 365
		let very_old = 0.0; // Day 0

		// High familiarity should not decay below sticky floor
		let decayed = compute_decayed_familiarity(0.9, very_old, current_time, false, &config);
		let expected_floor = config.base_floor + config.sticky_bonus * (0.9 - 0.5);
		assert!(decayed >= expected_floor);
	}

	#[test]
	fn pinned_locations_never_decay() {
		let config = LocationConfig::default();
		let current_time = 1000.0 * 60.0 * 60.0 * 24.0 * 365.0; // Day 365
		let very_old = 0.0; // Day 0

		// Pinned location should not decay at all
		let decayed = compute_decayed_familiarity(0.5, very_old, current_time, true, &config);
		assert_eq!(decayed, 0.5);
	}

	#[test]
	fn handles_invalid_timestamps() {
		let config = LocationConfig::default();
		let current_time = 1000.0 * 60.0 * 60.0 * 24.0 * 100.0;

		// NaN timestamp - should return current familiarity
		let result = compute_decayed_familiarity(0.7, f64::NAN, current_time, false, &config);
		assert_eq!(result, 0.7);

		// Infinity timestamp - should return current familiarity
		let result = compute_decayed_familiarity(0.7, f64::INFINITY, current_time, false, &config);
		assert_eq!(result, 0.7);

		// Negative timestamp - should return current familiarity
		let result = compute_decayed_familiarity(0.7, -1000.0, current_time, false, &config);
		assert_eq!(result, 0.7);
	}

	#[test]
	fn activity_inference_precedence() {
		// 1. Explicit wins over everything
		let result =
			infer_activity_type("reading code", Some("Read"), Some(ActivityType::Debugging));
		assert_eq!(result.activity_type, ActivityType::Debugging);
		assert_eq!(result.source, InferenceSource::Explicit);

		// 2. Keyword wins over tool
		let result = infer_activity_type("debugging the issue", Some("Read"), None);
		assert_eq!(result.activity_type, ActivityType::Debugging);
		assert_eq!(result.source, InferenceSource::Keyword);

		// 3. Tool inference when no keywords
		let result = infer_activity_type("opening the file", Some("Read"), None);
		assert_eq!(result.activity_type, ActivityType::Reading);
		assert_eq!(result.source, InferenceSource::Tool);

		let result = infer_activity_type("doing something", Some("Edit"), None);
		assert_eq!(result.activity_type, ActivityType::Writing);
		assert_eq!(result.source, InferenceSource::Tool);

		// 4. Default fallback when nothing matches
		let result = infer_activity_type("doing stuff", None, None);
		assert_eq!(result.activity_type, ActivityType::Unknown);
		assert_eq!(result.source, InferenceSource::Default);
	}

	#[test]
	fn task_associations_stronger_than_time() {
		let config = LocationConfig::default();

		let task_same = association_multiplier(true, true, &config);
		let task_diff = association_multiplier(true, false, &config);
		let time_same = association_multiplier(false, true, &config);
		let time_diff = association_multiplier(false, false, &config);

		assert!(task_same > task_diff);
		assert!(task_diff > time_same);
		assert!(time_same > time_diff);
	}

	#[test]
	fn association_strength_follows_asymptotic_curve() {
		let config = LocationConfig::default();

		// With 5x multiplier, 2 co-accesses = 10 effective
		let strength = compute_association_strength(2, 5.0, &config);
		assert!((strength - 0.5).abs() < 0.01);

		// Without multiplier
		let weak_strength = compute_association_strength(2, 1.0, &config);
		assert!(weak_strength < strength);
	}

	#[test]
	fn well_known_threshold() {
		let config = LocationConfig::default();

		assert!(!is_well_known(0.5, &config));
		assert!(!is_well_known(0.69, &config));
		assert!(is_well_known(0.7, &config));
		assert!(is_well_known(0.9, &config));
	}

	#[test]
	fn get_associated_returns_sorted_by_strength() {
		let associations = vec![
			LocationAssociation {
				source: 0,
				target: 1,
				strength: 0.5,
				co_access_count: 5,
			},
			LocationAssociation {
				source: 0,
				target: 2,
				strength: 0.9,
				co_access_count: 10,
			},
			LocationAssociation {
				source: 0,
				target: 3,
				strength: 0.3,
				co_access_count: 3,
			},
		];

		let results = get_associated_locations(0, &associations, 10);

		assert_eq!(results.len(), 3);
		assert_eq!(results[0], (2, 0.9)); // Highest first
		assert_eq!(results[1], (1, 0.5));
		assert_eq!(results[2], (3, 0.3));
	}

	#[test]
	fn batch_decay_applies_to_all() {
		let config = LocationConfig::default();
		let current_time = 1000.0 * 60.0 * 60.0 * 24.0 * 100.0;
		let old_time = current_time - (60.0 * 24.0 * 60.0 * 60.0 * 1000.0); // 60 days ago

		let locations = vec![
			LocationIntuition {
				id: 0,
				familiarity: 0.8,
				access_count: 20,
				searches_saved: 5,
				last_accessed_ms: old_time,
				pinned: false,
			},
			LocationIntuition {
				id: 1,
				familiarity: 0.5,
				access_count: 10,
				searches_saved: 2,
				last_accessed_ms: old_time,
				pinned: true, // Pinned - won't decay
			},
		];

		let decayed = compute_batch_decay(&locations, current_time, &config);

		assert!(decayed[0] < 0.8); // Decayed
		assert_eq!(decayed[1], 0.5); // Pinned - unchanged
	}
}
