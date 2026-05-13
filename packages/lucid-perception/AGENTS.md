<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# packages/lucid-perception

## Purpose
Distribution package for pre-built `lucid-perception` N-API binaries. Ships platform-specific `.node` files (darwin-arm64, darwin-x64, linux-x64-gnu, win32-x64-msvc). Built by CI; users install to avoid Rust compilation.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Package manifest: `@lucid-memory/perception` |
| `index.js` | Entry point — loads the correct `.node` binary for the current platform |
| `index.d.ts` | TypeScript type declarations for the perception module API |
| `lucid-perception.darwin-arm64.node` | Pre-built binary for macOS ARM64 |
| `lucid-perception.darwin-x64.node` | Pre-built binary for macOS x86-64 |
| `lucid-perception.linux-x64-gnu.node` | Pre-built binary for Linux x86-64 |
| `lucid-perception.win32-x64-msvc.node` | Pre-built binary for Windows x86-64 |

## For AI Agents

### Working In This Directory
- Do not manually edit `.node` files — built artifacts from `crates/lucid-perception-napi`.
- To rebuild: `napi build --release` in `crates/lucid-perception-napi`, then copy here.
- CI builds all platforms via `build-native.yml` and commits the binaries.

<!-- MANUAL -->
