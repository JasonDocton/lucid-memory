//! Activation Calculation
//!
//! The mathematics of remembering.
//!
//! Three components combine to determine what surfaces:
//! 1. **Base-level activation** (recency/frequency): `B(m) = ln[Σ(t_k)^(-d)]`
//! 2. **Probe-trace similarity** (relevance): `A(i) = S(i)³`
//! 3. **Spreading activation** (association): `A_j = Σ(W_i/n_i) × S_ij`
//!
//! The cubed similarity function (MINERVA 2) is crucial:
//! it ensures weakly matching traces contribute minimally
//! while strong matches dominate.

use serde::{Deserialize, Serialize};

/// Configuration for activation calculations.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActivationConfig {
	/// `d` in forgetting equation (default: 0.5 for human-like decay)
	pub decay_rate: f64,
	/// `τ` (tau) - retrieval threshold
	pub activation_threshold: f64,
	/// `s` - noise/temperature parameter
	pub noise_parameter: f64,
	/// `F` - latency scaling factor
	pub latency_factor: f64,
}

impl Default for ActivationConfig {
	fn default() -> Self {
		Self {
			decay_rate: 0.5,
			activation_threshold: 0.3,
			noise_parameter: 0.1,
			latency_factor: 1.0,
		}
	}
}

/// Breakdown of activation components for a single memory.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActivationBreakdown {
	/// From probe-trace similarity: `S(i)³`
	pub probe_activation: f64,
	/// From access history / decay: `B(m) = ln[Σ(t_k)^(-d)]`
	pub base_level: f64,
	/// From connected nodes: `A_j = Σ(W_i/n_i) × S_ij`
	pub spreading: f64,
	/// Emotional salience multiplier
	pub emotional_weight: f64,
	/// Combined total
	pub total: f64,
}

// ============================================================================
// Base-Level Activation
// ============================================================================

/// Compute base-level activation from access history.
///
/// `B(m) = ln[Σ(t_k)^(-d)]`
///
/// Where:
/// - `t_k` = time since access k (in seconds)
/// - `d` = decay rate (≈ 0.5 for humans)
///
/// Each access strengthens the memory. Recent and frequent access
/// means higher activation.
///
/// # Arguments
///
/// * `access_timestamps_ms` - Timestamps of previous accesses (in milliseconds)
/// * `current_time_ms` - Current time (in milliseconds)
/// * `decay_rate` - Decay parameter d (typically 0.5)
///
/// # Returns
///
/// Base-level activation value, or negative infinity if no accesses.
#[must_use]
pub fn compute_base_level(
	access_timestamps_ms: &[f64],
	current_time_ms: f64,
	decay_rate: f64,
) -> f64 {
	if access_timestamps_ms.is_empty() {
		return f64::NEG_INFINITY;
	}

	let sum: f64 = access_timestamps_ms
		.iter()
		.map(|&timestamp| {
			// Convert to seconds, minimum 1 second to avoid division issues
			let time_since_access_s = (current_time_ms - timestamp).max(1000.0) / 1000.0;
			time_since_access_s.powf(-decay_rate)
		})
		.sum();

	sum.ln()
}

/// Batch compute base-level activation for multiple memories.
#[must_use]
pub fn compute_base_level_batch(
	memories: &[Vec<f64>],
	current_time_ms: f64,
	decay_rate: f64,
) -> Vec<f64> {
	memories
		.iter()
		.map(|timestamps| compute_base_level(timestamps, current_time_ms, decay_rate))
		.collect()
}

// ============================================================================
// Vector Similarity
// ============================================================================

/// Compute cosine similarity between two vectors.
///
/// # Arguments
///
/// * `a` - First vector
/// * `b` - Second vector
///
/// # Returns
///
/// Cosine similarity in range [-1, 1], or 0 if vectors have different lengths.
#[inline]
#[must_use]
pub fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
	if a.len() != b.len() {
		return 0.0;
	}

	let (dot_product, norm_a, norm_b) = a
		.iter()
		.zip(b.iter())
		.fold((0.0, 0.0, 0.0), |(dot, na, nb), (&ai, &bi)| {
			(ai.mul_add(bi, dot), ai.mul_add(ai, na), bi.mul_add(bi, nb))
		});

	let magnitude = norm_a.sqrt() * norm_b.sqrt();
	if magnitude == 0.0 {
		0.0
	} else {
		dot_product / magnitude
	}
}

/// Batch compute cosine similarity of a probe against multiple traces.
///
/// Pre-computes probe norm for efficiency.
#[must_use]
pub fn cosine_similarity_batch(probe: &[f64], traces: &[Vec<f64>]) -> Vec<f64> {
	let probe_norm: f64 = probe.iter().map(|x| x * x).sum::<f64>().sqrt();

	if probe_norm == 0.0 {
		return vec![0.0; traces.len()];
	}

	traces
		.iter()
		.map(|trace| {
			if trace.len() != probe.len() {
				return 0.0;
			}

			let (dot_product, trace_norm_sq) = probe
				.iter()
				.zip(trace.iter())
				.fold((0.0, 0.0), |(dot, tn), (&pi, &ti)| {
					(pi.mul_add(ti, dot), ti.mul_add(ti, tn))
				});

			let trace_norm = trace_norm_sq.sqrt();
			if trace_norm == 0.0 {
				0.0
			} else {
				dot_product / (probe_norm * trace_norm)
			}
		})
		.collect()
}

// ============================================================================
// MINERVA 2 Activation
// ============================================================================

/// Apply MINERVA 2's nonlinear activation function.
///
/// `A(i) = S(i)³`
///
/// Cubing emphasizes strong matches and suppresses weak ones.
/// This is what enables pattern completion from partial cues—
/// only memories that strongly match the probe contribute.
#[inline]
#[must_use]
pub fn nonlinear_activation(similarity: f64) -> f64 {
	// Preserve sign for negative similarities
	similarity.powi(3)
}

/// Batch apply nonlinear activation.
#[must_use]
pub fn nonlinear_activation_batch(similarities: &[f64]) -> Vec<f64> {
	similarities.iter().map(|s| s.powi(3)).collect()
}

// ============================================================================
// Combined Activation
// ============================================================================

/// Combine all activation sources into total activation.
///
/// Emotional weight modulates the probe activation (relevance signal),
/// not the base-level activation (recency/frequency). This is cognitively
/// plausible: emotion affects how strongly a memory resonates with a cue,
/// not how recently it was accessed.
///
/// `Total = baseLevel + (probeActivation × emotionalMultiplier) + spreading`
#[must_use]
pub fn combine_activations(
	base_level: f64,
	probe_activation: f64,
	spreading_activation: f64,
	emotional_weight: f64,
) -> ActivationBreakdown {
	// Emotional weight modulates probe activation (range: 0.5 to 1.5)
	// This ensures emotional memories resonate more strongly with matching cues
	let emotional_multiplier = 1.0 + (emotional_weight - 0.5);

	// Handle -infinity base level
	let effective_base = if base_level.is_finite() {
		base_level
	} else {
		-10.0
	};

	// Apply emotional modulation to probe activation only
	// Base-level (recency/frequency) is independent of emotional salience
	let modulated_probe = probe_activation * emotional_multiplier;
	let total = effective_base + modulated_probe + spreading_activation;

	ActivationBreakdown {
		base_level: effective_base,
		probe_activation: modulated_probe,
		spreading: spreading_activation,
		emotional_weight,
		total,
	}
}

// ============================================================================
// Retrieval Probability
// ============================================================================

/// Compute probability of successful retrieval.
///
/// `P(recall) = 1 / (1 + e^((τ - A) / s))`
///
/// Where:
/// - `τ` = retrieval threshold
/// - `A` = total activation
/// - `s` = noise parameter
///
/// This is a logistic function centered on the threshold.
/// Higher activation = higher probability.
#[inline]
#[must_use]
pub fn retrieval_probability(
	total_activation: f64,
	activation_threshold: f64,
	noise_parameter: f64,
) -> f64 {
	let exponent = (activation_threshold - total_activation) / noise_parameter;
	1.0 / (1.0 + exponent.exp())
}

/// Batch compute retrieval probabilities.
#[must_use]
pub fn retrieval_probability_batch(
	activations: &[f64],
	activation_threshold: f64,
	noise_parameter: f64,
) -> Vec<f64> {
	activations
		.iter()
		.map(|&a| retrieval_probability(a, activation_threshold, noise_parameter))
		.collect()
}

/// Estimate retrieval latency in milliseconds.
///
/// `latency = F × e^(-A) × 1000`
///
/// Higher activation = faster retrieval.
#[inline]
#[must_use]
pub fn retrieval_latency(total_activation: f64, latency_factor: f64) -> f64 {
	latency_factor * (-total_activation).exp() * 1000.0
}

// ============================================================================
// Ranking and Filtering
// ============================================================================

/// Rank indices by activation, returning top k.
#[must_use]
pub fn rank_by_activation(activations: &[f64], top_k: usize) -> Vec<usize> {
	let mut indexed: Vec<(usize, f64)> = activations.iter().copied().enumerate().collect();

	// Sort by activation descending
	indexed.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

	indexed.into_iter().take(top_k).map(|(i, _)| i).collect()
}

/// Filter indices by probability threshold.
#[must_use]
pub fn filter_by_probability(
	activations: &[f64],
	min_probability: f64,
	activation_threshold: f64,
	noise_parameter: f64,
) -> Vec<usize> {
	activations
		.iter()
		.enumerate()
		.filter(|(_, &a)| {
			retrieval_probability(a, activation_threshold, noise_parameter) >= min_probability
		})
		.map(|(i, _)| i)
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_cosine_similarity_identical() {
		let a = vec![1.0, 0.0, 0.0];
		let b = vec![1.0, 0.0, 0.0];
		assert!((cosine_similarity(&a, &b) - 1.0).abs() < 1e-10);
	}

	#[test]
	fn test_cosine_similarity_orthogonal() {
		let a = vec![1.0, 0.0, 0.0];
		let b = vec![0.0, 1.0, 0.0];
		assert!(cosine_similarity(&a, &b).abs() < 1e-10);
	}

	#[test]
	fn test_nonlinear_activation() {
		assert!((nonlinear_activation(0.5) - 0.125).abs() < 1e-10);
		assert!((nonlinear_activation(1.0) - 1.0).abs() < 1e-10);
		assert!((nonlinear_activation(-0.5) - (-0.125)).abs() < 1e-10);
	}

	#[test]
	fn test_retrieval_probability() {
		// At threshold, probability should be 0.5
		let prob = retrieval_probability(0.3, 0.3, 0.1);
		assert!((prob - 0.5).abs() < 1e-10);

		// Well above threshold, probability approaches 1
		let prob_high = retrieval_probability(1.0, 0.3, 0.1);
		assert!(prob_high > 0.99);
	}

	#[test]
	fn test_base_level_recency() {
		let now = 1_000_000.0;
		let recent = vec![now - 1000.0]; // 1 second ago
		let old = vec![now - 86_400_000.0]; // 1 day ago

		let recent_activation = compute_base_level(&recent, now, 0.5);
		let old_activation = compute_base_level(&old, now, 0.5);

		assert!(recent_activation > old_activation);
	}
}
