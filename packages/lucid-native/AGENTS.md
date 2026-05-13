<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-13 | Updated: 2026-05-13 -->

# lucid-native

## Purpose
Distribution package for pre-built `lucid-core` N-API binaries. Ships one `.node` file per supported platform (darwin-arm64, linux-arm64-gnu, linux-x64-gnu, win32-x64-msvc). Users install this package to avoid compiling Rust. Binaries built by CI via `build-native.yml`.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Package manifest: `@lucid-memory/native` |
| `index.js` | Entry point — selects and loads the correct `.node` binary for the current platform |
| `index.d.ts` | TypeScript type declarations for the native module API |
| `lucid-native.darwin-arm64.node` | Pre-built binary for macOS ARM64 |
| `lucid-native.linux-arm64-gnu.node` | Pre-built binary for Linux ARM64 |
| `lucid-native.linux-x64-gnu.node` | Pre-built binary for Linux x86-64 |
| `lucid-native.win32-x64-msvc.node` | Pre-built binary for Windows x86-64 |

## For AI Agents

### Working In This Directory
- Do not manually edit `.node` files — they are build artifacts from `crates/lucid-napi`.
- To rebuild: `napi build --release` in `crates/lucid-napi`, then copy output binaries here.
- CI builds all platforms via `build-native.yml` and commits the binaries — prefer that path.
- `index.js` selects the binary at runtime using `process.platform` + `process.arch`.

<!-- MANUAL -->
