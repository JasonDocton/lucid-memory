# How Lucid Memory Works

Lucid Memory is a **cognitive memory system** for Claude Code that mimics how human memory actually works—not as a simple database, but as a reconstructive, context-dependent system.

## The Core Idea

Traditional memory systems store and retrieve data like a filing cabinet. Lucid Memory instead models **how humans remember**: memories aren't retrieved intact—they're reconstructed from context, associations, and emotional significance.

## Three Types of Memory

### 1. Declarative Memory (Text)
- Stores learnings, decisions, bugs, solutions, context
- Each memory gets an embedding (vector representation) for semantic search
- Memories have emotional weight (0-1) affecting retrieval priority

### 2. Visual Memory
- Stores descriptions of images/videos (not the pixels themselves)
- Tracks emotional context: valence (pleasant↔unpleasant) and arousal (calm↔exciting)
- Has consolidation states—fresh memories are "labile" (modifiable), then stabilize

### 3. Location Memory (Spatial)
- Tracks which files you've accessed and how familiar you are with them
- Models hippocampal place cells—repeated exposure builds familiarity asymptotically
- Binds activity type (reading, debugging, writing) to each access

## The Retrieval Algorithm

When you query memory, it doesn't just do similarity search. It combines **four activation sources**:

```
Total Activation = Base-Level + Probe + Spreading + Emotional
```

### 1. Base-Level Activation (recency/frequency)
- Recently accessed memories activate more strongly
- Frequently accessed memories resist forgetting
- Formula: `B(m) = ln[Σ(t^-d)]` — power law of forgetting

### 2. Probe Activation (semantic similarity)
- Cosine similarity between your query and stored memories
- Cubed (S³) to emphasize strong matches and suppress weak ones
- A 0.9 similarity stays at 0.73, but 0.5 drops to 0.125

### 3. Spreading Activation (associations)
- Memories link to each other through associations
- Activation "spreads" through the network—related memories wake up
- Decays 30% per hop, limited to 3 hops deep

### 4. Emotional Weight
- High-arousal memories get a 1.0-1.5x multiplier
- Emotionally significant experiences are remembered better

## Location Intuitions

For files/paths, Lucid builds **spatial intuition**:

### Familiarity Curve

```
f(n) = 1 - 1/(1 + 0.1n)
```

| Accesses | Familiarity |
|----------|-------------|
| 1        | ~9%         |
| 10       | ~50%        |
| 24+      | 70%+ (well-known) |

### Activity Binding

Tracks *what you were doing* when accessing files:
- Reading
- Writing
- Debugging
- Refactoring
- Reviewing

### Co-Access Associations

Files accessed together become linked:

| Context | Link Strength |
|---------|---------------|
| Same task + same activity | 5x |
| Same task + different activity | 3x |
| Same session | 1.5x (stacks with above) |
| Time-based + same activity | 2x |
| Just temporal proximity | 1x |

### Session Tracking

Sessions group related work:
- Auto-created on first file access per project
- Auto-expire after 30 minutes of inactivity
- Files accessed in the same session form stronger associations (1.5x boost)

### Decay with Protection

Unused locations fade over time, but well-known ones have a "sticky floor"—procedural knowledge resists forgetting. Pinned locations never decay.

## Temporal Retrieval (4 Phases)

When retrieving memories, 4 cognitive phases modulate activation:

### Phase 1: Working Memory Buffer

Short-term memory for recently accessed items:

```
Boost = 1 + e^(-(t - t_activated) / τ)
```

| Parameter | Value | Source |
|-----------|-------|--------|
| Capacity | 7±2 items | Miller (1956), Cowan (2001) |
| Decay (τ) | 4 seconds | Baddeley (2000) |
| Max boost | 2x | At t=0 |
| Cutoff | 5τ (20s) | Items removed after this |

### Phase 2: Session Decay Modulation

Recent memories decay slower:

| Time Since Access | Decay Rate |
|-------------------|------------|
| < 30 minutes | d = 0.3 |
| < 2 hours | d = 0.4 |
| < 24 hours | d = 0.45 |
| > 24 hours | d = 0.5 |

Lower decay = slower forgetting = higher activation.

### Phase 3: Project Context Boost

Memories from the current project get priority:

- In-project memories: +0.15 emotional weight boost
- Cross-project memories: no boost
- Caps at 1.0 emotional weight

### Phase 4: Session Tracking

Session context enhances associations:

- Same session = 1.5x association strength
- Enables "what files did I work with recently?" queries
- Supports workflow pattern recognition

## Consolidation (Visual Memory)

Visual memories go through states:

```
Fresh → Consolidating → Consolidated
                            ↓ (surprise/prediction error)
                      Reconsolidating
```

1. **Fresh** — just stored, not yet consolidated
2. **Consolidating** — in a time window where it's stabilizing
3. **Consolidated** — stable, harder to modify
4. **Reconsolidating** — if retrieval produces "surprise" (prediction error), the memory becomes labile again for updating

## Performance

The Rust core makes this fast:

| Metric | Value |
|--------|-------|
| Latency | 2.7ms for 2,000 memories |
| Throughput | 743,000 memories/second |

A TypeScript fallback exists but is ~100x slower.

## In Practice

When Claude Code asks "what do I know about authentication in this project?":

1. Your query gets embedded
2. All memories with embeddings are scored by the 4-factor activation
3. Associated memories get boosted via spreading
4. Results ranked by probability of retrieval
5. Token-budgeted gists returned to fit context window

The result: Claude remembers things the way you would—recent stuff is fresh, important stuff sticks, related concepts trigger each other, and unused knowledge gradually fades.

## The Science Behind It

Lucid Memory implements two established cognitive models:

### ACT-R (Adaptive Control of Thought—Rational)
- Developed by John Anderson at CMU
- Models human memory retrieval as activation-based competition
- Explains why we remember some things and forget others

### MINERVA 2
- Developed by Douglas Hintzman
- Models memory as pattern completion
- The cubing function (S³) comes from this—it explains how we recognize things even with partial cues

### Biological Inspiration

| Module | Brain System | What It Models |
|--------|--------------|----------------|
| Working memory buffer | Prefrontal cortex | Short-term active maintenance |
| Base-level activation | Neocortex/MTL | Memory strength over time |
| Spreading activation | Associative networks | "Neurons that fire together wire together" |
| Location intuitions | Hippocampus | Place cells and spatial memory |
| Emotional weighting | Amygdala | Emotional memories are stronger |
| Session tracking | Episodic memory | Temporal context binding |
| Consolidation | Sleep/rest cycles | Memory stabilization over time |

## Learn More

- See `docs/PROJECT_MAP.md` for detailed code navigation
- The Rust core is in `crates/lucid-core/`
- The MCP server is in `packages/lucid-server/`
