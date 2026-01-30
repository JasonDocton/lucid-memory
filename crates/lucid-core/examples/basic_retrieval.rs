//! Basic Memory Retrieval Example
//!
//! This example demonstrates the core retrieval pipeline:
//! 1. Create some memories with embeddings
//! 2. Query with a probe
//! 3. Get ranked results based on activation
//!
//! Run with: `cargo run --example basic_retrieval`

use lucid_core::{
    retrieval::{retrieve, RetrievalConfig, RetrievalInput},
    spreading::Association,
};

fn main() {
    println!("=== Basic Memory Retrieval ===\n");

    // Simulate three memories about different topics
    // In practice, these would be embeddings from an embedding model
    let memories = vec![
        vec![1.0, 0.2, 0.1, 0.0],  // Memory 0: strongly about topic A
        vec![0.3, 0.9, 0.2, 0.1],  // Memory 1: strongly about topic B
        vec![0.1, 0.2, 0.8, 0.3],  // Memory 2: strongly about topic C
        vec![0.5, 0.4, 0.3, 0.2],  // Memory 3: mixed topics
    ];

    // Query embedding - looking for something about topic A
    let probe = vec![0.9, 0.1, 0.0, 0.0];

    // Current time: 1 hour after noon
    let current_time_ms = 3_600_000.0;

    // Access histories - when each memory was accessed
    // Memory 0 was accessed recently (30 min ago)
    // Memory 1 was accessed less recently (45 min ago)
    // Memory 2 was accessed even less recently (1 hour ago)
    // Memory 3 was accessed most recently (15 min ago)
    let access_histories = vec![
        vec![current_time_ms - 1_800_000.0],  // 30 min ago
        vec![current_time_ms - 2_700_000.0],  // 45 min ago
        vec![current_time_ms - 3_600_000.0],  // 1 hour ago
        vec![current_time_ms - 900_000.0],    // 15 min ago
    ];

    // Emotional weights (0-1) - higher means more emotionally significant
    let emotional_weights = vec![0.7, 0.3, 0.5, 0.4];

    // Decay rates - lower means memory fades slower
    let decay_rates = vec![0.5, 0.5, 0.5, 0.5];

    // No associations in this basic example
    let associations: Vec<Association> = vec![];

    // Build input
    let input = RetrievalInput {
        probe_embedding: &probe,
        memory_embeddings: &memories,
        access_histories_ms: &access_histories,
        emotional_weights: &emotional_weights,
        decay_rates: &decay_rates,
        associations: &associations,
        current_time_ms,
    };

    // Use default config
    let config = RetrievalConfig {
        min_probability: 0.0, // Show all results for demo
        ..Default::default()
    };

    // Retrieve!
    let results = retrieve(&input, &config);

    println!("Query: topic A (embedding: {probe:?})\n");
    println!("Results (ranked by total activation):\n");

    for (rank, candidate) in results.iter().enumerate() {
        println!("#{} - Memory {}", rank + 1, candidate.index);
        println!("  Total Activation: {:.4}", candidate.total_activation);
        println!("  Components:");
        println!("    Base Level (recency): {:.4}", candidate.base_level);
        println!("    Probe Match (similarity³): {:.4}", candidate.probe_activation);
        println!("    Spreading: {:.4}", candidate.spreading);
        println!("    Emotional Weight: {:.2}", candidate.emotional_weight);
        println!("  Retrieval Probability: {:.1}%", candidate.probability * 100.0);
        println!("  Estimated Latency: {:.0}ms", candidate.latency_ms);
        println!();
    }

    // Explain the results
    println!("=== Why these results? ===\n");
    println!("Memory 0 ranks first because:");
    println!("  - Highest probe similarity (it's about topic A)");
    println!("  - High emotional weight (0.7)");
    println!("  - Recent access (30 min ago)\n");

    println!("Memory 3 ranks second because:");
    println!("  - Medium probe similarity (mixed topics)");
    println!("  - Most recent access (15 min ago)");
    println!("  - Recency boosts activation\n");

    println!("Memories 1 and 2 rank lower because:");
    println!("  - Low probe similarity (not about topic A)");
    println!("  - Older access times");
    println!("  - The cubed similarity function suppresses weak matches");
}
