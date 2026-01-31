# Changelog

All notable changes to Lucid Memory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-01-30

### Added

#### Location Intuitions

Claude now builds spatial memory of your codebase. After working in a project, Claude develops *intuitions* about file locations—not through explicit memorization, but through repeated exposure, just like you know where your kitchen is without thinking about it.

**Key features:**

- **Familiarity grows asymptotically** — First access: low familiarity. 10th access: high familiarity. 100th access: not much higher (diminishing returns, like real learning)
- **Context is bound to location** — Claude remembers *what you were doing* when you touched each file (debugging? refactoring? reading?)
- **Related files link together** — Files worked on for the same task form associative networks
- **Unused knowledge fades** — Files not accessed in 30+ days gradually decay (but well-known files have "sticky" floors)

**The neuroscience:**

| Brain System | Function | Implementation |
|--------------|----------|----------------|
| Hippocampal Place Cells | Neurons that fire at specific locations | `familiarity = 1 - 1/(1 + 0.1n)` |
| Entorhinal Cortex | Binds context to spatial memory | Activity type tracking (reading, writing, debugging) |
| Procedural Memory | "Knowing how" vs "knowing that" | `searchesSaved` metric for true familiarity |
| Associative Networks | "Neurons that fire together wire together" | Task-based and time-based file associations |

#### Rust Core Implementation

The Location Intuitions system is implemented in Rust (`lucid-core`) with NAPI bindings, providing:

- **Sub-microsecond performance** — Familiarity computation: 0.088μs, Association strength: 0.213μs
- **Identical behavior** — Rust and TypeScript implementations produce mathematically identical results
- **Graceful fallback** — If native module unavailable, TypeScript fallback activates automatically

**New Rust modules:**

```
crates/lucid-core/src/location.rs    # Core algorithms
crates/lucid-napi/src/lib.rs         # NAPI bindings (6 new functions)
```

**New NAPI exports:**

| Function | Purpose |
|----------|---------|
| `locationComputeFamiliarity` | Asymptotic familiarity curve |
| `locationInferActivity` | 4-level precedence activity inference |
| `locationBatchDecay` | Batch decay computation |
| `locationAssociationStrength` | Task/time-based association strength |
| `locationGetAssociated` | Find associated locations |
| `locationIsWellKnown` | Threshold-based familiarity check |

#### New MCP Tools

13 new location-related tools added to the MCP server:

- `mind_location_record` — Record file access
- `mind_location_get` — Get location by path
- `mind_location_all` — List all known locations
- `mind_location_recent` — Recent locations
- `mind_location_find` — Pattern-based search
- `mind_location_stats` — Familiarity statistics
- `mind_location_known` — Check if path is well-known
- `mind_location_by_goal` — Locations by goal context
- `mind_location_contexts` — Access context history
- `mind_location_context_stats` — Context statistics
- `mind_location_associated` — Find co-accessed files
- `mind_location_by_activity` — Filter by activity type

### Changed

- **Activity inference now includes tool-based inference** — 4-level precedence: explicit > keyword > tool > default
- **Association strength now uses semantic parameters** — `(sameTask, sameActivity)` instead of raw multiplier
- **Decay threshold increased to 30 days** — More realistic for real-world usage patterns

### Technical Details

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP Server (TypeScript)                                        │
│  - Tool handlers remain in TypeScript                           │
│  - Calls Rust via NAPI for all computation                      │
├─────────────────────────────────────────────────────────────────┤
│  NAPI Bindings (lucid-napi)                                     │
│  - Type conversion (Rust ↔ JavaScript)                          │
│  - Automatic camelCase conversion                               │
├─────────────────────────────────────────────────────────────────┤
│  Rust Core (lucid-core)                                         │
│  - location module for spatial memory                           │
│  - Reuses spreading module for activation                       │
│  - Pure computation, no I/O                                     │
├─────────────────────────────────────────────────────────────────┤
│  Storage (TypeScript - Bun SQLite)                              │
│  - Schema unchanged                                             │
│  - TypeScript loads data, passes to Rust, writes results        │
└─────────────────────────────────────────────────────────────────┘
```

#### Test Coverage

| Suite | Tests | Description |
|-------|-------|-------------|
| Rust core | 25 | Core algorithm tests |
| Rust NAPI | 8 | Binding tests |
| Doc tests | 4 | Documentation examples |
| TypeScript storage | 34 | Storage layer tests |
| Rust vs TS integration | 11 | Behavioral equivalence |
| **Total** | **82** | |

#### Performance Benchmarks

Measured on M-series Mac:

| Operation | Time | Notes |
|-----------|------|-------|
| Familiarity computation | 0.088μs | Per call |
| Activity inference | 1.058μs | Includes string matching |
| Association strength | 0.213μs | Per call |
| Batch decay (1000 locations) | <100μs | Estimated |

### References

- O'Keefe, J., & Nadel, L. (1978). *The Hippocampus as a Cognitive Map*
- Moser, E. I., Kropff, E., & Moser, M. B. (2008). Place cells, grid cells, and the brain's spatial representation system.
- Squire, L. R. (1992). Memory and the hippocampus.
- Hebb, D. O. (1949). *The Organization of Behavior*

## [0.1.0] - 2024-12-15

### Added

- Initial release
- Core memory retrieval engine using ACT-R and MINERVA 2
- Spreading activation through association graphs
- SQLite-based persistent storage
- MCP server integration for Claude Code
- Local embedding support via Ollama
