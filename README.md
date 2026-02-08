# Lucid Memory

**2.7ms retrieval. 743,000 memories/second. $0/query.**

Memory for AI that works like yours—local, instant, persistent.

```bash
curl -fsSL https://lucidmemory.dev/install | bash
```

<div align="center">
<sub>Works with Claude Code & OpenAI Codex · macOS & Linux · <a href="#windows">Windows instructions</a></sub>
<br><br>
</div>

**New in 0.5.0:** <a href="#episodic-memory">Episodic Memory</a> — Claude remembers not just what happened, but how it unfolded — reconstructing the story of your debugging session, not just the fix. "What was I working on before the auth refactor?" now has an answer.

**New in 0.4.0:** <a href="#location-intuitions">Procedural Memory</a> — Claude learns your workflow, develops instincts, and creates muscle memory for actions. No more searching or directing Claude to common file locations - it just knows.

---

## Why Lucid Memory?

**We're not a vector database. We're the retrieval layer that makes vector databases obsolete for AI memory.**

Pinecone stores vectors. We understand context.

<table>
<tr>
<th></th>
<th>Lucid Memory</th>
<th>Claude-mem</th>
<th>Pinecone RAG</th>
<th>Traditional RAG</th>
</tr>
<tr>
<td><b>Retrieval Speed</b></td>
<td>✅ <b>2.7ms</b></td>
<td>~50ms</td>
<td>10-50ms</td>
<td>200-800ms</td>
</tr>
<tr>
<td><b>Token Efficiency</b></td>
<td>✅ <b>5x</b></td>
<td>1x (baseline)</td>
<td>2.5x</td>
<td>~2x</td>
</tr>
<tr>
<td><b>Recall @ Fixed Budget</b></td>
<td>✅ <b>82.5%</b></td>
<td>28.9%</td>
<td>55.3%</td>
<td>~50%</td>
</tr>
<tr>
<td><b>Storage Compression</b></td>
<td>✅ <b>5x (80% smaller)</b></td>
<td>1x</td>
<td>1x</td>
<td>1x</td>
</tr>
<tr>
<td><b>Query Cost</b></td>
<td>✅ <b>$0</b></td>
<td>$0</td>
<td>$70+/month</td>
<td>API costs</td>
</tr>
<tr>
<td><b>Recency vs Relevance</b></td>
<td>✅ <b>Multiplicative (relevance wins)</b></td>
<td>Binary 90-day filter</td>
<td>No recency</td>
<td>No recency</td>
</tr>
<tr>
<td><b>Associative Retrieval</b></td>
<td>✅ <b>3-hop spreading activation</b></td>
<td>None</td>
<td>None</td>
<td>None</td>
</tr>
</table>

<sub>Benchmarked on realistic developer workflows (50-200 memories). Full methodology: <code>bun run bench:realistic && bun run bench:tokens</code></sub>

---

### vs Pinecone ($750M+ valuation)

| | Lucid Memory | Pinecone |
|---|---|---|
| **Token efficiency** | 5x | 2.5x |
| **Recall** | 82.5% | 55.3% |
| **Latency** | 2.7ms | 10-50ms |
| **Monthly cost** | $0 | $70+ |
| **Your data** | Stays on your machine | Sent to cloud |
| **Recency awareness** | Yes (multiplicative) | No |
| **Associative retrieval** | Yes (spreading activation) | No |

Pinecone is a great vector database. But vector search isn't memory.

Lucid Memory retrieves **50% more relevant context** (82.5% vs 55.3% recall), runs **10-20x faster** (local vs cloud), costs **nothing**, and keeps your code **private**—all while understanding that what you accessed yesterday matters more than what you accessed last year.

---

### The Numbers

**5x more relevant context** per token than claude-mem. **2x more** than Pinecone. Same budget, 5x more useful memories.

**82.5% recall** vs 28.9% (claude-mem) and 55.3% (Pinecone) at equivalent token budgets. More of what you need surfaces.

**100% on adversarial recency tests**. Recent-but-irrelevant never beats old-but-relevant—unlike systems where recency overwhelms similarity.

<details>
<summary><b>Full benchmark data</b></summary>

**Realistic Developer Workflow Benchmarks:**

| Scenario | Lucid Memory | RAG Baseline | Delta |
| -------- | ------------ | ------------ | ----- |
| Morning context restoration | 93.3% | 78.3% | +15.0% |
| Needle in haystack (200 memories) | 100% | 100% | — |
| Recency vs similarity tradeoff | 100% | 100% | — |
| Co-edited files (spreading activation) | 100% | 75% | +25.0% |
| Cold start (no history) | 100% | 100% | — |
| Adversarial recency trap | 100% | 100% | — |
| Long-term decay | 100% | 100% | — |
| Episode retrieval (0.5.0) | 80% | 0% | +80.0% |
| Weak encoding retrieval | 100% | 60% | +40.0% |
| **Overall** | **87.3%** | **71.3%** | **+16.0%** |

*Note: RAG ties on adversarial tests because it ignores recency entirely. The test validates Lucid's recency handling doesn't break relevance—and it doesn't.*

**Token Efficiency (at 300 token budget):**

| Metric | Lucid Memory | Claude-mem | Pinecone RAG |
| ------ | ------------ | ---------- | ------------ |
| Memories retrieved | 10-21 | 0-5 | 1-6 |
| Relevant memories found | 5-10 | 0-3 | 1-3 |
| Relative efficiency | **5x** | 1x | 2.5x |

**Speed (M-series Mac, 1024-dim embeddings):**

| Memories | Retrieval Time | Throughput |
| -------- | -------------- | ---------- |
| 100      | 0.13ms         | 769k mem/s |
| 1,000    | 1.35ms         | 741k mem/s |
| 2,000    | 2.69ms         | 743k mem/s |
| 10,000   | ~13ms          | ~740k mem/s |

Spreading activation (depth 3) adds <0.1ms overhead.

</details>

### Why?

1. **Gist compression** — Memories stored as ~37 tokens, not ~75. 5x more fit in context.
2. **Cognitive ranking** — MINERVA 2 cubing (`sim³`) suppresses weak matches before budgeting.
3. **Multiplicative recency** — Relevance × recency, not relevance + recency. Irrelevant stays irrelevant.
4. **Spreading activation** — Related memories activate each other. Co-edited files surface together.
5. **No network** — Everything local. 2.7ms, not 200ms.
6. **Rust core** — 743,000 memories/second throughput

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
curl -fsSL https://lucidmemory.dev/install | bash
```

<h4 id="windows">Windows (PowerShell as Administrator):</h4>

```powershell
irm https://lucidmemory.dev/install.ps1 | iex
```

<details>
<summary>Getting a redirect error?</summary>

Older PowerShell versions (5.1) can't follow 308 redirects. Use the direct URL instead:

```powershell
irm https://raw.githubusercontent.com/JasonDocton/lucid-memory/main/install.ps1 | iex
```

</details>

That's it. Your AI coding assistant now remembers across sessions.

<details>
<summary>What the installer does</summary>

1. Checks prerequisites (git, disk space)
2. Installs Bun runtime if needed
3. Downloads BGE embedding model for local semantic search (or OpenAI API)
4. Lets you choose which clients to configure (Claude Code, Codex, or both)
5. Optionally configures database isolation (shared, per-client, or custom profiles)
6. Configures MCP settings for your chosen clients
7. Installs hooks for automatic memory capture
8. Restarts Claude Code to activate

**Requirements:** 5GB free disk space, Claude Code and/or Codex CLI installed

</details>

<details>
<summary><b>Multi-client configuration</b></summary>

Lucid Memory supports both Claude Code and OpenAI Codex. During installation, you can choose:

**Database modes:**
- **Shared** (default) — All clients share the same memory database
- **Per-client** — Each client gets its own database (`memory-claude.db`, `memory-codex.db`)
- **Profiles** — Custom named databases for different contexts (e.g., work vs personal)

**Managing configuration:**
```bash
lucid config show                      # View current configuration
lucid config set-mode per-client       # Switch to per-client databases
lucid config create-profile work       # Create a new profile
lucid config set-profile codex work    # Assign Codex to use the work profile
```

**Environment variable:**

The `LUCID_CLIENT` environment variable determines which client is active. This is set automatically in the MCP config for each client.

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

**Want the full picture?** See [How It Works](HOW_IT_WORKS.md) for a deep dive into the cognitive architecture, retrieval algorithms, and neuroscience behind Lucid Memory.

<h3 id="visual-memory">Visual Memory</h3>

**New in 0.3:** Claude now sees and remembers images and videos you share.

When you share media in your conversation, Claude automatically processes and remembers it—not by storing the file, but by understanding and describing what it sees and hears. Later, when you mention something related, those visual memories surface naturally.

| Without Visual Memory | With Visual Memory |
| --------------------- | ------------------ |
| "What was in that screenshot?" | "That screenshot showed the error in the auth module—the stack trace pointed to line 47." |
| Claude forgets media between sessions | Visual memories persist and surface when relevant |
| Videos are just files | Claude remembers both what it saw AND what was said |

**How it works:**

- **Images** — Claude sees the image, describes it, and stores that understanding with semantic embeddings
- **Videos** — Rust parallel processing extracts frames and transcribes audio simultaneously; Claude synthesizes both into a holistic memory
- **Retrieval** — Visual memories are retrieved via the same cognitive model as text memories (ACT-R activation + semantic similarity)
- **Automatic** — No commands needed; share media, Claude remembers

<details>
<summary><b>Supported formats</b></summary>

**Images:** jpg, jpeg, png, gif, webp, heic, heif

**Videos:** mp4, mov, avi, mkv, webm, m4v

**URLs:** YouTube, Vimeo, youtu.be, direct media links

**Paths:** Simple paths, quoted paths with spaces, ~ expansion

</details>

<h3 id="episodic-memory">Episodic Memory</h3>

**New in 0.5.0:** Claude remembers *sequences*, not just facts.

Most AI memory systems remember individual pieces of information in isolation. Episodic memory captures the temporal structure of your work sessions — the difference between knowing "we fixed an auth bug" and remembering the full story: investigation, root cause, fix, tests.

| Without Episodic Memory | With Episodic Memory |
| ----------------------- | -------------------- |
| "I remember the auth bug fix" | "Before the auth fix, we were investigating a memory leak in session-handler.ts" |
| Each memory is isolated | Memories are linked in temporal sequences |
| No sense of "before" or "after" | "What was I working on before X?" has an answer |

**How it works:**

- **Automatic episode creation** — Memories stored during a work session are grouped into episodes. New episodes start on time gaps (>5 min), project switches, or event count limits
- **Temporal links** — Events within an episode are linked with forward/backward associations. Forward links are stronger than backward (1.0 vs 0.7), matching how human memory works (Temporal Context Model)
- **Temporal spreading** — When you retrieve a memory, activation spreads to temporally linked memories, surfacing the surrounding context
- **Narrative queries** — Ask "what happened before X?" or "what came after Y?" to reconstruct work sequences

<details>
<summary><b>The neuroscience</b></summary>

Episodic Memory is modeled on three brain systems:

**Temporal Context Model** (Howard & Kahana, 2002)
- Memory retrieval is driven by temporal context, not just content
- Forward associations are stronger than backward (asymmetric)
- Strength decays with temporal distance: `strength = base × e^(-distance × 0.3)`

**Episode Boundary Detection** (Zacks et al., 2007)
- Continuous experience is segmented into discrete events
- Boundaries triggered by context shifts (new task, time gap, location change)
- Our implementation: time gaps >5 min, >50 events, project switches

**Hippocampal Sequence Learning** (Eichenbaum, 2000)
- The hippocampus encodes temporal relationships between events
- Enables "mental time travel" — reconstructing sequences from partial cues
- Our implementation: `retrieveTemporalNeighbors()` for before/after queries

</details>

<h3 id="location-intuitions">Procedural Memory</h3>

**New in 0.4.0:** Claude develops procedural memory—the "muscle memory" of coding.

After working in a project, Claude doesn't just remember files—it *knows* them. Like how you navigate your home without thinking, Claude builds instinctive knowledge of your codebase through repeated exposure.

| Without Procedural Memory | With Procedural Memory |
| ------------------------- | ---------------------- |
| Claude searches for files every time | Claude navigates directly to familiar files |
| "Let me search for the auth handler..." | "I know auth is in `src/auth/handler.ts`" |
| Each session starts from zero | Familiarity persists and grows across sessions |
| No awareness of work patterns | Recognizes related files and workflows |

**How it works:**

- **Familiarity grows asymptotically** — First access: ~9% familiar. 10th access: ~50%. 24th access: 70%+ ("well-known"). Diminishing returns, like real learning.
- **Context is bound to location** — Claude remembers *what you were doing* when you touched each file (debugging? refactoring? reading?)
- **Session-aware associations** — Files accessed together in the same session get 1.5x stronger links
- **Workflow learning** — Files worked on for the same task form associative networks (3x boost)
- **Temporal retrieval** — Recent memories get priority through 4-phase cognitive processing:
  1. Working Memory buffer (τ≈4s decay, 7±2 item capacity)
  2. Session decay modulation (recent = slower forgetting)
  3. Project context boost (in-project memories ranked higher)
  4. Session tracking (30-min activity windows)
- **Graceful decay** — Unused files fade, but well-known ones have "sticky floors"—procedural knowledge resists forgetting

<details>
<summary><b>The neuroscience</b></summary>

Procedural Memory is modeled on five brain systems:

**Working Memory** (Baddeley, 2000; Cowan, 2001)
- Short-term buffer with ~7 items and ~4 second decay
- Recently retrieved memories get 2x activation boost
- Implements the "tip of the tongue" phenomenon

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
- Session-based boost (1.5x) for files accessed in the same work session

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

### Episodic Memory
- Tulving, E. (1972). Episodic and semantic memory. In E. Tulving & W. Donaldson (Eds.), *Organization of Memory*
- Howard, M. W., & Kahana, M. J. (2002). A distributed representation of temporal context. *Journal of Mathematical Psychology*, 46(3), 269-299.
- Eichenbaum, H. (2000). A cortical-hippocampal system for declarative memory. *Nature Reviews Neuroscience*, 1(1), 41-50.
- Zacks, J. M., Speer, N. K., Swallow, K. M., Braver, T. S., & Reynolds, J. R. (2007). Event perception: a mind-brain perspective. *Psychological Bulletin*, 133(2), 273.

### Spatial Memory & Location Intuitions
- O'Keefe, J., & Nadel, L. (1978). *The Hippocampus as a Cognitive Map*
- Moser, E. I., Kropff, E., & Moser, M. B. (2008). Place cells, grid cells, and the brain's spatial representation system. *Annual Review of Neuroscience*, 31, 69-89.
- Squire, L. R. (1992). Memory and the hippocampus: A synthesis from findings with rats, monkeys, and humans. *Psychological Review*, 99(2), 195-231.
- Hebb, D. O. (1949). *The Organization of Behavior*

### Visual Memory
- Paivio, A. (1986). *Mental Representations: A Dual Coding Approach* — Images and words are processed through separate but interconnected channels
- Standing, L. (1973). Learning 10,000 pictures. *Quarterly Journal of Experimental Psychology*, 25(2), 207-222. — Humans have remarkable capacity for visual memory
- Brady, T. F., Konkle, T., Alvarez, G. A., & Oliva, A. (2008). Visual long-term memory has a massive storage capacity for object details. *PNAS*, 105(38), 14325-14329.
- Tulving, E. (1972). Episodic and semantic memory. In E. Tulving & W. Donaldson (Eds.), *Organization of Memory* — Visual memories as episodic traces bound to context

## Privacy & Data

Lucid Memory runs entirely on your machine. Your memories never leave your computer.

- **Database location:** `~/.lucid/memory.db` (or `memory-<client>.db` / `memory-<profile>.db` if using isolation)
- **What's stored:** Text summaries of learnings, decisions, and context—not your source code
- **Removing sensitive data:** Use `memory_forget` tool to delete specific memories
- **Auto-updates:** Opt-in during installation; can be disabled in `~/.lucid/config.json`
- **Configuration:** Client and database settings stored in `~/.lucid/config.json`

The database contains project context that persists across sessions. Treat it like your shell history—useful for productivity, stored locally with standard file permissions.

## License

GPL-3.0 — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built for AI systems that need memory with meaning, not just storage with retrieval.</sub>
</p>
