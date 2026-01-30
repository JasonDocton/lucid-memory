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
}
