<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-memory

## Purpose
Local AI memory MCP server providing persistent, reconstructive memory for AI coding assistants. Combines a high-performance Rust retrieval engine (ACT-R spreading activation + MINERVA 2 reconstructive memory) with a TypeScript MCP server. 2.7ms retrieval, $0/query, no cloud dependency. Packaged as a single install for Claude Code, OpenAI Codex, and OpenCode.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Bun workspace root; build/test/lint/bench scripts for all packages |
| `Cargo.toml` | Rust workspace; shared deps and version pinning across all crates |
| `HOW_IT_WORKS.md` | Architecture and algorithm deep-dive |
| `ROADMAP.md` | Planned features and milestones |
| `install.sh` / `install.ps1` | End-user install scripts (macOS/Linux and Windows) |
| `uninstall.sh` / `uninstall.ps1` | End-user uninstall scripts |
| `biome.json` | TypeScript lint/format config (Biome) |
| `rustfmt.toml` / `clippy.toml` | Rust format and lint config |
| `tsconfig.json` | TypeScript compiler config (shared) |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `crates/` | Rust crates: retrieval engine and N-API bindings (see `crates/AGENTS.md`) |
| `packages/` | TypeScript packages: MCP server and pre-built native binaries (see `packages/AGENTS.md`) |
| `benchmarks/` | Quality and performance benchmarks (see `benchmarks/AGENTS.md`) |
| `scripts/` | Build, install, and release automation scripts |
| `.github/` | CI/CD workflows for build, test, and publish |
| `.claude/` | Claude Code project configuration |

## For AI Agents

### Working In This Directory
- Stack: **Bun + Rust + TypeScript** monorepo. Keep Rust build steps and JS tooling separate.
- Build: `bun run build` (Rust first, then TS). Test: `bun test`. Lint: `bun run lint`.
- Named exports only — no default exports anywhere in TypeScript.
- `timeout` unavailable on macOS — use `gtimeout`.
- Good code is self-explaining — comment only when the WHY is non-obvious.
- A TODO is COMPLETE only when all 5 gates pass:

| Gate | Requirement | How To Verify |
|------|-------------|---------------|
| **1. Implemented** | Code written, compiles, no errors | `bun test` passes |
| **2. Wired** | Connected to systems that call it (wake cycles, hooks, handlers, prompts) | Grep for function calls from outside the module |
| **3. Tested** | Unit + integration tests covering happy path and edge cases | Test count documented, all pass |
| **4. Verified in Production** | Evidence of actual usage in the live database | SQL query showing non-zero rows, event counts, or call logs |
| **5. No Orphaned Outputs** | Every computed output consumed by at least one downstream system | Grep for each output → confirm a reader exists |

### Testing Requirements
- `bun run test:rust` — Rust unit tests via `cargo test`
- `bun run test:ts` — Bun test runner across all TS packages
- `bun run bench` — full benchmark suite (optional, slow)
- Both test suites must pass before any change is complete.

### Common Patterns
- Rust crates handle high-performance computation; TypeScript handles I/O and MCP protocol.
- N-API bindings (`lucid-napi`, `lucid-perception-napi`) bridge Rust computation to TypeScript.
- Pre-built `.node` binaries ship per platform in `packages/lucid-native` and `packages/lucid-perception`.
- Database stored at `~/.lucid/` — supports shared, per-client, and profile modes via `LUCID_CLIENT` env.

## Dependencies

### Internal
- `crates/lucid-core` → `crates/lucid-napi` → `packages/lucid-server`
- `crates/lucid-perception` → `crates/lucid-perception-napi` → `packages/lucid-server`

### External
- Bun (runtime + test runner), TypeScript 5, Biome (lint/format)
- Rust toolchain, napi-rs CLI (N-API binding generation)
- `@modelcontextprotocol/sdk` (MCP protocol), `zod` (schema validation)
- FFmpeg CLI (video frame extraction), Whisper (optional audio transcription)

### Domain Language Maintenance

When editing documentation in this repo, consult these canonical definitions:

| Term | Definition |
|------|-----------|
| **Memory** | A stored text trace with embedding, activation level, and access history |
| **Activation** | Composite score combining base-level (recency/frequency), probe similarity, and spreading |
| **Base-level activation** | B(m) = ln[Σ(t_k)^(-d)] — recency and frequency of past retrievals |
| **Probe** | The query embedding used to drive retrieval |
| **Spreading activation** | Activation flowing through the association graph: A_j = Σ(W_i/n_i) × S_ij |
| **Gist** | Compressed semantic essence of a verbatim memory trace |
| **Episode** | A temporally bounded sequence of memories representing a work session |
| **Consolidation** | Background process: strengthen recent memories, decay stale ones, prune weak associations |
| **Association** | Weighted edge between two memories in the association graph |
| **Location** | Spatial/temporal context attached to a memory (project, file, line, timestamp) |
| **Native module** | Pre-built `.node` binary exposing Rust computation via N-API |

<!-- MANUAL -->
