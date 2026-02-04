//! Retrieval Pipeline
//!
//! The complete retrieval pipeline in one optimized pass:
//!
//! 1. Compute probe-trace similarities (batch)
//! 2. Compute base-level activation (batch)
//! 3. Apply nonlinear activation (MINERVA 2)
//! 4. Spread through association graph
//! 5. Combine and rank

use serde::{Deserialize, Serialize};

use crate::activation::{
	combine_activations, compute_base_level, cosine_similarity, cosine_similarity_batch,
	nonlinear_activation_batch, retrieval_probability,
};
use crate::spreading::{spread_activation, Association, SpreadingConfig, SpreadingResult};

/// A memory candidate with all activation components.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RetrievalCandidate {
	/// Memory index
	pub index: usize,
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

/// Configuration for retrieval.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RetrievalConfig {
	/// Decay rate for base-level activation
	pub decay_rate: f64,
	/// Retrieval threshold (τ)
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
}

impl Default for RetrievalConfig {
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
		}
	}
}

/// Input data for retrieval.
pub struct RetrievalInput<'a> {
	/// Probe embedding vector
	pub probe_embedding: &'a [f64],
	/// All memory embeddings
	pub memory_embeddings: &'a [Vec<f64>],
	/// Access timestamps (ms) for each memory
	pub access_histories_ms: &'a [Vec<f64>],
	/// Emotional weight for each memory (0-1)
	pub emotional_weights: &'a [f64],
	/// Per-memory decay rates (allows type-specific and emotional modulation)
	pub decay_rates: &'a [f64],
	/// Working memory boost for each memory (1.0 = no boost, up to 2.0 = max boost)
	/// Applied to similarity BEFORE nonlinear activation (MINERVA 2 cubing).
	/// This models how prefrontal WM modulates hippocampal retrieval in real-time.
	pub working_memory_boosts: &'a [f64],
	/// Association graph edges
	pub associations: &'a [Association],
	/// Current time (ms)
	pub current_time_ms: f64,
}

/// Full retrieval pipeline.
///
/// This is the hot path - optimized for performance.
///
/// # Arguments
///
/// * `input` - Memory data and probe embedding
/// * `config` - Retrieval configuration
///
/// # Returns
///
/// Ranked list of retrieval candidates.
#[must_use]
pub fn retrieve(input: &RetrievalInput<'_>, config: &RetrievalConfig) -> Vec<RetrievalCandidate> {
	let n = input.memory_embeddings.len();
	if n == 0 {
		return Vec::new();
	}

	// 1. Compute probe-trace similarities (batch)
	let similarities = cosine_similarity_batch(input.probe_embedding, input.memory_embeddings);

	// 2. Apply Working Memory boost to similarities BEFORE nonlinear activation
	// This models how prefrontal WM modulates hippocampal retrieval in real-time.
	// WM boost is applied to the similarity signal, then cubed (MINERVA 2).
	// Biologically: PFC attention → enhanced encoding strength → stronger trace match
	let boosted_similarities: Vec<f64> = similarities
		.iter()
		.enumerate()
		.map(|(i, &sim)| {
			let boost = input.working_memory_boosts.get(i).copied().unwrap_or(1.0);
			// Cap at 1.0 to maintain valid similarity range
			(sim * boost).min(1.0)
		})
		.collect();

	// 3. Apply nonlinear activation (MINERVA 2) to boosted similarities
	let probe_activations = nonlinear_activation_batch(&boosted_similarities);

	// 4. Compute base-level activation (batch) with per-memory decay rates
	let base_levels: Vec<f64> = input
		.access_histories_ms
		.iter()
		.enumerate()
		.map(|(i, history)| {
			let decay_rate = input
				.decay_rates
				.get(i)
				.copied()
				.unwrap_or(config.decay_rate);
			compute_base_level(history, input.current_time_ms, decay_rate)
		})
		.collect();

	// 5. Initial activation (before spreading)
	// Emotional weight modulates probe activation only (not base-level)
	let initial_activations: Vec<f64> = (0..n)
		.map(|i| {
			let base = if base_levels[i].is_finite() {
				base_levels[i]
			} else {
				-10.0
			};
			let emotional = input.emotional_weights.get(i).copied().unwrap_or(0.5);
			let emotional_multiplier = 1.0 + (emotional - 0.5);
			probe_activations[i].mul_add(emotional_multiplier, base)
		})
		.collect();

	// 6. Find seeds for spreading (top activated)
	let mut seeds: Vec<(usize, f64)> = initial_activations
		.iter()
		.enumerate()
		.filter(|(_, &a)| a > 0.0)
		.map(|(i, &a)| (i, a))
		.collect();
	seeds.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
	seeds.truncate(5); // Top 5 as seeds

	// 7. Spread activation
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

	// 8. Combine all activations and build candidates
	let mut candidates: Vec<RetrievalCandidate> = (0..n)
		.filter_map(|i| {
			let base_level = if base_levels[i].is_finite() {
				base_levels[i]
			} else {
				-10.0
			};
			let probe_activation = probe_activations[i];
			let spreading = spreading_result.activations[i];
			let emotional_weight = input.emotional_weights.get(i).copied().unwrap_or(0.5);

			let breakdown =
				combine_activations(base_level, probe_activation, spreading, emotional_weight);

			let probability = retrieval_probability(
				breakdown.total,
				config.activation_threshold,
				config.noise_parameter,
			);

			// Filter by minimum probability
			if probability < config.min_probability {
				return None;
			}

			let latency_ms = 1000.0 * (-breakdown.total).exp();

			Some(RetrievalCandidate {
				index: i,
				base_level: breakdown.base_level,
				probe_activation: breakdown.probe_activation,
				spreading: breakdown.spreading,
				emotional_weight: breakdown.emotional_weight,
				total_activation: breakdown.total,
				probability,
				latency_ms,
			})
		})
		.collect();

	// 9. Sort by total activation and limit
	candidates.sort_by(|a, b| {
		b.total_activation
			.partial_cmp(&a.total_activation)
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	candidates.truncate(config.max_results);

	candidates
}

/// Lightweight similarity-only retrieval.
///
/// Use when you just need to find similar memories without full activation.
#[must_use]
pub fn retrieve_by_similarity(
	probe_embedding: &[f64],
	memory_embeddings: &[Vec<f64>],
	top_k: usize,
) -> Vec<usize> {
	let similarities = cosine_similarity_batch(probe_embedding, memory_embeddings);

	let mut indexed: Vec<(usize, f64)> = similarities.into_iter().enumerate().collect();
	indexed.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

	indexed.into_iter().take(top_k).map(|(i, _)| i).collect()
}

/// Compute surprise (prediction error) between expected and actual.
///
/// Used to trigger reconsolidation - when a retrieved memory differs
/// significantly from expectation.
///
/// # Arguments
///
/// * `expected_embedding` - What was expected
/// * `actual_embedding` - What was retrieved
/// * `memory_age_days` - Age of the memory in days
/// * `memory_strength` - Strength/consolidation level (0-1)
/// * `base_threshold` - Base surprise threshold
///
/// # Returns
///
/// Normalized surprise value (0 = no surprise, 1 = max surprise).
#[must_use]
pub fn compute_surprise(
	expected_embedding: &[f64],
	actual_embedding: &[f64],
	memory_age_days: f64,
	memory_strength: f64,
	base_threshold: f64,
) -> f64 {
	// Semantic surprise = 1 - cosine_similarity
	let similarity = cosine_similarity(expected_embedding, actual_embedding);
	let semantic_surprise = 1.0 - similarity;

	// Adjust threshold based on memory strength and age
	// (trace dominance: stronger/older memories need more surprise)
	let age_adjustment = memory_age_days * 0.01;
	let strength_adjustment = memory_strength * 0.2;
	let adjusted_threshold = base_threshold + age_adjustment + strength_adjustment;

	// Return normalized surprise (0 = no surprise, 1 = max surprise)
	(semantic_surprise / adjusted_threshold).min(1.0)
}

/// Check if surprise triggers lability (reconsolidation window).
#[must_use]
pub fn triggers_lability(surprise: f64, threshold: f64) -> bool {
	surprise > threshold
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_retrieve_empty() {
		let input = RetrievalInput {
			probe_embedding: &[1.0, 0.0, 0.0],
			memory_embeddings: &[],
			access_histories_ms: &[],
			emotional_weights: &[],
			decay_rates: &[],
			working_memory_boosts: &[],
			associations: &[],
			current_time_ms: 1_000_000.0,
		};

		let config = RetrievalConfig::default();
		let result = retrieve(&input, &config);
		assert!(result.is_empty());
	}

	#[test]
	fn test_retrieve_similarity_ordering() {
		let probe = vec![1.0, 0.0, 0.0];
		let memories = vec![
			vec![1.0, 0.0, 0.0], // Identical to probe
			vec![0.5, 0.5, 0.0], // Partially similar
			vec![0.0, 1.0, 0.0], // Orthogonal
		];
		let now = 1_000_000.0;

		let input = RetrievalInput {
			probe_embedding: &probe,
			memory_embeddings: &memories,
			access_histories_ms: &[vec![now], vec![now], vec![now]], // Recent access
			emotional_weights: &[0.5, 0.5, 0.5],
			decay_rates: &[0.05, 0.05, 0.05],
			working_memory_boosts: &[1.0, 1.0, 1.0], // No boost
			associations: &[],
			current_time_ms: now,
		};

		let config = RetrievalConfig {
			spreading_depth: 0,
			min_probability: 0.0,
			..Default::default()
		};

		let result = retrieve(&input, &config);

		// First result should be the identical memory
		assert!(!result.is_empty());
		assert_eq!(result[0].index, 0);
	}

	#[test]
	fn test_surprise_similar() {
		let a = vec![1.0, 0.0, 0.0];
		let b = vec![1.0, 0.0, 0.0];
		let surprise = compute_surprise(&a, &b, 1.0, 0.5, 0.5);
		assert!(surprise < 0.1); // Low surprise for identical
	}

	#[test]
	fn test_surprise_different() {
		let a = vec![1.0, 0.0, 0.0];
		let b = vec![0.0, 1.0, 0.0];
		let surprise = compute_surprise(&a, &b, 1.0, 0.5, 0.5);
		assert!(surprise > 0.5); // High surprise for orthogonal
	}

	#[test]
	fn test_working_memory_boost() {
		let probe = vec![1.0, 0.0, 0.0];
		let memories = vec![
			vec![0.7, 0.7, 0.0], // Moderately similar (sim ≈ 0.707)
			vec![0.7, 0.7, 0.0], // Same similarity, but will get WM boost
		];
		let now = 1_000_000.0;

		let input = RetrievalInput {
			probe_embedding: &probe,
			memory_embeddings: &memories,
			access_histories_ms: &[vec![now], vec![now]],
			emotional_weights: &[0.5, 0.5],
			decay_rates: &[0.5, 0.5],
			working_memory_boosts: &[1.0, 2.0], // Memory 1 gets 2x WM boost
			associations: &[],
			current_time_ms: now,
		};

		let config = RetrievalConfig {
			spreading_depth: 0,
			min_probability: 0.0,
			..Default::default()
		};

		let result = retrieve(&input, &config);

		// Memory 1 (with WM boost) should rank higher
		assert!(!result.is_empty());
		assert_eq!(result[0].index, 1, "WM-boosted memory should rank first");
		assert!(
			result[0].total_activation > result[1].total_activation,
			"WM-boosted memory should have higher activation"
		);
	}

	#[test]
	fn test_working_memory_boost_caps_similarity() {
		let probe = vec![1.0, 0.0, 0.0];
		let memories = vec![
			vec![0.9, 0.436, 0.0], // High similarity (≈0.9)
		];
		let now = 1_000_000.0;

		let input = RetrievalInput {
			probe_embedding: &probe,
			memory_embeddings: &memories,
			access_histories_ms: &[vec![now]],
			emotional_weights: &[0.5],
			decay_rates: &[0.5],
			working_memory_boosts: &[2.0], // 2x boost would exceed 1.0, should cap
			associations: &[],
			current_time_ms: now,
		};

		let config = RetrievalConfig {
			spreading_depth: 0,
			min_probability: 0.0,
			..Default::default()
		};

		let result = retrieve(&input, &config);

		// Probe activation should be capped at 1.0^3 = 1.0
		assert!(!result.is_empty());
		assert!(
			result[0].probe_activation <= 1.0,
			"Probe activation should be capped at 1.0"
		);
	}
}
