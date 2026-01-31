/**
 * Lucid Memory MCP Server
 *
 * MCP server providing persistent memory for Claude Code.
 * Install once, Claude Code remembers forever.
 */

export type {
	EmbeddingConfig,
	EmbeddingProvider,
	EmbeddingResult,
} from "./embeddings.ts"
// Embeddings
export {
	cosineSimilarity,
	detectProvider,
	EmbeddingClient,
	normalize,
} from "./embeddings.ts"
export type { RetrievalCandidate, RetrievalConfig } from "./retrieval.ts"
// Retrieval
export { DEFAULT_CONFIG, LucidRetrieval } from "./retrieval.ts"
export type {
	Association,
	Memory,
	MemoryInput,
	MemoryType,
	Project,
	StorageConfig,
} from "./storage.ts"
// Storage layer
export { LucidStorage } from "./storage.ts"

// Server entrypoint is src/server.ts
// Run with: bun run src/server.ts

// Version
export const version = "0.1.0" as const
