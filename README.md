# Lucid Memory

**Memory that remembers like you do.**

High-performance reconstructive memory retrieval for AI systems, implementing ACT-R spreading activation and MINERVA 2's cognitive architecture.

## Why Reconstructive Memory?

Most AI memory systems treat memory as storage and retrieval—like a database. You store facts, you query facts, you get facts back.

But human memory doesn't work that way. Human memory is *reconstructive*:

- **Memories evolve over time** — They aren't static records
- **Context shapes retrieval** — What surfaces depends on your current state
- **Associations matter** — Activating one memory activates related memories
- **Details fade, essence persists** — Verbatim decays faster than gist

This library implements the computational mechanisms that make reconstructive memory possible.

### The Problem with RAG

Retrieval-Augmented Generation (RAG) treats memory like a search engine: embed your query, find similar documents, paste them into context. This works for facts but fails for identity:

| Aspect | RAG | Reconstructive Memory |
|--------|-----|----------------------|
| Model | Database lookup | Cognitive simulation |
| Memory | Static records | Living, evolving traces |
| Retrieval | Similarity search | Activation competition |
| Context | Ignored | Shapes what surfaces |
| Time | Flat | Recent/frequent = stronger |
| Associations | None | Memories activate each other |

## Installation

### Quick Start (for Claude Code users)

Install once. Claude Code remembers forever.

```bash
curl -fsSL https://raw.githubusercontent.com/JasonDocton/lucid-memory/main/install.sh | bash
```

The wizard will:
1. Download the lucid-memory binary
2. Prompt for embedding preference (local Ollama vs API)
3. Auto-detect existing MCP config
4. Configure Claude Code to use lucid-memory
5. Create the memory database in `~/.lucid/`

**Time to value:** Under 2 minutes. No manual configuration required.

### Manual Installation (for developers)

If you want to embed the retrieval engine in your own project:

```bash
cargo add lucid-core
```

## Usage

### As a Claude Code User

After installation, just use Claude Code normally. Behind the scenes:
- Every conversation is captured via hooks
- Important learnings are extracted and stored
- When Claude needs context, relevant memories surface automatically
- Compaction no longer means losing knowledge

**Before Lucid:**
```
User: "Remember that bug we fixed in the auth module?"
Claude: "I don't have context from previous conversations..."
```

**After Lucid:**
```
User: "Remember that bug we fixed in the auth module?"
Claude: "Yes - the race condition in the session refresh. We fixed it
by adding a mutex around the token update. That was three weeks ago
when we were refactoring the middleware."
```

### As a Developer (using lucid-core)

```rust
use lucid_core::{
    retrieval::{retrieve, RetrievalConfig, RetrievalInput},
    spreading::Association,
};

// Your memory embeddings (from any embedding model)
let memories = vec![
    vec![1.0, 0.0, 0.0],  // Memory 0
    vec![0.5, 0.5, 0.0],  // Memory 1
    vec![0.0, 1.0, 0.0],  // Memory 2
];

// What you're looking for
let probe = vec![0.9, 0.1, 0.0];

let input = RetrievalInput {
    probe_embedding: &probe,
    memory_embeddings: &memories,
    access_histories_ms: &[vec![1000.0], vec![500.0], vec![100.0]],
    emotional_weights: &[0.5, 0.5, 0.5],
    decay_rates: &[0.5, 0.5, 0.5],
    associations: &[],  // Links between memories
    current_time_ms: 2000.0,
};

let config = RetrievalConfig::default();
let results = retrieve(&input, &config);

for candidate in results {
    println!(
        "Memory {} - activation: {:.3}, probability: {:.3}",
        candidate.index,
        candidate.total_activation,
        candidate.probability
    );
}
```

## Core Concepts

### Three Sources of Activation

Every memory has an activation level that determines how likely it is to be retrieved. Activation comes from three sources:

#### 1. Base-Level Activation (Recency & Frequency)

```
B(m) = ln[Σ(t_k)^(-d)]
```

Each time you access a memory, it gets stronger. Recent accesses count more than old ones. This is why you remember what you had for breakfast today but not last Tuesday.

#### 2. Probe-Trace Similarity (Relevance)

```
A(i) = S(i)³
```

How well does the current context match the memory? MINERVA 2's nonlinear function (cubing) ensures weakly matching memories contribute minimally while strong matches dominate. This enables pattern completion from partial cues.

#### 3. Spreading Activation (Associations)

```
A_j = Σ(W_i / n_i) × S_ij
```

Memories don't exist in isolation. When you think of "coffee," related memories (morning routine, that café in Paris, the conversation you had there) get activated too. Activation spreads through the association graph, decaying with distance.

### The Retrieval Pipeline

1. **Compute similarities** between probe and all memory traces
2. **Apply nonlinear activation** (MINERVA 2's cubic function)
3. **Compute base-level** from access history
4. **Spread activation** through association graph
5. **Combine, rank, and filter** by retrieval probability

## Configuration

```rust
let config = RetrievalConfig {
    // Base-level decay rate (0.5 = human-like)
    decay_rate: 0.5,

    // Activation threshold for retrieval
    activation_threshold: 0.3,

    // Noise parameter (higher = more random)
    noise_parameter: 0.1,

    // How deep to spread through associations
    spreading_depth: 3,

    // Decay per hop in spreading
    spreading_decay: 0.7,

    // Minimum probability to include in results
    min_probability: 0.1,

    // Maximum results to return
    max_results: 10,

    // Spread in both directions
    bidirectional: true,
};
```

## Associations

Link memories together to enable spreading activation:

```rust
use lucid_core::spreading::Association;

let associations = vec![
    Association {
        source: 0,  // Memory index
        target: 1,  // Memory index
        forward_strength: 0.8,  // Source → Target
        backward_strength: 0.3,  // Target → Source
    },
];
```

When memory 0 activates, memory 1 receives activation proportional to the connection strength.

## Performance

This library is designed for speed because memory should feel like remembering—not like a database query.

- **Pure Rust** — No runtime overhead
- **Zero-copy where possible** — Borrows instead of clones
- **Batch operations** — Vectorized similarity computation
- **Pre-computed norms** — Cached for repeated queries

Benchmarks (M-series Mac, 2000 memories, 1024-dim embeddings):

| Operation | Time |
|-----------|------|
| Similarity batch | ~5ms |
| Full retrieval pipeline | ~15ms |
| With spreading (depth 3) | ~20ms |

## Theory

### ACT-R (Adaptive Control of Thought—Rational)

ACT-R models human cognition as activation-based retrieval. Memories compete for retrieval based on their activation levels. The mathematical formulation predicts both what will be retrieved and how long it will take.

Key insight: Memory is not about storage capacity but retrieval competition.

### MINERVA 2

Hintzman's MINERVA 2 model treats memory as a collection of traces. Retrieval involves:

1. Present a probe
2. Compute similarity to all traces
3. Apply nonlinear activation (cubing)
4. The "echo" emerges from the weighted sum

The cubing is crucial—it ensures that only strongly matching traces contribute to the echo. This enables pattern completion and explains why partial cues can retrieve complete memories.

## References

- Anderson, J. R. (1983). *The Architecture of Cognition*
- Anderson, J. R., & Lebiere, C. (1998). *The Atomic Components of Thought*
- Hintzman, D. L. (1988). Judgments of frequency and recognition memory in a multiple-trace memory model. *Psychological Review*, 95(4), 528-551.
- Kahana, M. J. (2012). *Foundations of Human Memory*

## License

MIT License - see [LICENSE](LICENSE) for details.

---

*Built for AI systems that need memory with meaning, not just storage with retrieval.*
