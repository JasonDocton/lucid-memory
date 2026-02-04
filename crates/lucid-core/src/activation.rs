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
/// Uses MULTIPLICATIVE combination where similarity is the primary signal
/// and recency acts as a boost multiplier, not an additive override.
///
/// This prevents recent-but-irrelevant items from beating old-but-relevant items.
///
/// Formula: `Total = (probe × emotional × (1 + recency_boost)) + spreading`
///
/// Where `recency_boost = max(0, (base_level + 10) / 10)` maps base-level
/// from [-10, 0] to [0, 1], so very recent items get up to 2x boost.
#[must_use]
pub fn combine_activations(
	base_level: f64,
	probe_activation: f64,
	spreading_activation: f64,
	emotional_weight: f64,
) -> ActivationBreakdown {
	// Emotional weight modulates probe activation (range: 0.5 to 1.5)
	let emotional_multiplier = 1.0 + (emotional_weight - 0.5);

	// Handle -infinity base level
	let effective_base = if base_level.is_finite() {
		base_level
	} else {
		-10.0
	};

	// Normalize base-level to [0, 1] for multiplicative boost
	// Base-level typically ranges from -10 (very old) to 0 (just accessed)
	// This maps to recency_boost of 0 to 1, giving total multiplier of 1x to 2x
	let recency_boost = ((effective_base + 10.0) / 10.0).clamp(0.0, 1.0);

	// Apply emotional modulation to probe activation
	let modulated_probe = probe_activation * emotional_multiplier;

	// MULTIPLICATIVE combination: similarity is primary, recency is boost
	// This ensures low-similarity items can't be rescued by recency alone
	let probe_with_recency = modulated_probe * (1.0 + recency_boost);
	let total = probe_with_recency + spreading_activation;

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
// Working Memory Boost
// ============================================================================

/// Configuration for working memory calculations.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkingMemoryConfig {
	/// Decay time constant in milliseconds (τ ≈ 4000ms per Baddeley 2000)
	pub decay_ms: f64,
	/// Maximum boost multiplier (1.0 means total boost ranges from 1.0 to 2.0)
	pub max_boost: f64,
}

impl Default for WorkingMemoryConfig {
	fn default() -> Self {
		Self {
			decay_ms: 4000.0,
			max_boost: 1.0,
		}
	}
}

/// Compute working memory boost for a memory.
///
/// `boost = 1.0 + max_boost × e^(-age/τ)`
///
/// Where:
/// - `age` = time since activation (ms)
/// - `τ` = decay time constant (≈4000ms)
/// - `max_boost` = maximum additional boost (1.0 → range [1.0, 2.0])
///
/// Recently activated memories get up to 2x boost.
/// Based on Baddeley (2000) working memory model.
#[inline]
#[must_use]
pub fn compute_working_memory_boost(
	activated_at_ms: f64,
	current_time_ms: f64,
	config: &WorkingMemoryConfig,
) -> f64 {
	let age = current_time_ms - activated_at_ms;

	// Guard against clock skew (negative age would cause boost > max)
	if age < 0.0 {
		return 1.0;
	}

	// Exponential decay: e^(-t/τ)
	let decay_factor = (-age / config.decay_ms).exp();

	// Return boost in range [1.0, 1.0 + max_boost]
	config.max_boost.mul_add(decay_factor, 1.0)
}

/// Batch compute working memory boosts.
#[must_use]
pub fn compute_working_memory_boost_batch(
	activated_at_ms: &[f64],
	current_time_ms: f64,
	config: &WorkingMemoryConfig,
) -> Vec<f64> {
	activated_at_ms
		.iter()
		.map(|&t| compute_working_memory_boost(t, current_time_ms, config))
		.collect()
}

// ============================================================================
// Session-Aware Decay Rate
// ============================================================================

/// Compute session-aware decay rate based on recency.
///
/// Recent memories decay slower (lower d value = higher base-level activation).
/// This stays within ACT-R model by modulating the d parameter.
///
/// Returns decay rate in range [0.3, 0.5]:
/// - Last 30 min: 0.3 (much slower decay)
/// - Last 2 hours: 0.4 (slower decay)
/// - Last 24 hours: 0.45 (slightly slower)
/// - Older: 0.5 (default ACT-R decay)
#[inline]
#[must_use]
pub fn compute_session_decay_rate(last_access_ms: f64, current_time_ms: f64) -> f64 {
	let hours_ago = (current_time_ms - last_access_ms) / 3_600_000.0;

	// Guard against future timestamps (clock skew, data corruption)
	if hours_ago < 0.0 {
		return 0.5;
	}

	if hours_ago < 0.5 {
		0.3 // Last 30 minutes
	} else if hours_ago < 2.0 {
		0.4 // Last 2 hours
	} else if hours_ago < 24.0 {
		0.45 // Last day
	} else {
		0.5 // Default ACT-R decay
	}
}

/// Batch compute session-aware decay rates.
#[must_use]
pub fn compute_session_decay_rate_batch(last_access_ms: &[f64], current_time_ms: f64) -> Vec<f64> {
	last_access_ms
		.iter()
		.map(|&t| compute_session_decay_rate(t, current_time_ms))
		.collect()
}

// ============================================================================
// Instance Noise / Encoding Strength (MINERVA 2)
// ============================================================================

/// Configuration for instance noise calculation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InstanceNoiseConfig {
	/// Minimum encoding strength (ensures all memories are retrievable)
	pub encoding_base: f64,
	/// Contribution from explicit importance marking
	pub attention_weight: f64,
	/// Contribution from `emotional_weight` field
	pub emotional_weight: f64,
	/// Contribution from `access_count` (rehearsal effect)
	pub rehearsal_weight: f64,
	/// Cap for rehearsal contribution (diminishing returns)
	pub max_rehearsal_count: u32,
	/// Base noise parameter for retrieval probability
	pub noise_base: f64,
}

impl Default for InstanceNoiseConfig {
	fn default() -> Self {
		Self {
			encoding_base: 0.3,
			attention_weight: 0.2,
			emotional_weight: 0.2,
			rehearsal_weight: 0.3,
			max_rehearsal_count: 10,
			noise_base: 0.25,
		}
	}
}

/// Compute encoding strength for a memory.
///
/// Encoding strength determines how "crisp" a memory trace is.
/// Strongly encoded memories have lower noise (more reliable retrieval).
///
/// `strength = base + attention×a + emotion×e + rehearsal×min(count, max)/max`
///
/// Based on MINERVA 2 (Hintzman 1984) instance-based memory.
#[must_use]
pub fn compute_encoding_strength(
	attention: f64,
	emotional_weight: f64,
	access_count: u32,
	config: &InstanceNoiseConfig,
) -> f64 {
	let rehearsal_contribution = if config.max_rehearsal_count > 0 {
		let effective_count = access_count.min(config.max_rehearsal_count);
		#[allow(clippy::cast_precision_loss)]
		let ratio = f64::from(effective_count) / f64::from(config.max_rehearsal_count);
		config.rehearsal_weight * ratio
	} else {
		0.0
	};

	(config.emotional_weight.mul_add(
		emotional_weight,
		config
			.attention_weight
			.mul_add(attention, config.encoding_base),
	) + rehearsal_contribution)
		.clamp(0.0, 1.0)
}

/// Compute per-memory noise parameter from encoding strength.
///
/// Stronger encoding = lower noise = more reliable retrieval.
///
/// `noise = noise_base × (2.0 - strength)`
///
/// At strength=1.0, `noise=noise_base` (minimum noise).
/// At strength=0.0, `noise=2×noise_base` (maximum noise).
#[inline]
#[must_use]
pub fn compute_instance_noise(encoding_strength: f64, noise_base: f64) -> f64 {
	noise_base * (2.0 - encoding_strength)
}

// ============================================================================
// Association Decay
// ============================================================================

/// Consolidation state for memory decay calculations.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssociationState {
	/// Recently created, not yet consolidated
	Fresh,
	/// In the process of consolidation
	Consolidating,
	/// Fully consolidated into long-term memory
	Consolidated,
	/// Reactivated and undergoing reconsolidation
	Reconsolidating,
}

/// Configuration for association decay.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AssociationDecayConfig {
	/// Decay tau for fresh associations (in days)
	pub tau_fresh_days: f64,
	/// Decay tau for consolidating associations (in days)
	pub tau_consolidating_days: f64,
	/// Decay tau for consolidated associations (in days)
	pub tau_consolidated_days: f64,
	/// Decay tau for reconsolidating associations (in days)
	pub tau_reconsolidating_days: f64,
	/// Strength boost when associations are co-accessed
	pub reinforcement_boost: f64,
	/// Associations below this strength are candidates for pruning
	pub prune_threshold: f64,
}

impl Default for AssociationDecayConfig {
	fn default() -> Self {
		Self {
			tau_fresh_days: 1.0 / 24.0,    // 1 hour
			tau_consolidating_days: 1.0,   // 1 day
			tau_consolidated_days: 30.0,   // 30 days
			tau_reconsolidating_days: 7.0, // 7 days
			reinforcement_boost: 0.05,
			prune_threshold: 0.1,
		}
	}
}

/// Get decay tau (in days) based on consolidation state.
#[inline]
#[must_use]
pub const fn get_decay_tau(state: AssociationState, config: &AssociationDecayConfig) -> f64 {
	match state {
		AssociationState::Fresh => config.tau_fresh_days,
		AssociationState::Consolidating => config.tau_consolidating_days,
		AssociationState::Consolidated => config.tau_consolidated_days,
		AssociationState::Reconsolidating => config.tau_reconsolidating_days,
	}
}

/// Compute decayed association strength.
///
/// `strength(t) = strength_0 × e^(-t/τ)`
///
/// Where τ depends on consolidation state.
#[must_use]
pub fn compute_association_decay(
	initial_strength: f64,
	days_since_reinforced: f64,
	state: AssociationState,
	config: &AssociationDecayConfig,
) -> f64 {
	let tau = get_decay_tau(state, config);

	if tau <= 0.0 {
		return initial_strength;
	}

	let decayed = initial_strength * (-days_since_reinforced / tau).exp();

	// Floor at prune threshold (don't decay below pruning point)
	decayed.max(0.0)
}

/// Reinforce an association (co-access boost).
///
/// `new_strength = min(1.0, old_strength + boost)`
#[inline]
#[must_use]
pub fn reinforce_association(current_strength: f64, config: &AssociationDecayConfig) -> f64 {
	(current_strength + config.reinforcement_boost).min(1.0)
}

/// Check if an association should be pruned.
#[inline]
#[must_use]
pub fn should_prune_association(strength: f64, config: &AssociationDecayConfig) -> bool {
	strength < config.prune_threshold
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
#[allow(clippy::float_cmp, clippy::suboptimal_flops)]
mod tests {
	use super::*;

	// Working Memory tests

	#[test]
	fn test_working_memory_boost_at_activation() {
		let config = WorkingMemoryConfig::default();
		let now = 10000.0;
		// Just activated - should get full boost
		let boost = compute_working_memory_boost(now, now, &config);
		assert!((boost - 2.0).abs() < 0.01);
	}

	#[test]
	fn test_working_memory_boost_decay() {
		let config = WorkingMemoryConfig::default();
		let now = 10000.0;
		// After 5 time constants (~20 seconds), boost should be minimal
		let old_activation = now - 5.0 * config.decay_ms;
		let boost = compute_working_memory_boost(old_activation, now, &config);
		assert!(boost < 1.01); // Nearly no boost
	}

	#[test]
	fn test_working_memory_boost_clock_skew() {
		let config = WorkingMemoryConfig::default();
		// Future timestamp - should return 1.0 (no boost)
		let boost = compute_working_memory_boost(20000.0, 10000.0, &config);
		assert_eq!(boost, 1.0);
	}

	// Session Decay tests

	#[test]
	fn test_session_decay_recent() {
		let now = 1_000_000.0;
		// 15 minutes ago
		let rate = compute_session_decay_rate(now - 15.0 * 60.0 * 1000.0, now);
		assert_eq!(rate, 0.3);
	}

	#[test]
	fn test_session_decay_hour() {
		let now = 1_000_000.0;
		// 1 hour ago
		let rate = compute_session_decay_rate(now - 60.0 * 60.0 * 1000.0, now);
		assert_eq!(rate, 0.4);
	}

	#[test]
	fn test_session_decay_old() {
		let now = 1_000_000.0;
		// 2 days ago
		let rate = compute_session_decay_rate(now - 48.0 * 60.0 * 60.0 * 1000.0, now);
		assert_eq!(rate, 0.5);
	}

	// Instance Noise tests

	#[test]
	fn test_encoding_strength_base() {
		let config = InstanceNoiseConfig::default();
		// Minimal memory - just base
		let strength = compute_encoding_strength(0.0, 0.0, 0, &config);
		assert!((strength - 0.3).abs() < 0.01);
	}

	#[test]
	fn test_encoding_strength_full() {
		let config = InstanceNoiseConfig::default();
		// Fully attended, emotional, well-rehearsed memory
		let strength = compute_encoding_strength(1.0, 1.0, 10, &config);
		assert!((strength - 1.0).abs() < 0.01);
	}

	#[test]
	fn test_instance_noise_inverse() {
		// Strong encoding = low noise
		let noise_strong = compute_instance_noise(1.0, 0.25);
		let noise_weak = compute_instance_noise(0.3, 0.25);
		assert!(noise_strong < noise_weak);
	}

	// Association Decay tests

	#[test]
	fn test_association_decay_fresh() {
		let config = AssociationDecayConfig::default();
		// Fresh association after 1 hour (= 1 tau)
		let strength = compute_association_decay(1.0, 1.0 / 24.0, AssociationState::Fresh, &config);
		// Should decay to ~0.37 (e^-1)
		assert!((strength - 0.368).abs() < 0.01);
	}

	#[test]
	fn test_association_decay_consolidated() {
		let config = AssociationDecayConfig::default();
		// Consolidated association after 30 days (= 1 tau)
		let strength =
			compute_association_decay(1.0, 30.0, AssociationState::Consolidated, &config);
		// Should decay to ~0.37 (e^-1)
		assert!((strength - 0.368).abs() < 0.01);
	}

	#[test]
	fn test_reinforce_association() {
		let config = AssociationDecayConfig::default();
		let new_strength = reinforce_association(0.5, &config);
		assert_eq!(new_strength, 0.55);
	}

	#[test]
	fn test_reinforce_association_cap() {
		let config = AssociationDecayConfig::default();
		let new_strength = reinforce_association(0.99, &config);
		assert_eq!(new_strength, 1.0);
	}

	#[test]
	fn test_should_prune() {
		let config = AssociationDecayConfig::default();
		assert!(should_prune_association(0.05, &config));
		assert!(!should_prune_association(0.15, &config));
	}

	// Original tests

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
