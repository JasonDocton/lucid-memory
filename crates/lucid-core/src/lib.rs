//! # Lucid Core
//!
//! High-performance memory retrieval engine implementing ACT-R spreading activation
//! and MINERVA 2's reconstructive memory model.
//!
//! ## Why Reconstructive Memory?
//!
//! Most AI memory systems treat memory as storage and retrieval—like a database.
//! But human memory doesn't work that way. Human memory is *reconstructive*:
//!
//! - **Memories evolve over time** - They aren't static records
//! - **Context shapes retrieval** - What surfaces depends on your current state
//! - **Associations matter** - Memories activate related memories
//! - **Details fade, essence persists** - Verbatim decays faster than gist
//!
//! This library implements the computational mechanisms that make this possible.
//!
//! ## Core Concepts
//!
//! ### Activation
//!
//! Every memory has an activation level that determines how likely it is to be
//! retrieved. Activation comes from three sources:
//!
//! 1. **Base-level activation** - Recency and frequency of access
//!    ```text
//!    B(m) = ln[Σ(t_k)^(-d)]
//!    ```
//!
//! 2. **Probe-trace similarity** - How well the current context matches
//!    ```text
//!    A(i) = S(i)³  (MINERVA 2's nonlinear function)
//!    ```
//!
//! 3. **Spreading activation** - Activation from associated memories
//!    ```text
//!    A_j = Σ(W_i/n_i) × S_ij
//!    ```
//!
//! ### Retrieval
//!
//! The retrieval pipeline combines these into a ranked set of candidates:
//!
//! 1. Compute semantic similarity between probe and all memories
//! 2. Apply nonlinear activation (emphasizes strong matches)
//! 3. Compute base-level from access history
//! 4. Spread activation through the association graph
//! 5. Combine, rank, and filter by retrieval probability
//!
//! ## Example
//!
//! ```rust
//! use lucid_core::{
//!     retrieval::{retrieve, RetrievalConfig, RetrievalInput},
//!     spreading::Association,
//! };
//!
//! // Your memory embeddings (from any embedding model)
//! let memories = vec![
//!     vec![1.0, 0.0, 0.0],
//!     vec![0.5, 0.5, 0.0],
//!     vec![0.0, 1.0, 0.0],
//! ];
//!
//! // Probe embedding (what you're looking for)
//! let probe = vec![0.9, 0.1, 0.0];
//!
//! let input = RetrievalInput {
//!     probe_embedding: &probe,
//!     memory_embeddings: &memories,
//!     access_histories_ms: &[vec![1000.0], vec![500.0], vec![100.0]],
//!     emotional_weights: &[0.5, 0.5, 0.5],
//!     decay_rates: &[0.5, 0.5, 0.5],
//!     working_memory_boosts: &[1.0, 1.0, 1.0],  // 1.0 = no boost, up to 2.0
//!     associations: &[],  // Optional: links between memories
//!     current_time_ms: 2000.0,
//! };
//!
//! let config = RetrievalConfig::default();
//! let results = retrieve(&input, &config);
//!
//! // Results are ranked by total activation
//! for candidate in results {
//!     println!(
//!         "Memory {} - activation: {:.3}, probability: {:.3}",
//!         candidate.index,
//!         candidate.total_activation,
//!         candidate.probability
//!     );
//! }
//! ```
//!
//! ## Performance
//!
//! This library is designed for speed because memory should feel like remembering—
//! not like a database query.
//!
//! - Pure Rust implementation
//! - No heap allocations in hot paths where possible
//! - Batch operations for embedding comparisons
//! - Pre-computed norms for similarity calculations
//!
//! ## References
//!
//! - Anderson, J. R. (1983). *The Architecture of Cognition* - ACT-R theory
//! - Hintzman, D. L. (1988). *MINERVA 2: A simulation model of human memory* -
//!   Reconstructive retrieval
//! - Kahana, M. J. (2012). *Foundations of Human Memory* - Memory models

#![warn(missing_docs)]
#![warn(clippy::all)]
#![allow(clippy::needless_return)]

pub mod activation;
pub mod location;
pub mod retrieval;
pub mod spreading;
pub mod visual;

pub use activation::{
	combine_activations,
	// Association Decay
	compute_association_decay,
	compute_base_level,
	// Instance Noise
	compute_encoding_strength,
	compute_instance_noise,
	// Session Decay
	compute_session_decay_rate,
	compute_session_decay_rate_batch,
	// Working Memory
	compute_working_memory_boost,
	compute_working_memory_boost_batch,
	cosine_similarity,
	get_decay_tau,
	nonlinear_activation,
	reinforce_association,
	retrieval_probability,
	should_prune_association,
	ActivationBreakdown,
	ActivationConfig,
	AssociationDecayConfig,
	AssociationState,
	InstanceNoiseConfig,
	WorkingMemoryConfig,
};
pub use retrieval::{retrieve, RetrievalCandidate, RetrievalConfig, RetrievalInput};
pub use spreading::{
	// Temporal Spreading (Episodic Memory)
	compute_temporal_link_strength,
	create_episode_links,
	find_temporal_neighbors,
	spread_activation,
	spread_temporal_activation,
	spread_temporal_activation_multi,
	Association,
	SpreadingConfig,
	SpreadingResult,
	TemporalLink,
	TemporalSpreadingConfig,
	TemporalSpreadingResult,
};

// Location Intuitions (spatial memory)
pub use location::{
	compute_association_strength, compute_batch_decay, compute_decayed_familiarity,
	compute_familiarity, get_associated_locations, infer_activity_type, initial_familiarity,
	is_well_known, spread_location_activation, ActivityInference, ActivityType, InferenceSource,
	LocationAssociation, LocationConfig, LocationIntuition,
};

// Visual Memory
pub use visual::{
	compute_pruning_candidates, compute_tag_strength, prepare_frame_description_prompt,
	prepare_synthesis_prompt, retrieve_visual, select_frames_for_description, should_prune,
	should_tag, ConsolidationState, ConsolidationWindow, EmotionalContext, FrameCandidate,
	FrameDescriptionConfig, FrameDescriptionResult, PruningCandidate, PruningReason, TagReason,
	TranscriptSegment, VisualConfig, VisualConsolidationState, VisualMemory,
	VisualRetrievalCandidate, VisualRetrievalConfig, VisualRetrievalInput, VisualSource, VisualTag,
};

/// Library version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Initialize the library (placeholder for future setup).
#[must_use]
pub const fn init() -> &'static str {
	"lucid-core initialized"
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_basic_retrieval() {
		let memories = vec![
			vec![1.0, 0.0, 0.0],
			vec![0.0, 1.0, 0.0],
			vec![0.0, 0.0, 1.0],
		];
		let probe = vec![1.0, 0.0, 0.0];
		let now = 10000.0;

		let input = RetrievalInput {
			probe_embedding: &probe,
			memory_embeddings: &memories,
			access_histories_ms: &[vec![now - 1000.0], vec![now - 2000.0], vec![now - 3000.0]],
			emotional_weights: &[0.5, 0.5, 0.5],
			decay_rates: &[0.5, 0.5, 0.5],
			working_memory_boosts: &[1.0, 1.0, 1.0],
			associations: &[],
			current_time_ms: now,
		};

		let config = RetrievalConfig {
			min_probability: 0.0,
			..Default::default()
		};

		let results = retrieve(&input, &config);

		// First result should match the probe
		assert!(!results.is_empty());
		assert_eq!(results[0].index, 0);
		assert!(results[0].probe_activation > results[1].probe_activation);
	}
}
