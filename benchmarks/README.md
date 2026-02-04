# Benchmarks

Quality and performance benchmarks for lucid-memory's cognitive retrieval system.

These benchmarks are **not** included in the installer bundle.

## Quick Start

```bash
# Run all benchmarks
bun run bench

# Run only quality benchmarks (naive vs cognitive comparison)
bun run bench:quality

# Verbose output showing rankings
bun run benchmarks/quality/index.ts --verbose

# Run only Rust performance benchmarks
bun run bench:rust
```

## Quality Benchmarks

Compares retrieval **quality** (not just speed) between:

- **Naive**: cosine similarity → top-k
- **Cognitive**: cosine sim → MINERVA 2 → base-level → spreading → combined

### Metrics

- **NDCG@k**: Normalized Discounted Cumulative Gain (primary metric)
- **MRR**: Mean Reciprocal Rank
- **Precision@k**: Fraction of top-k results that are relevant

### Test Cases

| Test | What it measures |
|------|------------------|
| `recency_tiebreaker` | Recent access breaks ties between identical memories |
| `frequency_over_similarity` | Frequently accessed beats slightly-more-similar |
| `emotional_boost` | Emotionally significant memories rank higher |
| `spreading_surfaces_related` | Associated memories surface via spreading activation |
| `combined_signals` | Multiple weak signals beat single strong signal |
| `working_memory_recent` | Very recent access (working memory) boosts ranking |

### Expected Results

Cognitive retrieval should outperform naive on most test cases. Current results:

```
Cognitive wins: 3/6
Naive wins:     0/6
Ties:           3/6

Cognitive improvement: +11.4% NDCG
MRR: 1.000 (perfect)
```

## Performance Benchmarks (Rust)

Located in `crates/lucid-core/benches/`. Tests:

- Cosine similarity (single and batch)
- Base-level activation computation
- Nonlinear activation (MINERVA 2 cubing)
- Full retrieval pipeline with/without spreading
- Various memory counts and embedding dimensions

Run with:

```bash
cargo bench -p lucid-core
```

## Adding New Benchmarks

1. Create new test cases in `benchmarks/quality/index.ts`
2. Each case needs:
   - `probe`: query embedding
   - `memories`: array with embeddings, access history, emotional weight, expected rank
   - `associations`: optional association graph for spreading activation tests
