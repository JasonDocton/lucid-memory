//! Benchmarks for the full retrieval pipeline
//!
//! Tests end-to-end retrieval performance with:
//! - Various memory counts (100, 500, 1000, 2000)
//! - Various embedding dimensions (512, 1024, 1536)
//! - With and without associations/spreading activation

#![allow(clippy::expect_used)] // Fine in benchmarks

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use lucid_core::{
    retrieval::{retrieve, RetrievalConfig, RetrievalInput},
    spreading::Association,
};
use rand::Rng;

/// Generate normalized random embeddings
fn generate_embeddings(count: usize, dimensions: usize) -> Vec<Vec<f64>> {
    let mut rng = rand::thread_rng();
    (0..count)
        .map(|_| {
            let mut vec: Vec<f64> = (0..dimensions).map(|_| rng.gen::<f64>()).collect();
            let norm: f64 = vec.iter().map(|x| x * x).sum::<f64>().sqrt();
            if norm > 0.0 {
                for x in &mut vec {
                    *x /= norm;
                }
            }
            vec
        })
        .collect()
}

/// Generate realistic access histories (milliseconds)
fn generate_access_histories(count: usize, current_time: f64) -> Vec<Vec<f64>> {
    let mut rng = rand::thread_rng();
    (0..count)
        .map(|_| {
            let num_accesses = rng.gen_range(1..15);
            (0..num_accesses)
                .map(|_| (rng.gen::<f64>() * 86_400_000.0).mul_add(-7.0, current_time)) // Up to 7 days ago
                .collect()
        })
        .collect()
}

/// Generate random associations between memories
fn generate_associations(memory_count: usize, association_count: usize) -> Vec<Association> {
    let mut rng = rand::thread_rng();
    (0..association_count)
        .map(|_| Association {
            source: rng.gen_range(0..memory_count),
            target: rng.gen_range(0..memory_count),
            forward_strength: rng.gen::<f64>().mul_add(0.8, 0.1),
            backward_strength: rng.gen::<f64>() * 0.4,
        })
        .filter(|a| a.source != a.target)
        .collect()
}

fn bench_retrieval_no_spreading(c: &mut Criterion) {
    let mut group = c.benchmark_group("retrieval_no_spreading");
    let current_time = 1_000_000_000.0; // ~Jan 12, 1970 in ms (reasonable value)
    let dim = 1024;

    for memory_count in &[100, 500, 1000, 2000] {
        let probe = generate_embeddings(1, dim).pop().expect("should have probe");
        let memories = generate_embeddings(*memory_count, dim);
        let access_histories = generate_access_histories(*memory_count, current_time);
        let emotional_weights: Vec<f64> = (0..*memory_count).map(|_| 0.5).collect();
        let decay_rates: Vec<f64> = (0..*memory_count).map(|_| 0.5).collect();

        let config = RetrievalConfig {
            spreading_depth: 0, // No spreading
            ..Default::default()
        };

        let _ = group.throughput(Throughput::Elements(*memory_count as u64));
        let _ = group.bench_with_input(
            BenchmarkId::new("memories", memory_count),
            memory_count,
            |bench, _| {
                let input = RetrievalInput {
                    probe_embedding: &probe,
                    memory_embeddings: &memories,
                    access_histories_ms: &access_histories,
                    emotional_weights: &emotional_weights,
                    decay_rates: &decay_rates,
                    associations: &[],
                    current_time_ms: current_time,
                };
                bench.iter(|| retrieve(black_box(&input), black_box(&config)));
            },
        );
    }

    group.finish();
}

fn bench_retrieval_with_spreading(c: &mut Criterion) {
    let mut group = c.benchmark_group("retrieval_with_spreading");
    let current_time = 1_000_000_000.0;
    let dim = 1024;

    for memory_count in &[100, 500, 1000, 2000] {
        let probe = generate_embeddings(1, dim).pop().expect("should have probe");
        let memories = generate_embeddings(*memory_count, dim);
        let access_histories = generate_access_histories(*memory_count, current_time);
        let emotional_weights: Vec<f64> = (0..*memory_count).map(|_| 0.5).collect();
        let decay_rates: Vec<f64> = (0..*memory_count).map(|_| 0.5).collect();
        // Create ~10% of memory count as associations
        let associations = generate_associations(*memory_count, *memory_count / 10);

        let config = RetrievalConfig {
            spreading_depth: 3,
            spreading_decay: 0.7,
            bidirectional: true,
            ..Default::default()
        };

        let _ = group.throughput(Throughput::Elements(*memory_count as u64));
        let _ = group.bench_with_input(
            BenchmarkId::new("memories", memory_count),
            memory_count,
            |bench, _| {
                let input = RetrievalInput {
                    probe_embedding: &probe,
                    memory_embeddings: &memories,
                    access_histories_ms: &access_histories,
                    emotional_weights: &emotional_weights,
                    decay_rates: &decay_rates,
                    associations: &associations,
                    current_time_ms: current_time,
                };
                bench.iter(|| retrieve(black_box(&input), black_box(&config)));
            },
        );
    }

    group.finish();
}

fn bench_retrieval_varying_dimensions(c: &mut Criterion) {
    let mut group = c.benchmark_group("retrieval_dimensions");
    let current_time = 1_000_000_000.0;
    let memory_count = 1000;

    for dim in &[256, 512, 1024, 1536, 3072] {
        let probe = generate_embeddings(1, *dim).pop().expect("should have probe");
        let memories = generate_embeddings(memory_count, *dim);
        let access_histories = generate_access_histories(memory_count, current_time);
        let emotional_weights: Vec<f64> = (0..memory_count).map(|_| 0.5).collect();
        let decay_rates: Vec<f64> = (0..memory_count).map(|_| 0.5).collect();

        let config = RetrievalConfig::default();

        let _ = group.throughput(Throughput::Elements(memory_count as u64));
        let _ = group.bench_with_input(BenchmarkId::new("dim", dim), dim, |bench, _| {
            let input = RetrievalInput {
                probe_embedding: &probe,
                memory_embeddings: &memories,
                access_histories_ms: &access_histories,
                emotional_weights: &emotional_weights,
                decay_rates: &decay_rates,
                associations: &[],
                current_time_ms: current_time,
            };
            bench.iter(|| retrieve(black_box(&input), black_box(&config)));
        });
    }

    group.finish();
}

fn bench_retrieval_varying_association_density(c: &mut Criterion) {
    let mut group = c.benchmark_group("retrieval_association_density");
    let current_time = 1_000_000_000.0;
    let dim = 1024;
    let memory_count = 1000;

    let probe = generate_embeddings(1, dim).pop().expect("should have probe");
    let memories = generate_embeddings(memory_count, dim);
    let access_histories = generate_access_histories(memory_count, current_time);
    let emotional_weights: Vec<f64> = (0..memory_count).map(|_| 0.5).collect();
    let decay_rates: Vec<f64> = (0..memory_count).map(|_| 0.5).collect();

    for density_pct in &[0, 5, 10, 20, 50] {
        let association_count = memory_count * density_pct / 100;
        let associations = generate_associations(memory_count, association_count);

        let config = RetrievalConfig {
            spreading_depth: 3,
            spreading_decay: 0.7,
            ..Default::default()
        };

        let _ = group.bench_with_input(
            BenchmarkId::new("density_pct", density_pct),
            density_pct,
            |bench, _| {
                let input = RetrievalInput {
                    probe_embedding: &probe,
                    memory_embeddings: &memories,
                    access_histories_ms: &access_histories,
                    emotional_weights: &emotional_weights,
                    decay_rates: &decay_rates,
                    associations: &associations,
                    current_time_ms: current_time,
                };
                bench.iter(|| retrieve(black_box(&input), black_box(&config)));
            },
        );
    }

    group.finish();
}

fn bench_retrieval_spreading_depth(c: &mut Criterion) {
    let mut group = c.benchmark_group("retrieval_spreading_depth");
    let current_time = 1_000_000_000.0;
    let dim = 1024;
    let memory_count = 1000;

    let probe = generate_embeddings(1, dim).pop().expect("should have probe");
    let memories = generate_embeddings(memory_count, dim);
    let access_histories = generate_access_histories(memory_count, current_time);
    let emotional_weights: Vec<f64> = (0..memory_count).map(|_| 0.5).collect();
    let decay_rates: Vec<f64> = (0..memory_count).map(|_| 0.5).collect();
    let associations = generate_associations(memory_count, memory_count / 10);

    for depth in &[0, 1, 2, 3, 5] {
        let config = RetrievalConfig {
            spreading_depth: *depth,
            spreading_decay: 0.7,
            ..Default::default()
        };

        let _ = group.bench_with_input(BenchmarkId::new("depth", depth), depth, |bench, _| {
            let input = RetrievalInput {
                probe_embedding: &probe,
                memory_embeddings: &memories,
                access_histories_ms: &access_histories,
                emotional_weights: &emotional_weights,
                decay_rates: &decay_rates,
                associations: &associations,
                current_time_ms: current_time,
            };
            bench.iter(|| retrieve(black_box(&input), black_box(&config)));
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_retrieval_no_spreading,
    bench_retrieval_with_spreading,
    bench_retrieval_varying_dimensions,
    bench_retrieval_varying_association_density,
    bench_retrieval_spreading_depth,
);

criterion_main!(benches);
