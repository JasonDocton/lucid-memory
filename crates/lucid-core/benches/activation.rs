//! Benchmarks for activation computation
//!
//! Tests performance of:
//! - Base-level activation (ACT-R decay function)
//! - Cosine similarity (batch and single)
//! - Nonlinear activation (MINERVA 2 cubing)
//! - Retrieval probability computation

#![allow(clippy::expect_used)] // Fine in benchmarks

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use lucid_core::activation::{
    compute_base_level, cosine_similarity, nonlinear_activation, retrieval_probability,
    ActivationConfig,
};
use rand::Rng;

/// Generate random embeddings for testing
fn generate_embeddings(count: usize, dimensions: usize) -> Vec<Vec<f64>> {
    let mut rng = rand::thread_rng();
    (0..count)
        .map(|_| {
            let mut vec: Vec<f64> = (0..dimensions).map(|_| rng.gen::<f64>()).collect();
            // Normalize
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

/// Generate realistic access histories
fn generate_access_histories(count: usize, current_time: f64) -> Vec<Vec<f64>> {
    let mut rng = rand::thread_rng();
    (0..count)
        .map(|_| {
            let num_accesses = rng.gen_range(1..20);
            (0..num_accesses)
                .map(|_| (rng.gen::<f64>() * 86_400_000.0).mul_add(-7.0, current_time)) // Up to 7 days ago
                .collect()
        })
        .collect()
}

fn bench_cosine_similarity(c: &mut Criterion) {
    let mut group = c.benchmark_group("cosine_similarity");

    for dim in &[128, 256, 512, 1024, 1536] {
        let embeddings = generate_embeddings(2, *dim);
        let a = &embeddings[0];
        let b = &embeddings[1];

        let _ = group.throughput(Throughput::Elements(1));
        let _ = group.bench_with_input(BenchmarkId::new("single", dim), dim, |bench, _| {
            bench.iter(|| cosine_similarity(black_box(a), black_box(b)));
        });
    }

    group.finish();
}

fn bench_cosine_similarity_batch(c: &mut Criterion) {
    let mut group = c.benchmark_group("cosine_similarity_batch");

    for (memory_count, dim) in &[(100, 1024), (500, 1024), (1000, 1024), (2000, 1024)] {
        let probe = generate_embeddings(1, *dim).pop().expect("should have probe");
        let memories = generate_embeddings(*memory_count, *dim);

        let _ = group.throughput(Throughput::Elements(*memory_count as u64));
        let _ = group.bench_with_input(
            BenchmarkId::new("memories", memory_count),
            memory_count,
            |bench, _| {
                bench.iter(|| {
                    memories
                        .iter()
                        .map(|m| cosine_similarity(black_box(&probe), black_box(m)))
                        .collect::<Vec<_>>()
                });
            },
        );
    }

    group.finish();
}

fn bench_base_level_activation(c: &mut Criterion) {
    let mut group = c.benchmark_group("base_level_activation");
    let current_time = 1_000_000.0;

    for access_count in &[5, 10, 20, 50, 100] {
        let mut rng = rand::thread_rng();
        let access_times: Vec<f64> = (0..*access_count)
            .map(|_| rng.gen::<f64>().mul_add(-86_400_000.0, current_time))
            .collect();

        let _ = group.bench_with_input(
            BenchmarkId::new("accesses", access_count),
            access_count,
            |bench, _| {
                bench.iter(|| {
                    compute_base_level(black_box(&access_times), black_box(current_time), 0.5)
                });
            },
        );
    }

    group.finish();
}

fn bench_nonlinear_activation(c: &mut Criterion) {
    let mut group = c.benchmark_group("nonlinear_activation");

    // Test with various similarity values
    for count in &[100_i32, 500, 1000, 2000] {
        let mut rng = rand::thread_rng();
        let similarities: Vec<f64> = (0..*count).map(|_| rng.gen::<f64>().mul_add(2.0, -1.0)).collect();

        #[allow(clippy::cast_sign_loss)]
        let throughput = *count as u64;
        let _ = group.throughput(Throughput::Elements(throughput));
        let _ = group.bench_with_input(BenchmarkId::new("memories", count), count, |bench, _| {
            bench.iter(|| {
                similarities
                    .iter()
                    .map(|s| nonlinear_activation(black_box(*s)))
                    .collect::<Vec<_>>()
            });
        });
    }

    group.finish();
}

fn bench_retrieval_probability(c: &mut Criterion) {
    let mut group = c.benchmark_group("retrieval_probability");

    for count in &[100_i32, 500, 1000, 2000] {
        let mut rng = rand::thread_rng();
        let activations: Vec<f64> = (0..*count).map(|_| rng.gen::<f64>().mul_add(5.0, -2.0)).collect();

        #[allow(clippy::cast_sign_loss)]
        let throughput = *count as u64;
        let _ = group.throughput(Throughput::Elements(throughput));
        let _ = group.bench_with_input(BenchmarkId::new("candidates", count), count, |bench, _| {
            bench.iter(|| {
                activations
                    .iter()
                    .map(|a| retrieval_probability(black_box(*a), 0.3, 0.1))
                    .collect::<Vec<_>>()
            });
        });
    }

    group.finish();
}

fn bench_full_activation_pipeline(c: &mut Criterion) {
    let mut group = c.benchmark_group("full_activation_pipeline");
    let current_time = 1_000_000.0;

    for count in &[100, 500, 1000, 2000] {
        let dim = 1024;
        let probe = generate_embeddings(1, dim).pop().expect("should have probe");
        let memories = generate_embeddings(*count, dim);
        let access_histories = generate_access_histories(*count, current_time);

        let config = ActivationConfig::default();

        let _ = group.throughput(Throughput::Elements(*count as u64));
        let _ = group.bench_with_input(BenchmarkId::new("memories", count), count, |bench, _| {
            bench.iter(|| {
                memories
                    .iter()
                    .enumerate()
                    .map(|(i, m)| {
                        let similarity = cosine_similarity(&probe, m);
                        let probe_activation = nonlinear_activation(similarity);
                        let base_level = compute_base_level(
                            &access_histories[i],
                            current_time,
                            config.decay_rate,
                        );
                        let total = probe_activation + base_level;
                        retrieval_probability(total, config.activation_threshold, config.noise_parameter)
                    })
                    .collect::<Vec<_>>()
            });
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_cosine_similarity,
    bench_cosine_similarity_batch,
    bench_base_level_activation,
    bench_nonlinear_activation,
    bench_retrieval_probability,
    bench_full_activation_pipeline,
);

criterion_main!(benches);
