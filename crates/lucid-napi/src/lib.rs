//! Node.js bindings for lucid-core memory retrieval engine.
//!
//! Provides high-performance memory retrieval via napi-rs.

// napi-rs requires owned types at the FFI boundary - can't use references
#![allow(clippy::needless_pass_by_value)]
// Memory indices will never exceed u32::MAX in practice
#![allow(clippy::cast_possible_truncation)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use lucid_core::{
	location::{
		compute_association_strength as core_association_strength,
		compute_batch_decay as core_batch_decay, compute_familiarity as core_compute_familiarity,
		get_associated_locations as core_get_associated,
		infer_activity_type as core_infer_activity, is_well_known as core_is_well_known,
		ActivityInference, ActivityType, LocationAssociation, LocationConfig, LocationIntuition,
	},
	retrieval::{retrieve as core_retrieve, RetrievalConfig as CoreConfig, RetrievalInput},
	spreading::Association as CoreAssociation,
};

/// Association between two memories for spreading activation.
#[napi(object)]
#[derive(Clone)]
pub struct JsAssociation {
	pub source: u32,
	pub target: u32,
	pub forward_strength: f64,
	pub backward_strength: f64,
}

/// Configuration for retrieval.
#[napi(object)]
#[derive(Clone)]
pub struct JsRetrievalConfig {
	/// Decay rate for base-level activation (default: 0.5)
	pub decay_rate: Option<f64>,
	/// Retrieval threshold (default: 0.3)
	pub activation_threshold: Option<f64>,
	/// Noise parameter (default: 0.1)
	pub noise_parameter: Option<f64>,
	/// Spreading activation depth (default: 3)
	pub spreading_depth: Option<u32>,
	/// Spreading decay per hop (default: 0.7)
	pub spreading_decay: Option<f64>,
	/// Minimum probability to include (default: 0.1)
	pub min_probability: Option<f64>,
	/// Maximum results to return (default: 10)
	pub max_results: Option<u32>,
	/// Whether to spread bidirectionally (default: true)
	pub bidirectional: Option<bool>,
}

/// Result candidate from retrieval.
#[napi(object)]
pub struct JsRetrievalCandidate {
	/// Memory index
	pub index: u32,
	/// Base-level activation from access history
	pub base_level: f64,
	/// Probe-trace activation (cubed similarity)
	pub probe_activation: f64,
	/// Spreading activation from associated memories
	pub spreading: f64,
	/// Emotional weight factor
	pub emotional_weight: f64,
	/// Combined total activation
	pub total_activation: f64,
	/// Retrieval probability (0-1)
	pub probability: f64,
	/// Estimated retrieval latency (ms)
	pub latency_ms: f64,
}

/// Full retrieval pipeline using ACT-R spreading activation and MINERVA 2.
///
/// This is the core retrieval function that combines:
/// 1. Probe-trace similarity (cosine similarity)
/// 2. Nonlinear activation (MINERVA 2's cubic function)
/// 3. Base-level activation (recency/frequency from ACT-R)
/// 4. Spreading activation through association graph
///
/// # Arguments
///
/// * `probe_embedding` - The query embedding vector
/// * `memory_embeddings` - All memory embedding vectors (2D array)
/// * `access_histories_ms` - Access timestamps (ms) for each memory
/// * `emotional_weights` - Emotional weight (0-1) for each memory
/// * `decay_rates` - Decay rate for each memory (or use config default)
/// * `current_time_ms` - Current time in milliseconds
/// * `associations` - Optional association graph edges
/// * `config` - Optional retrieval configuration
#[napi]
pub fn retrieve(
	probe_embedding: Vec<f64>,
	memory_embeddings: Vec<Vec<f64>>,
	access_histories_ms: Vec<Vec<f64>>,
	emotional_weights: Vec<f64>,
	decay_rates: Vec<f64>,
	current_time_ms: f64,
	associations: Option<Vec<JsAssociation>>,
	config: Option<JsRetrievalConfig>,
) -> Vec<JsRetrievalCandidate> {
	let config = config.unwrap_or(JsRetrievalConfig {
		decay_rate: None,
		activation_threshold: None,
		noise_parameter: None,
		spreading_depth: None,
		spreading_decay: None,
		min_probability: None,
		max_results: None,
		bidirectional: None,
	});

	let core_config = CoreConfig {
		decay_rate: config.decay_rate.unwrap_or(0.5),
		activation_threshold: config.activation_threshold.unwrap_or(0.3),
		noise_parameter: config.noise_parameter.unwrap_or(0.1),
		spreading_depth: config.spreading_depth.unwrap_or(3) as usize,
		spreading_decay: config.spreading_decay.unwrap_or(0.7),
		min_probability: config.min_probability.unwrap_or(0.1),
		max_results: config.max_results.unwrap_or(10) as usize,
		bidirectional: config.bidirectional.unwrap_or(true),
	};

	let associations: Vec<CoreAssociation> = associations
		.unwrap_or_default()
		.into_iter()
		.map(|a| CoreAssociation {
			source: a.source as usize,
			target: a.target as usize,
			forward_strength: a.forward_strength,
			backward_strength: a.backward_strength,
		})
		.collect();

	let input = RetrievalInput {
		probe_embedding: &probe_embedding,
		memory_embeddings: &memory_embeddings,
		access_histories_ms: &access_histories_ms,
		emotional_weights: &emotional_weights,
		decay_rates: &decay_rates,
		associations: &associations,
		current_time_ms,
	};

	let candidates = core_retrieve(&input, &core_config);

	candidates
		.into_iter()
		.map(|c| JsRetrievalCandidate {
			index: c.index as u32,
			base_level: c.base_level,
			probe_activation: c.probe_activation,
			spreading: c.spreading,
			emotional_weight: c.emotional_weight,
			total_activation: c.total_activation,
			probability: c.probability,
			latency_ms: c.latency_ms,
		})
		.collect()
}

/// Compute cosine similarity between two vectors.
#[napi]
pub fn cosine_similarity(a: Vec<f64>, b: Vec<f64>) -> f64 {
	lucid_core::cosine_similarity(&a, &b)
}

/// Batch compute cosine similarity between probe and all memories.
#[napi]
pub fn cosine_similarity_batch(probe: Vec<f64>, memories: Vec<Vec<f64>>) -> Vec<f64> {
	lucid_core::activation::cosine_similarity_batch(&probe, &memories)
}

/// Compute base-level activation from access history.
///
/// B(m) = ln[Σ(t_k)^(-d)]
#[napi]
pub fn compute_base_level(access_times_ms: Vec<f64>, current_time_ms: f64, decay: f64) -> f64 {
	lucid_core::compute_base_level(&access_times_ms, current_time_ms, decay)
}

/// Apply nonlinear activation (MINERVA 2's cubic function).
///
/// A(i) = S(i)³
#[napi]
pub fn nonlinear_activation(similarity: f64) -> f64 {
	lucid_core::nonlinear_activation(similarity)
}

/// Compute retrieval probability using logistic function.
///
/// P(retrieval) = 1 / (1 + e^((τ - A) / s))
#[napi]
pub fn retrieval_probability(activation: f64, threshold: f64, noise: f64) -> f64 {
	lucid_core::retrieval_probability(activation, threshold, noise)
}

/// Compute surprise (prediction error) between expected and actual.
#[napi]
pub fn compute_surprise(
	expected_embedding: Vec<f64>,
	actual_embedding: Vec<f64>,
	memory_age_days: f64,
	memory_strength: f64,
	base_threshold: f64,
) -> f64 {
	lucid_core::retrieval::compute_surprise(
		&expected_embedding,
		&actual_embedding,
		memory_age_days,
		memory_strength,
		base_threshold,
	)
}

/// Library version
#[napi]
pub fn version() -> String {
	lucid_core::VERSION.to_string()
}

// ============================================================================
// Location Intuitions (Spatial Memory)
// ============================================================================

/// Result of activity type inference.
#[napi(object)]
pub struct JsActivityInference {
	/// The inferred activity type (reading, writing, debugging, refactoring, reviewing, unknown)
	pub activity_type: String,
	/// How it was inferred (explicit, keyword, tool, default)
	pub source: String,
	/// Confidence level (0-1)
	pub confidence: f64,
}

/// A location (file) with familiarity metrics.
#[napi(object)]
#[derive(Clone)]
pub struct JsLocationIntuition {
	/// Index in the location array
	pub id: u32,
	/// Familiarity level (0-1)
	pub familiarity: f64,
	/// Number of times accessed
	pub access_count: u32,
	/// Number of searches avoided
	pub searches_saved: u32,
	/// Last access timestamp (ms)
	pub last_accessed_ms: f64,
	/// Whether pinned (immune to decay)
	pub pinned: bool,
}

/// Association between two locations.
#[napi(object)]
#[derive(Clone)]
pub struct JsLocationAssociation {
	/// Source location index
	pub source: u32,
	/// Target location index
	pub target: u32,
	/// Association strength (0-1)
	pub strength: f64,
	/// Number of co-accesses
	pub co_access_count: u32,
}

/// Configuration for location operations.
#[napi(object)]
#[derive(Clone)]
pub struct JsLocationConfig {
	/// Familiarity curve coefficient (default: 0.1)
	pub familiarity_k: Option<f64>,
	/// Days before decay begins (default: 30)
	pub stale_threshold_days: Option<u32>,
	/// Maximum decay rate (default: 0.10)
	pub max_decay_rate: Option<f64>,
	/// How much familiarity reduces decay (default: 0.8)
	pub decay_dampening: Option<f64>,
	/// Minimum familiarity floor (default: 0.1)
	pub base_floor: Option<f64>,
	/// Extra floor for well-known locations (default: 0.4)
	pub sticky_bonus: Option<f64>,
	/// Threshold for "well-known" (default: 0.7)
	pub well_known_threshold: Option<f64>,
	/// Multiplier: task + same activity (default: 5.0)
	pub task_same_activity_multiplier: Option<f64>,
	/// Multiplier: task + different activity (default: 3.0)
	pub task_diff_activity_multiplier: Option<f64>,
	/// Multiplier: time + same activity (default: 2.0)
	pub time_same_activity_multiplier: Option<f64>,
	/// Multiplier: time + different activity (default: 1.0)
	pub time_diff_activity_multiplier: Option<f64>,
	/// Backward strength factor (default: 0.7)
	pub backward_strength_factor: Option<f64>,
}

/// Associated location result.
#[napi(object)]
pub struct JsAssociatedLocation {
	/// Location index
	pub location_id: u32,
	/// Association strength
	pub strength: f64,
}

/// Compute familiarity for a given access count.
///
/// Uses asymptotic curve: f(n) = 1 - 1/(1 + k*n)
#[napi]
pub fn location_compute_familiarity(access_count: u32, config: Option<JsLocationConfig>) -> f64 {
	let cfg = js_config_to_core(config);
	core_compute_familiarity(access_count, &cfg)
}

/// Infer activity type from context string and optional tool name.
///
/// Precedence: explicit > keyword > tool > default
#[napi]
pub fn location_infer_activity(
	context: String,
	tool_name: Option<String>,
	explicit_type: Option<String>,
) -> JsActivityInference {
	let explicit = explicit_type.and_then(|s| parse_activity_type(&s));
	let tool = tool_name.as_deref();
	let result = core_infer_activity(&context, tool, explicit);
	activity_inference_to_js(result)
}

/// Compute decayed familiarity for multiple locations.
///
/// Returns new familiarity values in the same order as input.
#[napi]
pub fn location_batch_decay(
	locations: Vec<JsLocationIntuition>,
	current_time_ms: f64,
	config: Option<JsLocationConfig>,
) -> Vec<f64> {
	let cfg = js_config_to_core(config);
	let locs: Vec<LocationIntuition> = locations.into_iter().map(js_location_to_core).collect();
	core_batch_decay(&locs, current_time_ms, &cfg)
}

/// Compute association strength with multiplier based on context.
#[napi]
pub fn location_association_strength(
	current_count: u32,
	same_task: bool,
	same_activity: bool,
	config: Option<JsLocationConfig>,
) -> f64 {
	let cfg = js_config_to_core(config);
	let multiplier = lucid_core::location::association_multiplier(same_task, same_activity, &cfg);
	core_association_strength(current_count, multiplier, &cfg)
}

/// Get locations associated with a given location, sorted by strength.
#[napi]
pub fn location_get_associated(
	location_id: u32,
	associations: Vec<JsLocationAssociation>,
	limit: u32,
) -> Vec<JsAssociatedLocation> {
	let assocs: Vec<LocationAssociation> =
		associations.into_iter().map(js_assoc_to_core).collect();
	core_get_associated(location_id, &assocs, limit as usize)
		.into_iter()
		.map(|(id, strength)| JsAssociatedLocation {
			location_id: id,
			strength,
		})
		.collect()
}

/// Check if a location is well-known based on familiarity threshold.
#[napi]
pub fn location_is_well_known(familiarity: f64, config: Option<JsLocationConfig>) -> bool {
	let cfg = js_config_to_core(config);
	core_is_well_known(familiarity, &cfg)
}

// ============================================================================
// Type Conversions
// ============================================================================

fn js_config_to_core(js: Option<JsLocationConfig>) -> LocationConfig {
	match js {
		None => LocationConfig::default(),
		Some(js) => {
			let default = LocationConfig::default();
			LocationConfig {
				familiarity_k: js.familiarity_k.unwrap_or(default.familiarity_k),
				stale_threshold_days: js
					.stale_threshold_days
					.unwrap_or(default.stale_threshold_days),
				max_decay_rate: js.max_decay_rate.unwrap_or(default.max_decay_rate),
				decay_dampening: js.decay_dampening.unwrap_or(default.decay_dampening),
				base_floor: js.base_floor.unwrap_or(default.base_floor),
				sticky_bonus: js.sticky_bonus.unwrap_or(default.sticky_bonus),
				well_known_threshold: js
					.well_known_threshold
					.unwrap_or(default.well_known_threshold),
				task_same_activity_multiplier: js
					.task_same_activity_multiplier
					.unwrap_or(default.task_same_activity_multiplier),
				task_diff_activity_multiplier: js
					.task_diff_activity_multiplier
					.unwrap_or(default.task_diff_activity_multiplier),
				time_same_activity_multiplier: js
					.time_same_activity_multiplier
					.unwrap_or(default.time_same_activity_multiplier),
				time_diff_activity_multiplier: js
					.time_diff_activity_multiplier
					.unwrap_or(default.time_diff_activity_multiplier),
				backward_strength_factor: js
					.backward_strength_factor
					.unwrap_or(default.backward_strength_factor),
			}
		}
	}
}

fn js_location_to_core(js: JsLocationIntuition) -> LocationIntuition {
	LocationIntuition {
		id: js.id,
		familiarity: js.familiarity,
		access_count: js.access_count,
		searches_saved: js.searches_saved,
		last_accessed_ms: js.last_accessed_ms,
		pinned: js.pinned,
	}
}

fn js_assoc_to_core(js: JsLocationAssociation) -> LocationAssociation {
	LocationAssociation {
		source: js.source,
		target: js.target,
		strength: js.strength,
		co_access_count: js.co_access_count,
	}
}

fn activity_inference_to_js(ai: ActivityInference) -> JsActivityInference {
	JsActivityInference {
		activity_type: format!("{:?}", ai.activity_type).to_lowercase(),
		source: format!("{:?}", ai.source).to_lowercase(),
		confidence: ai.confidence,
	}
}

fn parse_activity_type(s: &str) -> Option<ActivityType> {
	match s.to_lowercase().as_str() {
		"reading" => Some(ActivityType::Reading),
		"writing" => Some(ActivityType::Writing),
		"debugging" => Some(ActivityType::Debugging),
		"refactoring" => Some(ActivityType::Refactoring),
		"reviewing" => Some(ActivityType::Reviewing),
		"unknown" => Some(ActivityType::Unknown),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_cosine_similarity() {
		let a = vec![1.0, 0.0, 0.0];
		let b = vec![1.0, 0.0, 0.0];
		assert!((cosine_similarity(a, b) - 1.0).abs() < 1e-10);
	}

	#[test]
	fn test_retrieve_basic() {
		let probe = vec![1.0, 0.0, 0.0];
		let memories = vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0]];
		let now = 1_000_000.0;

		let results = retrieve(
			probe,
			memories,
			vec![vec![now - 1000.0], vec![now - 1000.0]],
			vec![0.5, 0.5],
			vec![0.5, 0.5],
			now,
			None,
			Some(JsRetrievalConfig {
				min_probability: Some(0.0),
				decay_rate: None,
				activation_threshold: None,
				noise_parameter: None,
				spreading_depth: None,
				spreading_decay: None,
				max_results: None,
				bidirectional: None,
			}),
		);

		assert!(!results.is_empty());
		assert_eq!(results[0].index, 0);
	}

	// Location Intuitions tests

	#[test]
	fn test_location_familiarity() {
		// First access
		let f1 = location_compute_familiarity(1, None);
		assert!((f1 - 0.091).abs() < 0.01);

		// 10th access
		let f10 = location_compute_familiarity(10, None);
		assert!((f10 - 0.5).abs() < 0.01);

		// With custom config (faster learning)
		let config = JsLocationConfig {
			familiarity_k: Some(0.2), // 2x faster learning
			stale_threshold_days: None,
			max_decay_rate: None,
			decay_dampening: None,
			base_floor: None,
			sticky_bonus: None,
			well_known_threshold: None,
			task_same_activity_multiplier: None,
			task_diff_activity_multiplier: None,
			time_same_activity_multiplier: None,
			time_diff_activity_multiplier: None,
			backward_strength_factor: None,
		};
		// f(10) with k=0.2 = 1 - 1/(1 + 2) = 0.667 > 0.5
		let f10_fast = location_compute_familiarity(10, Some(config));
		assert!(f10_fast > f10); // Faster learning = higher familiarity at same count
	}

	#[test]
	fn test_location_infer_activity() {
		// Keyword inference
		let result = location_infer_activity("debugging the issue".to_string(), None, None);
		assert_eq!(result.activity_type, "debugging");
		assert_eq!(result.source, "keyword");

		// Tool inference
		let result =
			location_infer_activity("opening file".to_string(), Some("Read".to_string()), None);
		assert_eq!(result.activity_type, "reading");
		assert_eq!(result.source, "tool");

		// Explicit override
		let result = location_infer_activity(
			"reading code".to_string(),
			Some("Read".to_string()),
			Some("debugging".to_string()),
		);
		assert_eq!(result.activity_type, "debugging");
		assert_eq!(result.source, "explicit");
	}

	#[test]
	fn test_location_batch_decay() {
		let current_time = 1000.0 * 60.0 * 60.0 * 24.0 * 100.0; // Day 100
		let old_time = current_time - (60.0 * 24.0 * 60.0 * 60.0 * 1000.0); // 60 days ago

		let locations = vec![
			JsLocationIntuition {
				id: 0,
				familiarity: 0.8,
				access_count: 20,
				searches_saved: 5,
				last_accessed_ms: old_time,
				pinned: false,
			},
			JsLocationIntuition {
				id: 1,
				familiarity: 0.5,
				access_count: 10,
				searches_saved: 2,
				last_accessed_ms: old_time,
				pinned: true, // Pinned - won't decay
			},
		];

		let decayed = location_batch_decay(locations, current_time, None);

		assert!(decayed[0] < 0.8); // Decayed
		assert_eq!(decayed[1], 0.5); // Pinned - unchanged
	}

	#[test]
	fn test_location_association_strength() {
		// Task + same activity = strongest
		let task_same = location_association_strength(1, true, true, None);
		let task_diff = location_association_strength(1, true, false, None);
		let time_same = location_association_strength(1, false, true, None);
		let time_diff = location_association_strength(1, false, false, None);

		assert!(task_same > task_diff);
		assert!(task_diff > time_same);
		assert!(time_same > time_diff);
	}

	#[test]
	fn test_location_is_well_known() {
		assert!(!location_is_well_known(0.5, None));
		assert!(!location_is_well_known(0.69, None));
		assert!(location_is_well_known(0.7, None));
		assert!(location_is_well_known(0.9, None));
	}

	#[test]
	fn test_location_get_associated() {
		let associations = vec![
			JsLocationAssociation {
				source: 0,
				target: 1,
				strength: 0.5,
				co_access_count: 5,
			},
			JsLocationAssociation {
				source: 0,
				target: 2,
				strength: 0.9,
				co_access_count: 10,
			},
			JsLocationAssociation {
				source: 0,
				target: 3,
				strength: 0.3,
				co_access_count: 3,
			},
		];

		let results = location_get_associated(0, associations, 10);

		assert_eq!(results.len(), 3);
		assert_eq!(results[0].location_id, 2); // Highest strength first
		assert_eq!(results[1].location_id, 1);
		assert_eq!(results[2].location_id, 3);
	}
}
