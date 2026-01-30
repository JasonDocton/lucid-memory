/**
 * Lucid Memory MCP Server
 *
 * MCP server providing persistent memory for Claude Code.
 * Install once, Claude Code remembers forever.
 */

// Storage layer
export { LucidStorage } from "./storage.js";
export type { Memory, MemoryInput, MemoryType, Association, Project, StorageConfig } from "./storage.js";

// Embeddings
export { EmbeddingClient, detectProvider, cosineSimilarity, normalize } from "./embeddings.js";
export type { EmbeddingConfig, EmbeddingProvider, EmbeddingResult } from "./embeddings.js";

// Retrieval
export { LucidRetrieval, DEFAULT_CONFIG } from "./retrieval.js";
export type { RetrievalCandidate, RetrievalConfig } from "./retrieval.js";

// Server entrypoint is src/server.ts
// Run with: bun run src/server.ts

// Version
export const VERSION = "0.1.0";
