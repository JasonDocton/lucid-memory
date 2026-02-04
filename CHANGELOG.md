# Changelog

All notable changes to Lucid Memory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Rust Migration — Cognitive Computations

Migrated all math-heavy cognitive computations from TypeScript to Rust for 100x performance and consistent behavior.

**New Rust functions in `lucid-core`:**

| Function | Purpose |
|----------|---------|
| `compute_working_memory_boost()` | WM boost with exponential decay (τ≈4s) |
| `compute_session_decay_rate()` | Recency-based decay modulation (0.3-0.5) |
| `compute_encoding_strength()` | MINERVA 2 instance-based encoding |
| `compute_instance_noise()` | Per-memory noise for retrieval probability |
| `compute_association_decay()` | Consolidation-state-dependent decay |
| `reinforce_association()` | Co-access boost for associations |
| `should_prune_association()` | Pruning threshold check |

**Episodic Memory Foundation (0.5.0 prep):**

| Function | Purpose |
|----------|---------|
| `create_episode_links()` | TCM-based temporal links with distance decay |
| `spread_temporal_activation()` | Forward/backward asymmetric spreading |
| `find_temporal_neighbors()` | "What was I working on before/after X?" queries |

**The neuroscience:**

- Forward links stronger than backward (1.0 vs 0.7) per TCM (Howard & Kahana 2002)
- Distance decay: `strength = base × e^(-distance × 0.3)`
- Episode boost: 1.2x for temporally linked memories

### Changed

- TypeScript now delegates to native Rust functions when available
- All native calls properly guarded with `shouldUseNative && nativeModule`
- Added `maxTemporalDistance` to `EpisodicMemoryConfig` (default: 10)

### Fixed

- Missing `shouldUseNative` guard in `createAutoAssociations()` cosine similarity call
- `createdAt.getTime()` error (field is already a number, not Date)

## [0.4.0] - 2025-02-02

### Added

#### Procedural Memory

Upgrade from declarative to procedural memory. Claude now develops "muscle memory" for your codebase—learning workflows, developing instincts, and navigating without searching.

**Key features:**

- **Working Memory Buffer** — 7±2 item capacity with τ≈4s exponential decay. Recently retrieved memories get 2x activation boost, modeling the "tip of the tongue" phenomenon.
- **Session-Aware Associations** — Files accessed together in the same session get 1.5x stronger links. Sessions auto-expire after 30 minutes of inactivity.
- **4-Phase Temporal Retrieval:**
  1. Working Memory boost (immediate recall)
  2. Session decay modulation (recent = slower forgetting)
  3. Project context boost (in-project memories ranked higher)
  4. Session tracking (30-min activity windows)

**The neuroscience:**

| Brain System | Function | Implementation |
|--------------|----------|----------------|
| Working Memory | Short-term buffer | 7 items, 4s decay, 2x boost |
| Hippocampal Place Cells | Location familiarity | `f(n) = 1 - 1/(1 + 0.1n)` |
| Entorhinal Cortex | Context binding | Activity type tracking |
| Associative Networks | Related file linking | Task (3x), activity (2x), session (1.5x) boosts |

#### Production Readiness

Comprehensive audit and hardening for production use:

- **5 critical issues fixed** — Project scoping for visual memory, embedding error handling, safe JSON parsing, null checks
- **12 high-priority issues addressed** — Type guards, array bounds validation, transaction safety, test coverage
- **8 low-priority optimizations** — Array allocation, cache pruning, error context in all MCP handlers

**New methods:**

| Method | Purpose |
|--------|---------|
| `LucidRetrieval.close()` | Explicit cleanup of WM, caches, and storage |
| `LucidStorage.pruneExpiredSessions()` | Clean up old session data |
| `toolError()` | Standardized MCP error handling with tool context |

### Changed

- Association cache TTL increased from 5s to 60s (12x fewer DB queries)
- Session cache pruning now runs once per TTL instead of every call
- `Math.max(...history)` replaced with `history[0]` (arrays already sorted DESC)
- All 22 MCP tool handlers now include tool name in error responses

### Fixed

- Visual memory tools now accept `projectPath` for proper project scoping
- Embedding failures gracefully fall back to recency-based retrieval
- `indexOf()` results validated before array access
- Array alignment assertions prevent silent corruption
- `recordFileAccess()` wrapped in transaction for consistency

---

## [0.3.6] - 2025-02-01

### Fixed

#### Installer Overhaul

The installer has been completely rewritten to ensure reliable installation across all platforms.

**Required Dependencies:**
- ffmpeg, yt-dlp, and whisper are now required and auto-installed (were silently optional before)
- lucid-perception package now properly installed for video processing
- Pre-installation confirmation shows exactly what will be installed

**Windows Parity:**
- Full-featured PowerShell hook with media detection (was missing visual memory support)
- Native and perception binaries properly downloaded/built on Windows
- Complete feature parity with macOS/Linux

**Robustness:**
- Post-installation verification checks all critical files exist
- Server wrapper scripts validate Bun and script existence before starting
- Copy operations validated with proper error messages
- `lucid status` now shows video processing dependency status

**CI/CD:**
- Build workflow now produces both lucid-native and lucid-perception binaries
- Pre-built binaries attached to GitHub releases for all platforms

### Changed

- `lucid status` now checks ffmpeg, yt-dlp, and whisper availability
- Installers show progress bars for each dependency installation
- Uninstall scripts show removal summary before proceeding

---

## [0.3.0] - 2025-01-31

### Added

#### Visual Memory

Claude now sees and remembers images and videos you share. When you share media in your conversation, Claude automatically processes and remembers it—not by storing the file, but by understanding and describing what it sees and hears.

**Key features:**

- **Images** — Claude sees the image, describes it, and stores that understanding with semantic embeddings
- **Videos** — Rust parallel processing extracts frames and transcribes audio simultaneously; Claude synthesizes both into a holistic memory
- **Retrieval** — Visual memories are retrieved via the same cognitive model as text memories (ACT-R activation + semantic similarity)
- **Automatic** — No commands needed; share media, Claude remembers

**Supported formats:**

| Type | Formats |
|------|---------|
| Images | jpg, jpeg, png, gif, webp, heic, heif |
| Videos | mp4, mov, avi, mkv, webm, m4v |
| URLs | YouTube, Vimeo, youtu.be, direct media links |
| Paths | Simple, quoted (spaces), ~ expansion |

#### Rust Perception Pipeline

New `lucid-perception` crate for high-performance video processing:

- **Parallel processing** — Frame extraction and audio transcription run simultaneously via `tokio::join!`
- **Scene detection** — Perceptual hashing identifies scene changes for intelligent frame selection
- **Whisper integration** — Audio transcription captures what was said, not just what was shown
- **NAPI bindings** — Full pipeline accessible from TypeScript via `@lucid-memory/perception`

**New crates:**

```
crates/lucid-perception/           # Core video processing
crates/lucid-perception-napi/      # NAPI bindings
packages/lucid-perception/         # NPM package
```

**Key functions:**

| Function | Purpose |
|----------|---------|
| `videoProcess()` | Full parallel pipeline (frames + audio) |
| `videoExtractFrames()` | Frame extraction with scene detection |
| `videoTranscribe()` | Whisper-based audio transcription |
| `videoGetMetadata()` | Video metadata extraction |

#### New MCP Tools

4 new visual memory tools added to the MCP server:

| Tool | Purpose |
|------|---------|
| `visual_store` | Store visual memory (description + metadata) |
| `visual_search` | Semantic search over visual memories |
| `video_process` | Process video with Rust parallel pipeline |
| `video_cleanup` | Clean up temporary processing files |

#### Enhanced Hook Media Detection

The pre-prompt hook now detects media in various formats:

- Simple paths: `/path/to/image.jpg`
- Quoted paths with spaces: `"/path/to/my file.jpg"`
- Tilde expansion: `~/Desktop/photo.jpg`
- Image URLs: `https://example.com/photo.jpg`
- Video URLs: YouTube, Vimeo, youtu.be, direct links

### Changed

- **Context retrieval now includes visual memories** — `getContextWithVisuals()` returns both text and visual memories with configurable token budget allocation
- **CLI context command outputs visual memories** — Shows `[Visual, image]` and `[Visual, video]` entries alongside text memories
- **Background embedding processor handles visual memories** — `startBackgroundVisualEmbeddingProcessor()` generates embeddings for new visual memories

### Technical Details

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Pre-prompt Hook                                                │
│  - Detects media paths/URLs in user message                     │
│  - Outputs <lucid-visual-memory> instructions                   │
│  - Retrieves visual memories via CLI context command            │
├─────────────────────────────────────────────────────────────────┤
│  MCP Server (TypeScript)                                        │
│  - visual_store, visual_search, video_process tools             │
│  - Background embedding processor for visual memories           │
├─────────────────────────────────────────────────────────────────┤
│  Rust Perception (lucid-perception)                             │
│  - Parallel frame extraction + audio transcription              │
│  - Scene detection via perceptual hashing                       │
│  - Whisper integration for transcription                        │
├─────────────────────────────────────────────────────────────────┤
│  Storage (SQLite)                                               │
│  - visual_memories table (descriptions, not files)              │
│  - visual_embeddings table (semantic vectors)                   │
│  - visual_access_history (ACT-R activation)                     │
└─────────────────────────────────────────────────────────────────┘
```

#### Database Schema

```sql
visual_memories (
  id, description, original_path, media_type,
  objects, emotional_valence, emotional_arousal,
  significance, shared_by, source, received_at,
  last_accessed, access_count, created_at
)

visual_embeddings (
  visual_memory_id, vector, model
)

visual_access_history (
  id, visual_memory_id, accessed_at
)
```

#### Test Coverage

| Suite | Tests | Description |
|-------|-------|-------------|
| TypeScript | 45 | Storage, retrieval, integration |
| Rust lucid-core | 33 | Core algorithms including visual |
| Rust lucid-napi | 8 | NAPI binding tests |
| Rust lucid-perception | 14 | Video processing pipeline |
| Doc tests | 5 | Documentation examples |
| **Total** | **105** | |

---

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
