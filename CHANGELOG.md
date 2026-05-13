# Changelog

All notable changes to Lucid Memory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### OpenAI-Compatible Local Embedding Endpoints

Lucid Memory now supports any OpenAI-compatible embedding server as a drop-in backend — Ollama, LM Studio, vLLM, and others — without an API key.

**Key features:**

- **`LUCID_EMBEDDING_URL`** — Set to any OpenAI-compatible base URL (e.g. `http://localhost:11434/v1`). Checked first, highest priority in provider detection.
- **`LUCID_EMBEDDING_MODEL`** — Override the embedding model name (e.g. `nomic-embed-text`).
- **API key optional** — Local endpoints work without authentication.
- **Long-context models** — Enables models like `nomic-embed-text` (8192-token context) as an alternative to the built-in BGE model (512-token limit).
- **Endpoint probing** — `isAvailable()` probes `/models` on custom endpoints to verify availability before committing.

**Usage:**

```bash
LUCID_EMBEDDING_URL=http://localhost:11434/v1 \
LUCID_EMBEDDING_MODEL=nomic-embed-text \
lucid-server
```

**Provider detection order:** `LUCID_EMBEDDING_URL` → local ONNX (BGE) → OpenAI → none.

## [0.6.5] - 2026-02-20

### Added

- **Linux ARM64 pre-built binary** for `lucid-native` (`lucid-native.linux-arm64-gnu.node`) — previously required building from source on Linux ARM64.

### Fixed

**All `.node` binaries shipped since January 30th were macOS ARM64 Mach-O files regardless of target platform**, causing immediate segfaults on Linux and Windows. Only macOS Apple Silicon users were unaffected.

**Root cause:** Two interacting CI bugs: (1) the upload step used `path: *.node`, uploading all checked-out `.node` files per artifact rather than only the freshly built one; (2) the rename step picked the first `.node` file alphabetically from checkout — the pre-existing `darwin-arm64` binary — and renamed it to the target platform name, overwriting the correct build output.

**Fixes:**

- Clean stale binaries before building so only fresh build output exists
- Upload only the specific target file (`lucid-native.{platform}.node`) instead of `*.node`
- Add binary format validation (`file` command checks ELF/Mach-O/PE32+) in both publish and release jobs
- Add format validation to `install.sh` download fallback — wrong-format downloads are rejected and deleted
- Fix release job permissions for asset uploads

Six layers now prevent recurrence: pre-build clean → post-build verify → targeted upload → publish validation → release validation → installer validation.

**Platform support after this fix:**

| Platform | lucid-native | lucid-perception |
|----------|:---:|:---:|
| macOS ARM64 (Apple Silicon) | pre-built | pre-built |
| macOS x64 (Intel) | build from source | pre-built |
| Linux x64 | pre-built | pre-built |
| Linux ARM64 | pre-built (new) | build from source |
| Windows x64 | pre-built | pre-built |

## [0.6.4] - 2026-02-20

### Fixed

#### Embedding Provider Diagnostics

Silent embedding failures now surface with actionable diagnostics instead of falling through to `null`.

- **`detectProvider()` returns `ProviderDiagnostics`** — per-provider failure reasons recorded; `lucid status` now shows exactly what was tried and why each provider was skipped (e.g. `Native: model failed to load (ORT error)`, `OpenAI: no OPENAI_API_KEY set`, `Ollama: connection refused`). Previously checked file existence only — a corrupt or incompatible model file would still show as "configured".
- **`retrieve()` returns `RetrievalResult`** — includes `method` (`"semantic"` | `"recency"`) and `warning` field. `memory_query` responses surface these fields so callers can detect when results are ranked by recency only due to embedding failure.

## [0.6.3] - 2026-02-20

### Fixed

- Switched built-in ONNX embedding model from FP16 (`model_fp16.onnx`) to INT8 quantized (`model_quantized.onnx`). The FP16 model contains graph optimizations (`SimplifiedLayerNormFusion`, `InsertedPrecisionFreeCast`) incompatible with `ort` 2.0.0-rc.11, causing embeddings to silently fail to load and report "No embedding provider configured". The quantized model (110MB vs 218MB) is fully compatible and produces equivalent retrieval quality.
- Installers now clean up the old FP16 model file on re-install.

## [0.6.2] - 2026-02-15

### Fixed

- Removed dead NAPI bindings that were exported but never called from TypeScript
- Removed orphaned struct fields causing Clippy warnings
- Resolved remaining Biome lint issues introduced by 0.6.1

## [0.6.1] - 2026-02-15

### Added

- **`visual_list` MCP tool** — Browse and filter visual memories by project, media type, and recency. Previously `queryVisualMemories()` was unreachable from the MCP surface.

### Fixed

The 0.6.0 5-gate audit incorrectly made 5 storage methods private and deleted them to clear Biome lint errors, breaking wired features. This release restores and wires each:

| Method | Wired to |
|--------|---------|
| `queryVisualMemories()` | New `visual_list` MCP tool |
| `getVisualEmbedding()` | Consolidation visual pruning guard (skip unprocessed visuals) |
| `getEpisode()` | Public API for single-episode lookup |
| `updateProjectContext()` | `store()` flow for project metadata accumulation |
| `hasEmbedding()` | Public API for per-memory embedding existence check |

`memory_consolidation_status` enriched with episode diagnostics (recent episodes with event counts and boundary types) and pending embedding counts (memories awaiting background processing).

## [0.6.0] - 2026-02-15

### Added

#### Memory Consolidation & Reconsolidation

Lucid Memory is now a self-maintaining memory system. Background consolidation runs during idle time — strengthening recently accessed memories, decaying stale ones, advancing consolidation state machines, pruning weak associations, and cleaning up visual memories. Before 0.6.0, memories accumulated forever with static encoding strength and no lifecycle management.

**Key features:**

- **Two-window consolidation** (Stickgold & Walker 2013) — Micro-consolidation (every 5 min) strengthens recent memories and decays stale ones. Full consolidation (every 1 hour) advances state transitions and prunes weak data.
- **Consolidation state machine** — Memories progress through `fresh → consolidating → consolidated` with time-based transitions. Reconsolidation returns memories to a labile state when updated.
- **Reconsolidation with PE zones** — New memories are checked against existing traces. Low prediction error reinforces the existing memory. Moderate PE triggers reconsolidation (update in place). High PE creates a new trace. Based on dual-sigmoid reconsolidation model.
- **PRP encoding boost** — High-importance memories activate a Protein Synthesis-dependent consolidation window (90-min half-life) that boosts encoding strength of subsequent stores.
- **Association lifecycle** — Associations decay over time via exponential decay, are reinforced on co-retrieval, and pruned when below threshold. Uses Rust `computeAssociationDecay`, `reinforceAssociation`, and `shouldPruneAssociation`.
- **Visual memory pruning** — Stale visual memories are pruned during full consolidation using Rust `visualShouldPrune` based on significance and recency.
- **Instance noise** — Per-memory retrieval noise scaled by encoding strength. Stronger memories have lower noise for more consistent retrieval.

**New Rust functions in `lucid-core`:**

| Function | Purpose |
|----------|---------|
| `reconsolidation_probability()` | Dual-sigmoid bell curve for PE zone routing |
| `compute_effective_thresholds()` | Age/use modulated reconsolidation boundaries |
| `pe_zone()` | Returns `reinforce`, `reconsolidate`, or `new_trace` |

**New MCP tools:**

| Tool | Purpose |
|------|---------|
| `visual_delete` | Delete a visual memory by ID |
| `memory_consolidation_status` | Diagnostics: consolidation state counts, association stats |

**Background processors:**

| Processor | Interval | Action |
|-----------|----------|--------|
| Micro-consolidation | 5 min | Strengthen recent, decay stale, decay associations |
| Full consolidation | 1 hour | State transitions, prune associations/memories/visuals, consolidate contexts |
| Session pruning | 5 min | Clean up expired sessions (>30 min inactive) |

#### 5-Gate Audit

Comprehensive audit ensuring every feature advertised in the README is actually implemented, wired, tested, and produces no orphaned outputs.

**Gate 1 — TSC type safety:** Fixed 25 pre-existing TypeScript compiler errors across 4 files (retrieval.ts, episodic-memory.test.ts, association-index.test.ts, storage.ts). Zero tsc errors remaining.

**Gate 5 — No orphaned outputs:**

*Storage methods wired:*
- `pruneOldMemories()` → consolidation engine full cycle
- `consolidateOldContexts()` → consolidation engine full cycle
- `deleteVisualMemory()` → `visual_delete` MCP tool + consolidation visual pruning
- `endSession()` → `retrieval.close()` shutdown flow
- `touchSession()` → `getOrCreateSession()` in retrieval.ts
- `pruneExpiredSessions()` → background session pruning processor

*NAPI functions wired:*
- `computeSessionDecayRateBatch` / `computeWorkingMemoryBoostBatch` → retrieval.ts batch optimization
- `nonlinearActivation` → retrieval.ts TS fallback (2 call sites)
- `createEpisodeLinks` → retrieval.ts episode creation
- `shouldPruneAssociation` → consolidation engine association decay
- `visualShouldPrune` → consolidation engine visual pruning
- `version()` → server.ts startup log

*13 internal methods made private* to reduce public API surface.

### Changed

- All consolidation config flags enabled by default (`ConsolidationConfig`, `AssociationDecayConfig`, `InstanceNoiseConfig`)
- `ReconsolidationConfig` and `PrpConfig` added with sensible defaults
- Retrieval pipeline now includes instance noise, PRP encoding, and association reinforcement
- Background consolidation processor runs alongside existing decay and embedding processors
- Native version logged at MCP server startup
- Graceful shutdown now ends all active sessions via `retrieval.close()`

### Fixed

- 25 pre-existing TypeScript compiler errors (narrowing, non-null assertions, type annotations)
- `endSession()` called without argument during shutdown (moved to `retrieval.close()`)
- Tests referencing private `getAccessHistory` rewritten to use `accessCount`

### Benchmark Results

| Metric | 0.5.0 | 0.6.0 | Change |
|--------|-------|-------|--------|
| Cognitive Avg | 87.3% | 87.3% | -- |
| Delta vs RAG | +16% | +16% | -- |
| NDCG (quality) | 1.000 | 1.000 | -- |
| Token efficiency | 5x | 5x | -- |
| Episode retrieval | 80% | 80% | -- |
| Tests passing | 163 | 307 | +144 |

**307 tests (92 Rust + 215 TS), 0 failures, 0 tsc errors.**

## [0.5.2] - 2026-02-10

### Added

#### OpenCode Support

Lucid Memory now supports [OpenCode](https://github.com/sst/opencode) as a third AI coding client alongside Claude Code and OpenAI Codex.

**Plugin integration:**

- **Automatic context injection** — OpenCode's `experimental.chat.system.transform` hook injects relevant memories into every LLM system prompt, matching Claude Code's hook-based integration.
- **Continuous encoding** — Conversation messages are stored as memories on `session.idle`, building memory over time.
- **Compaction survival** — Memories are injected during session compaction so they persist across long conversations.
- **Environment isolation** — `LUCID_CLIENT=opencode` set via `shell.env` hook for per-client database routing.

**Installer improvements:**

- Multi-client selection UI — choose any combination of Claude Code, Codex, and OpenCode during installation (replaces the old radio-button Claude/Codex/Both selector).
- Full install/uninstall support on both macOS/Linux (bash) and Windows (PowerShell).
- OpenCode MCP config uses correct schema: `mcp` key, `local` type, array command, `environment` key.
- Plugin automatically copied to `~/.config/opencode/plugins/` during installation.

### Fixed

- Claude Code restart no longer runs unconditionally when only Codex or OpenCode is selected
- Profile name input now sanitized to `[a-zA-Z0-9_-]` to prevent invalid JSON in config

### Security

- OpenCode plugin uses `execFileSync`/`execFile` instead of `execSync` to prevent command injection via shell interpolation

## [0.5.1] - 2026-02-07

### Added

#### Native Embedding Engine

Lucid Memory no longer depends on Ollama for text embeddings. A built-in BGE-base-en-v1.5 model runs via ONNX Runtime directly in-process — zero external services, same quality.

**Key features:**

- **In-process ONNX inference** — BGE-base-en-v1.5 FP16 model runs via `ort` crate. 768-dimensional embeddings with mean pooling + L2 normalization.
- **Automatic migration** — On startup, detects Ollama/OpenAI embeddings and re-embeds them with the native model. Progress logged with time estimates.
- **CLI status** — `lucid status` shows pending embedding migration count with text/visual breakdown.
- **Embedding indexes** — New `idx_embeddings_model` and `idx_visual_embeddings_model` indexes for fast provider-based queries.

#### Installer Improvements

- Installers download BGE model directly from HuggingFace CDN (no GitHub release dependency)
- Partial download protection: downloads to `.tmp`, renames on success
- Progress bar visible for large model downloads
- PowerShell `$ProgressPreference` optimization for 220MB download

### Fixed

- Removed Ollama as a required dependency from installers and uninstallers
- Fixed build-native CI for BGE model download URLs (HuggingFace direct links)
- Added model file validation step in CI release workflow
- Fixed Clippy pedantic/nursery lint compliance in `embedding.rs`
- Fixed disk space message accuracy in installer

## [0.5.0] - 2026-02-04

### Added

#### Episodic Memory

Claude now remembers *sequences*, not just facts. Episodic memory captures the temporal structure of your work sessions — the difference between knowing "we fixed an auth bug" and remembering "first we investigated the memory leak, then traced it to session-handler.ts, then refactored the auth module."

**Key features:**

- **Episode lifecycle** — Memories are automatically grouped into episodes during `store()`. Boundary detection triggers new episodes on time gaps (>5 min), event count limits (>50), or project switches.
- **Temporal links** — Forward/backward links between events with TCM asymmetry (forward=1.0, backward=0.7) and exponential distance decay.
- **Temporal spreading** — Integrated into `retrieve()` pipeline. Top 5 seed memories spread activation through episode links, boosting temporally related memories.
- **Temporal queries** — `retrieveTemporalNeighbors(anchor, "before"|"after"|"both")` answers "What was I working on before X?"
- **MCP tool** — `memory_narrative` exposes temporal queries to Claude for narrative reconstruction.

**The neuroscience:**

| Model | Function | Implementation |
|-------|----------|----------------|
| Temporal Context Model (Howard & Kahana 2002) | Forward/backward asymmetry | Forward links 1.0, backward links 0.7 |
| Episodic boundary detection (Zacks et al. 2007) | Segmenting continuous experience | Time gap, event count, context switch triggers |
| Distance decay | Closer events more strongly linked | `strength = base × e^(-distance × 0.3)` |

**Benchmark impact:**

| Metric | Before 0.5.0 | After 0.5.0 | Change |
|--------|-------------|-------------|--------|
| `episode_retrieval` scenario | 0% | 80% | +80% |
| Cognitive average | 79.3% | 87.3% | +8% |
| Delta vs RAG | +8% | +16% | doubled |
| Cognitive wins | 3/10 | 4/10 | +1 |

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
| `create_episode_links()` | TCM-based temporal links with distance decay |
| `spread_temporal_activation()` | Forward/backward asymmetric spreading |
| `find_temporal_neighbors()` | "What was I working on before/after X?" queries |

#### New Database Schema

| Table | Purpose |
|-------|---------|
| `episodes` | Temporal sequence containers with boundary type and project scope |
| `episode_events` | Links memories to episodes with position ordering |
| `episode_temporal_links` | Forward/backward links between events within episodes |

New columns on `memories`: `encoding_strength`, `encoding_context`, `consolidation_state`, `last_consolidated`

New columns on `associations`: `last_reinforced`, `co_access_count`

### Changed

- TypeScript now delegates to native Rust functions when available
- All native calls properly guarded with `shouldUseNative && nativeModule`
- `EpisodicMemoryConfig` with 9 tunable parameters and feature flag
- Retrieval pipeline now includes episodic temporal spreading (Phase 5)

### Fixed

- Double `episodeBoost` multiplication in temporal spreading (was applying 1.44x instead of 1.2x)
- TS/Rust parity in `spreadTemporalActivationTS` — removed incorrect `contextPersistence` multiplier, fixed accumulation method, added seed activation
- Missing `shouldUseNative` guard in `createAutoAssociations()` cosine similarity call
- `createdAt.getTime()` error (field is already a number, not Date)
- Empty anchor string accepted by `memory_narrative` tool (now requires min 1 char)

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
