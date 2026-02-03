//! Spreading Activation Example
//!
//! This example demonstrates how memories activate related memories
//! through the association graph. When you think of "coffee," related
//! memories (morning routine, that café, the conversation) get activated too.
//!
//! Run with: `cargo run --example spreading_activation`

use lucid_core::{
	retrieval::{retrieve, RetrievalConfig, RetrievalInput},
	spreading::Association,
};

fn main() {
	println!("=== Spreading Activation ===\n");

	// Five memories forming a connected graph:
	//
	// [0] Coffee morning  ←→  [1] Kitchen routine
	//          ↓                      ↓
	// [2] Paris café     ←→  [3] Conversation with friend
	//          ↓
	// [4] Travel plans
	//
	// When we query for "coffee", activation spreads to related memories

	let memories = vec![
		vec![1.0, 0.0, 0.0, 0.0], // 0: Coffee morning (directly about coffee)
		vec![0.6, 0.5, 0.0, 0.0], // 1: Kitchen routine (related to mornings)
		vec![0.7, 0.0, 0.5, 0.0], // 2: Paris café (coffee + travel)
		vec![0.2, 0.3, 0.0, 0.8], // 3: Conversation (not directly about coffee)
		vec![0.1, 0.0, 0.9, 0.2], // 4: Travel plans (mostly about travel)
	];

	// Query: looking for coffee-related memories
	let probe = vec![1.0, 0.0, 0.0, 0.0];
	let current_time_ms = 1_000_000.0;

	// All accessed at similar times
	let access_histories: Vec<Vec<f64>> = (0..5)
		.map(|i| vec![f64::from(i).mul_add(-100_000.0, current_time_ms)])
		.collect();

	let emotional_weights = vec![0.5, 0.4, 0.8, 0.7, 0.3]; // Paris café is emotionally charged
	let decay_rates = vec![0.5; 5];
	let working_memory_boosts = vec![1.0; 5]; // No WM boost in this example

	// Define the association graph
	let associations = vec![
		// Coffee morning ↔ Kitchen routine (bidirectional, strong)
		Association {
			source: 0,
			target: 1,
			forward_strength: 0.8,
			backward_strength: 0.6,
		},
		// Coffee morning → Paris café (you think of coffee, remember Paris)
		Association {
			source: 0,
			target: 2,
			forward_strength: 0.7,
			backward_strength: 0.5,
		},
		// Kitchen routine → Conversation (mornings remind you of talks)
		Association {
			source: 1,
			target: 3,
			forward_strength: 0.5,
			backward_strength: 0.3,
		},
		// Paris café ↔ Conversation (the café is where you had that talk)
		Association {
			source: 2,
			target: 3,
			forward_strength: 0.9,
			backward_strength: 0.9,
		},
		// Paris café → Travel plans
		Association {
			source: 2,
			target: 4,
			forward_strength: 0.6,
			backward_strength: 0.2,
		},
	];

	let memory_labels = [
		"Coffee morning",
		"Kitchen routine",
		"Paris café",
		"Conversation with friend",
		"Travel plans",
	];

	// First, retrieve WITHOUT spreading activation
	println!("--- Without Spreading Activation ---\n");

	let input_no_spread = RetrievalInput {
		probe_embedding: &probe,
		memory_embeddings: &memories,
		access_histories_ms: &access_histories,
		emotional_weights: &emotional_weights,
		decay_rates: &decay_rates,
		working_memory_boosts: &working_memory_boosts,
		associations: &[], // No associations
		current_time_ms,
	};

	let config_no_spread = RetrievalConfig {
		spreading_depth: 0,
		min_probability: 0.0,
		..Default::default()
	};

	let results_no_spread = retrieve(&input_no_spread, &config_no_spread);

	for candidate in &results_no_spread {
		println!(
			"  {} - activation: {:.3} (probe only: {:.3})",
			memory_labels[candidate.index], candidate.total_activation, candidate.probe_activation
		);
	}

	// Now retrieve WITH spreading activation
	println!("\n--- With Spreading Activation (depth=3) ---\n");

	let input_spread = RetrievalInput {
		probe_embedding: &probe,
		memory_embeddings: &memories,
		access_histories_ms: &access_histories,
		emotional_weights: &emotional_weights,
		decay_rates: &decay_rates,
		working_memory_boosts: &working_memory_boosts,
		associations: &associations,
		current_time_ms,
	};

	let config_spread = RetrievalConfig {
		spreading_depth: 3,
		spreading_decay: 0.7,
		min_probability: 0.0,
		bidirectional: true,
		..Default::default()
	};

	let results_spread = retrieve(&input_spread, &config_spread);

	for candidate in &results_spread {
		println!(
			"  {} - activation: {:.3} (probe: {:.3}, spreading: {:.3})",
			memory_labels[candidate.index],
			candidate.total_activation,
			candidate.probe_activation,
			candidate.spreading
		);
	}

	println!("\n=== What happened? ===\n");
	println!("Without spreading:");
	println!("  - Only 'Coffee morning' strongly activated (direct match)");
	println!("  - 'Paris café' partially activated (has coffee in embedding)");
	println!("  - 'Conversation' barely activated (weak direct match)\n");

	println!("With spreading:");
	println!("  - 'Coffee morning' activates first (direct match)");
	println!("  - Activation spreads to 'Kitchen routine' (connected)");
	println!("  - Activation spreads to 'Paris café' (connected)");
	println!("  - 'Paris café' spreads to 'Conversation' (strongly connected)");
	println!("  - Even 'Travel plans' gets some activation (2 hops away)\n");

	println!("This is why you think of that conversation when you smell coffee—");
	println!("even though the conversation wasn't about coffee at all.");
	println!("The memory is connected through the Paris café where it happened.");
}
