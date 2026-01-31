# Lucid Memory

**2.7ms retrieval. 743,000 memories/second. $0/query.**

Memory for AI that actually works like memory—local, fast, and cognitive.

<div align="center">

```bash
curl -fsSL lucidmemory.dev/install | bash
```

<sub>Works with Claude Code · macOS & Linux · <a href="#windows">Windows instructions</a></sub>

<br><br>
<b>New in 0.2.0:</b> <a href="#location-intuitions">Location Intuitions</a> — Claude now builds spatial memory of your codebase, navigating familiar files without searching.

</div>

---

## 100x Faster Than Cloud RAG

| System | Latency | Cost |
| ------ | ------- | ---- |
| **Lucid Memory** | **2.7ms** | **$0/query** |
| Pinecone | 10-50ms | $70+/month |
| Weaviate | 15-40ms | Self-host costs |
| OpenAI + Pinecone | 200-500ms | ~$0.13/1M tokens + Pinecone |
| LangChain RAG | 300-800ms | API costs compound |

<details>
<summary><b>Full benchmark data</b></summary>

Measured on M-series Mac with 1024-dimensional embeddings:

| Memories | Retrieval Time | Throughput |
| -------- | -------------- | ---------- |
| 100      | 0.13ms         | 769k mem/s |
| 1,000    | 1.35ms         | 741k mem/s |
| 2,000    | 2.69ms         | 743k mem/s |
| 10,000   | ~13ms          | ~740k mem/s |

Spreading activation (depth 3) adds <0.1ms overhead.

</details>

### Why so fast?

1. **No network round-trips** — Everything runs locally
2. **No embedding at query time** — Embeddings are pre-computed
3. **Cognitive ranking > reranking** — One pass, not retrieve-then-rerank
4. **Rust core** — Zero interpreter overhead

---

## Before & After

**Without Lucid:**
```
User: "Remember that bug we fixed in the auth module?"
Claude: "I don't have context from previous conversations..."
```

**With Lucid:**
```
User: "Remember that bug we fixed in the auth module?"
Claude: "Yes - the race condition in the session refresh. We fixed it
by adding a mutex around the token update. That was three weeks ago
when we were refactoring the middleware."
```

---

## Install in 60 Seconds

**macOS / Linux:**
```bash
curl -fsSL lucidmemory.dev/install | bash
```

<h4 id="windows">Windows (PowerShell as Administrator):</h4>

```powershell
irm lucidmemory.dev/install.ps1 | iex
```

That's it. Claude Code now remembers across sessions.

<details>
<summary>What the installer does</summary>

1. Checks prerequisites (git, disk space)
2. Installs Bun runtime if needed
3. Sets up Ollama for local embeddings (or OpenAI API)
4. Configures Claude Code MCP settings
5. Installs hooks for automatic memory capture
6. Restarts Claude Code to activate

**Requirements:** 5GB free disk space, Claude Code installed

</details>

---

## How It Works

Most AI memory is just vector search—embed query, find similar docs, paste into context.

Lucid implements how humans actually remember:

| Aspect | Traditional RAG | Lucid Memory |
| ------ | --------------- | ------------ |
| Model | Database lookup | Cognitive simulation |
| Memory | Static records | Living, evolving traces |
| Retrieval | Similarity search | Activation competition |
| Context | Ignored | Shapes what surfaces |
| Time | Flat | Recent/frequent = stronger |
| Associations | None | Memories activate each other |

<h3 id="location-intuitions">Location Intuitions</h3>

**New in 0.2:** Claude now builds spatial memory of your codebase.

After working in a project, Claude develops *intuitions* about file locations—not through explicit memorization, but through repeated exposure, just like you know where your kitchen is without thinking about it.

| Without Location Intuitions | With Location Intuitions |
| --------------------------- | ------------------------ |
| Claude searches for files every time | Claude navigates directly to familiar files |
| "Let me search for the auth handler..." | "I know auth is in `src/auth/handler.ts`..." |
| Each session starts from zero | Familiarity persists across sessions |

**How it works:**

- **Familiarity grows asymptotically** — First access: low familiarity. 10th access: high familiarity. 100th access: not much higher (diminishing returns, like real learning)
- **Context is bound to location** — Claude remembers *what you were doing* when you touched each file (debugging? refactoring? reading?)
- **Related files link together** — Files worked on for the same task form associative networks
- **Unused knowledge fades** — Files not accessed in 30+ days gradually decay (but well-known files have "sticky" floors)

<details>
<summary><b>The neuroscience</b></summary>

Location Intuitions are modeled on three brain systems:

**Hippocampal Place Cells** (O'Keefe & Nadel, 1978)
- Neurons that fire when you're in a specific location
- Familiarity increases with repeated exposure
- Our implementation: `familiarity = 1 - 1/(1 + 0.1n)` where n = access count

**Entorhinal Cortex** (Moser et al., 2008)
- Binds context to spatial memory — *where* + *what you were doing*
- We track activity type (reading, writing, debugging) bound to each file access

**Procedural Memory** (Squire, 1992)
- "Knowing how" vs "knowing that" — you don't consciously recall how to ride a bike
- Direct file access (without searching) indicates procedural knowledge
- We track `searchesSaved` as a signal of true familiarity

**Associative Networks** (Hebb, 1949)
- "Neurons that fire together wire together"
- Files accessed for the same task form bidirectional associations
- Shared task context creates strong links; temporal proximity creates weaker links

</details>

---

### The Science

Built on two foundational cognitive models:

**ACT-R** (Anderson, 1983) — Memories compete for retrieval based on activation:
- Base-level activation from recency and frequency
- Spreading activation through associations
- Retrieval probability from activation strength

**MINERVA 2** (Hintzman, 1988) — Reconstructive retrieval:
- Probe-trace similarity with nonlinear activation (cubing)
- Strong matches dominate, weak matches contribute minimally
- Pattern completion from partial cues

<details>
<summary><b>Technical details</b></summary>

### Three Sources of Activation

Every memory's retrieval probability comes from:

**1. Base-Level (Recency & Frequency)**
```
B(m) = ln[Σ(t_k)^(-d)]
```
Recent and frequent access = higher activation.

**2. Probe-Trace Similarity**
```
A(i) = S(i)³
```
MINERVA 2's cubic function emphasizes strong matches.

**3. Spreading Activation**
```
A_j = Σ(W_i / n_i) × S_ij
```
Activation flows through the association graph.

### The Pipeline

1. Compute similarities between probe and all traces
2. Apply nonlinear activation (cubing)
3. Compute base-level from access history
4. Spread activation through associations
5. Combine, rank, and filter by probability

</details>

---

## For Developers

Want to embed the retrieval engine in your own project?

```rust
use lucid_core::{
    retrieval::{retrieve, RetrievalConfig, RetrievalInput},
    spreading::Association,
};

let input = RetrievalInput {
    probe_embedding: &probe,
    memory_embeddings: &memories,
    access_histories_ms: &histories,
    emotional_weights: &weights,
    decay_rates: &decays,
    associations: &[],
    current_time_ms: now,
};

let results = retrieve(&input, &RetrievalConfig::default());
```

<details>
<summary><b>Full API example</b></summary>

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
    associations: &[],
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

</details>

<details>
<summary><b>Configuration options</b></summary>

```rust
let config = RetrievalConfig {
    decay_rate: 0.5,           // Base-level decay (0.5 = human-like)
    activation_threshold: 0.3,  // Retrieval threshold
    noise_parameter: 0.1,       // Randomness (higher = more random)
    spreading_depth: 3,         // Association traversal depth
    spreading_decay: 0.7,       // Decay per hop
    min_probability: 0.1,       // Filter threshold
    max_results: 10,            // Result limit
    bidirectional: true,        // Spread both directions
};
```

</details>

<details>
<summary><b>Associations</b></summary>

Link memories to enable spreading activation:

```rust
use lucid_core::spreading::Association;

let associations = vec![
    Association {
        source: 0,
        target: 1,
        forward_strength: 0.8,   // Source → Target
        backward_strength: 0.3,  // Target → Source
    },
];
```

When memory 0 activates, memory 1 receives proportional activation.

</details>

---

## References

### Memory & Retrieval
- Anderson, J. R. (1983). *The Architecture of Cognition*
- Anderson, J. R., & Lebiere, C. (1998). *The Atomic Components of Thought*
- Hintzman, D. L. (1988). Judgments of frequency and recognition memory in a multiple-trace memory model. *Psychological Review*, 95(4), 528-551.
- Kahana, M. J. (2012). *Foundations of Human Memory*

### Spatial Memory & Location Intuitions
- O'Keefe, J., & Nadel, L. (1978). *The Hippocampus as a Cognitive Map*
- Moser, E. I., Kropff, E., & Moser, M. B. (2008). Place cells, grid cells, and the brain's spatial representation system. *Annual Review of Neuroscience*, 31, 69-89.
- Squire, L. R. (1992). Memory and the hippocampus: A synthesis from findings with rats, monkeys, and humans. *Psychological Review*, 99(2), 195-231.
- Hebb, D. O. (1949). *The Organization of Behavior*

## License

GPL-3.0 — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built for AI systems that need memory with meaning, not just storage with retrieval.</sub>
</p>
