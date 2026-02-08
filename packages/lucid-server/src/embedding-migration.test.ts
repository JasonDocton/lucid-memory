/**
 * Embedding Migration Tests
 *
 * Tests the full migration path from Ollama/OpenAI embeddings to native BGE,
 * including visual embeddings, pending counts, index performance, and edge cases.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LucidStorage } from "./storage.ts"

const testDbPath = join(tmpdir(), `lucid-migration-test-${Date.now()}.db`)

describe("Embedding Migration", () => {
	let storage: LucidStorage

	beforeEach(() => {
		storage = new LucidStorage({ dbPath: testDbPath })
	})

	afterEach(() => {
		storage.close()
		for (const suffix of ["", "-wal", "-shm"]) {
			const p = `${testDbPath}${suffix}`
			if (existsSync(p)) unlinkSync(p)
		}
	})

	// =========================================================================
	// Text Embedding Migration
	// =========================================================================

	describe("text embeddings", () => {
		it("counts stale embeddings by model name", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })
			const m3 = storage.storeMemory({ content: "Memory 3" })

			storage.storeEmbedding(m1.id, [0.1, 0.2], "nomic-embed-text")
			storage.storeEmbedding(m2.id, [0.3, 0.4], "nomic-embed-text")
			storage.storeEmbedding(m3.id, [0.5, 0.6], "bge-base-en-v1.5")

			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(2)
			expect(storage.countEmbeddingsNotMatching("nomic-embed-text")).toBe(1)
		})

		it("deletes stale embeddings and returns count", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })
			const m3 = storage.storeMemory({ content: "Memory 3" })

			storage.storeEmbedding(m1.id, [0.1, 0.2], "nomic-embed-text")
			storage.storeEmbedding(m2.id, [0.3, 0.4], "text-embedding-ada-002")
			storage.storeEmbedding(m3.id, [0.5, 0.6], "bge-base-en-v1.5")

			const deleted = storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")
			expect(deleted).toBe(2)

			// Only BGE embedding remains
			expect(storage.getEmbedding(m1.id)).toBeNull()
			expect(storage.getEmbedding(m2.id)).toBeNull()
			expect(storage.getEmbedding(m3.id)).not.toBeNull()
		})

		it("deleted embeddings appear as pending", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })

			storage.storeEmbedding(m1.id, [0.1, 0.2], "nomic-embed-text")
			storage.storeEmbedding(m2.id, [0.3, 0.4], "nomic-embed-text")

			storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")

			const pending = storage.getMemoriesWithoutEmbeddings()
			expect(pending.length).toBe(2)
			expect(pending.map((m) => m.id).sort()).toEqual([m1.id, m2.id].sort())
		})

		it("returns zero when no stale embeddings exist", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			storage.storeEmbedding(m1.id, [0.1, 0.2], "bge-base-en-v1.5")

			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(0)
			expect(storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(0)
		})

		it("handles mixed models from multiple providers", () => {
			const m0 = storage.storeMemory({ content: "Memory 0" })
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })
			const m3 = storage.storeMemory({ content: "Memory 3" })
			const m4 = storage.storeMemory({ content: "Memory 4" })

			// Simulate: 2 from Ollama, 2 from OpenAI, 1 already BGE
			storage.storeEmbedding(m0.id, [0.1], "nomic-embed-text")
			storage.storeEmbedding(m1.id, [0.2], "nomic-embed-text")
			storage.storeEmbedding(m2.id, [0.3], "text-embedding-ada-002")
			storage.storeEmbedding(m3.id, [0.4], "text-embedding-3-small")
			storage.storeEmbedding(m4.id, [0.5], "bge-base-en-v1.5")

			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(4)

			const deleted = storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")
			expect(deleted).toBe(4)

			// Only the BGE one survived
			expect(storage.getEmbedding(m4.id)).not.toBeNull()
			expect(storage.getEmbedding(m0.id)).toBeNull()
			expect(storage.getEmbedding(m1.id)).toBeNull()
			expect(storage.getEmbedding(m2.id)).toBeNull()
			expect(storage.getEmbedding(m3.id)).toBeNull()
		})
	})

	// =========================================================================
	// Visual Embedding Migration
	// =========================================================================

	describe("visual embeddings", () => {
		function storeVisual(desc: string) {
			return storage.storeVisualMemory({
				description: desc,
				mediaType: "image",
				source: "direct",
			})
		}

		it("counts stale visual embeddings", () => {
			const v1 = storeVisual("A cat sitting on a mat")
			const v2 = storeVisual("A dog running in a park")
			const v3 = storeVisual("A sunset over the ocean")

			storage.storeVisualEmbedding(v1.id, [0.1, 0.2], "nomic-embed-text")
			storage.storeVisualEmbedding(v2.id, [0.3, 0.4], "nomic-embed-text")
			storage.storeVisualEmbedding(v3.id, [0.5, 0.6], "bge-base-en-v1.5")

			expect(storage.countVisualEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(
				2
			)
			expect(storage.countVisualEmbeddingsNotMatching("nomic-embed-text")).toBe(
				1
			)
		})

		it("deletes stale visual embeddings", () => {
			const v1 = storeVisual("Visual 1")
			const v2 = storeVisual("Visual 2")
			const v3 = storeVisual("Visual 3")

			storage.storeVisualEmbedding(v1.id, [0.1, 0.2], "nomic-embed-text")
			storage.storeVisualEmbedding(v2.id, [0.3, 0.4], "text-embedding-ada-002")
			storage.storeVisualEmbedding(v3.id, [0.5, 0.6], "bge-base-en-v1.5")

			const deleted =
				storage.deleteVisualEmbeddingsNotMatching("bge-base-en-v1.5")
			expect(deleted).toBe(2)

			// Only BGE remains
			expect(storage.hasVisualEmbedding(v1.id)).toBe(false)
			expect(storage.hasVisualEmbedding(v2.id)).toBe(false)
			expect(storage.hasVisualEmbedding(v3.id)).toBe(true)
		})

		it("deleted visual embeddings appear in pending list", () => {
			const v1 = storeVisual("Visual 1")
			const v2 = storeVisual("Visual 2")

			storage.storeVisualEmbedding(v1.id, [0.1, 0.2], "nomic-embed-text")
			storage.storeVisualEmbedding(v2.id, [0.3, 0.4], "nomic-embed-text")

			storage.deleteVisualEmbeddingsNotMatching("bge-base-en-v1.5")

			const pending = storage.getVisualMemoriesWithoutEmbeddings()
			expect(pending.length).toBe(2)
		})

		it("returns zero when no stale visual embeddings exist", () => {
			const v1 = storeVisual("Visual 1")
			storage.storeVisualEmbedding(v1.id, [0.1], "bge-base-en-v1.5")

			expect(storage.countVisualEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(
				0
			)
			expect(
				storage.deleteVisualEmbeddingsNotMatching("bge-base-en-v1.5")
			).toBe(0)
		})
	})

	// =========================================================================
	// getStats() — Pending Counts
	// =========================================================================

	describe("getStats pending counts", () => {
		function storeVisual(desc: string) {
			return storage.storeVisualMemory({
				description: desc,
				mediaType: "image",
				source: "direct",
			})
		}

		it("reports zero pending when all embedded", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const v1 = storeVisual("Visual 1")

			storage.storeEmbedding(m1.id, [0.1], "bge-base-en-v1.5")
			storage.storeVisualEmbedding(v1.id, [0.2], "bge-base-en-v1.5")

			const stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(0)
			expect(stats.pendingVisualEmbeddingCount).toBe(0)
		})

		it("reports correct pending count for text memories", () => {
			storage.storeMemory({ content: "Memory 1" })
			storage.storeMemory({ content: "Memory 2" })
			const m3 = storage.storeMemory({ content: "Memory 3" })

			// Only one has an embedding
			storage.storeEmbedding(m3.id, [0.1], "bge-base-en-v1.5")

			const stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(2)
			expect(stats.memoryCount).toBe(3)
			expect(stats.embeddingCount).toBe(1)
		})

		it("reports correct pending count for visual memories", () => {
			storeVisual("Visual 1")
			storeVisual("Visual 2")
			const v3 = storeVisual("Visual 3")

			storage.storeVisualEmbedding(v3.id, [0.1], "bge-base-en-v1.5")

			const stats = storage.getStats()
			expect(stats.pendingVisualEmbeddingCount).toBe(2)
			expect(stats.visualMemoryCount).toBe(3)
		})

		it("reflects pending after migration deletes stale embeddings", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })
			const v1 = storeVisual("Visual 1")

			storage.storeEmbedding(m1.id, [0.1], "nomic-embed-text")
			storage.storeEmbedding(m2.id, [0.2], "nomic-embed-text")
			storage.storeVisualEmbedding(v1.id, [0.3], "nomic-embed-text")

			// Before migration: 0 pending (all have embeddings, just wrong model)
			let stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(0)
			expect(stats.pendingVisualEmbeddingCount).toBe(0)

			// Migrate
			storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")
			storage.deleteVisualEmbeddingsNotMatching("bge-base-en-v1.5")

			// After migration: all pending
			stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(2)
			expect(stats.pendingVisualEmbeddingCount).toBe(1)
			expect(stats.embeddingCount).toBe(0)
		})

		it("pending count decreases as embeddings are re-generated", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })
			const m3 = storage.storeMemory({ content: "Memory 3" })

			// Simulate post-migration state (all pending)
			let stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(3)

			// Re-embed one at a time
			storage.storeEmbedding(m1.id, [0.1], "bge-base-en-v1.5")
			stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(2)

			storage.storeEmbedding(m2.id, [0.2], "bge-base-en-v1.5")
			stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(1)

			storage.storeEmbedding(m3.id, [0.3], "bge-base-en-v1.5")
			stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(0)
		})
	})

	// =========================================================================
	// Full Migration Simulation
	// =========================================================================

	describe("full migration simulation", () => {
		function storeVisual(desc: string) {
			return storage.storeVisualMemory({
				description: desc,
				mediaType: "image",
				source: "direct",
			})
		}

		it("simulates Ollama → native migration lifecycle", () => {
			// Phase 1: User had Ollama with nomic-embed-text
			const memories = Array.from({ length: 10 }, (_, i) =>
				storage.storeMemory({ content: `Ollama memory ${i}` })
			)
			const visuals = Array.from({ length: 3 }, (_, i) =>
				storeVisual(`Ollama visual ${i}`)
			)

			for (const m of memories) {
				storage.storeEmbedding(m.id, [Math.random()], "nomic-embed-text")
			}
			for (const v of visuals) {
				storage.storeVisualEmbedding(v.id, [Math.random()], "nomic-embed-text")
			}

			let stats = storage.getStats()
			expect(stats.embeddingCount).toBe(10)
			expect(stats.pendingEmbeddingCount).toBe(0)
			expect(stats.pendingVisualEmbeddingCount).toBe(0)

			// Phase 2: Migration — detect and delete stale
			const staleText = storage.countEmbeddingsNotMatching("bge-base-en-v1.5")
			const staleVisual =
				storage.countVisualEmbeddingsNotMatching("bge-base-en-v1.5")
			expect(staleText).toBe(10)
			expect(staleVisual).toBe(3)

			const deletedText =
				storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")
			const deletedVisual =
				storage.deleteVisualEmbeddingsNotMatching("bge-base-en-v1.5")
			expect(deletedText).toBe(10)
			expect(deletedVisual).toBe(3)

			stats = storage.getStats()
			expect(stats.embeddingCount).toBe(0)
			expect(stats.pendingEmbeddingCount).toBe(10)
			expect(stats.pendingVisualEmbeddingCount).toBe(3)

			// Phase 3: Background re-embedding (batch of 5)
			const batch1 = storage.getMemoriesWithoutEmbeddings(5)
			expect(batch1.length).toBe(5)
			for (const m of batch1) {
				storage.storeEmbedding(m.id, [Math.random()], "bge-base-en-v1.5")
			}

			stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(5)
			expect(stats.embeddingCount).toBe(5)

			// Phase 4: Second batch completes text
			const batch2 = storage.getMemoriesWithoutEmbeddings(5)
			expect(batch2.length).toBe(5)
			for (const m of batch2) {
				storage.storeEmbedding(m.id, [Math.random()], "bge-base-en-v1.5")
			}

			stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(0)
			expect(stats.embeddingCount).toBe(10)

			// Phase 5: Visual re-embedding
			const pendingVisuals = storage.getVisualMemoriesWithoutEmbeddings(10)
			expect(pendingVisuals.length).toBe(3)
			for (const v of pendingVisuals) {
				storage.storeVisualEmbedding(v.id, [Math.random()], "bge-base-en-v1.5")
			}

			stats = storage.getStats()
			expect(stats.pendingVisualEmbeddingCount).toBe(0)

			// Phase 6: Verify no more stale
			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(0)
			expect(storage.countVisualEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(
				0
			)
		})

		it("simulates OpenAI → native migration lifecycle", () => {
			const memories = Array.from({ length: 5 }, (_, i) =>
				storage.storeMemory({ content: `OpenAI memory ${i}` })
			)

			for (const m of memories) {
				storage.storeEmbedding(m.id, [Math.random()], "text-embedding-3-small")
			}

			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(5)

			const deleted = storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")
			expect(deleted).toBe(5)

			const pending = storage.getMemoriesWithoutEmbeddings()
			expect(pending.length).toBe(5)
		})
	})

	// =========================================================================
	// Edge Cases
	// =========================================================================

	describe("edge cases", () => {
		function storeVisual(desc: string) {
			return storage.storeVisualMemory({
				description: desc,
				mediaType: "image",
				source: "direct",
			})
		}

		it("handles empty database gracefully", () => {
			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(0)
			expect(storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(0)
			expect(storage.countVisualEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(
				0
			)
			expect(
				storage.deleteVisualEmbeddingsNotMatching("bge-base-en-v1.5")
			).toBe(0)

			const stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(0)
			expect(stats.pendingVisualEmbeddingCount).toBe(0)
		})

		it("handles memories with no embeddings at all (fresh install)", () => {
			storage.storeMemory({ content: "Fresh memory 1" })
			storage.storeMemory({ content: "Fresh memory 2" })
			storeVisual("Fresh visual")

			// Nothing to migrate
			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(0)
			expect(storage.countVisualEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(
				0
			)

			// But they still show as pending
			const stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(2)
			expect(stats.pendingVisualEmbeddingCount).toBe(1)
		})

		it("cascade-deletes embeddings when memory is deleted", () => {
			const m1 = storage.storeMemory({ content: "Will be deleted" })
			storage.storeEmbedding(m1.id, [0.1, 0.2], "nomic-embed-text")

			expect(storage.getEmbedding(m1.id)).not.toBeNull()

			storage.deleteMemory(m1.id)
			expect(storage.getEmbedding(m1.id)).toBeNull()

			// Should not count as stale either
			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(0)
		})

		it("re-embedding overwrites old embedding", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })

			// First embedding (Ollama)
			storage.storeEmbedding(m1.id, [0.1, 0.2, 0.3], "nomic-embed-text")
			const old = storage.getEmbedding(m1.id)
			expect(old?.length).toBe(3)

			// Overwrite with BGE (different dimension)
			storage.storeEmbedding(m1.id, [0.4, 0.5, 0.6, 0.7], "bge-base-en-v1.5")
			const updated = storage.getEmbedding(m1.id)
			expect(updated?.length).toBe(4)

			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(0)
		})

		it("handles model names with special characters", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			storage.storeEmbedding(m1.id, [0.1], "text-embedding-3-small")

			// Model names with hyphens, dots, slashes
			expect(storage.countEmbeddingsNotMatching("text-embedding-3-small")).toBe(
				0
			)
			expect(storage.countEmbeddingsNotMatching("bge-base-en-v1.5")).toBe(1)
		})

		it("getMemoriesWithoutEmbeddings respects limit", () => {
			for (let i = 0; i < 20; i++) {
				storage.storeMemory({ content: `Memory ${i}` })
			}

			const batch5 = storage.getMemoriesWithoutEmbeddings(5)
			expect(batch5.length).toBe(5)

			const batch10 = storage.getMemoriesWithoutEmbeddings(10)
			expect(batch10.length).toBe(10)

			const batchAll = storage.getMemoriesWithoutEmbeddings(100)
			expect(batchAll.length).toBe(20)
		})

		it("getVisualMemoriesWithoutEmbeddings respects limit", () => {
			for (let i = 0; i < 10; i++) {
				storeVisual(`Visual ${i}`)
			}

			const batch3 = storage.getVisualMemoriesWithoutEmbeddings(3)
			expect(batch3.length).toBe(3)

			const batchAll = storage.getVisualMemoriesWithoutEmbeddings(100)
			expect(batchAll.length).toBe(10)
		})

		it("concurrent text and visual migration does not interfere", () => {
			const m1 = storage.storeMemory({ content: "Text memory" })
			const v1 = storeVisual("Visual memory")

			storage.storeEmbedding(m1.id, [0.1], "nomic-embed-text")
			storage.storeVisualEmbedding(v1.id, [0.2], "nomic-embed-text")

			// Delete text embeddings only
			storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")

			// Visual embedding should still be there
			expect(storage.hasVisualEmbedding(v1.id)).toBe(true)
			expect(storage.getEmbedding(m1.id)).toBeNull()

			// Delete visual embeddings
			storage.deleteVisualEmbeddingsNotMatching("bge-base-en-v1.5")
			expect(storage.hasVisualEmbedding(v1.id)).toBe(false)
		})
	})

	// =========================================================================
	// Index Verification
	// =========================================================================

	describe("indexes", () => {
		it("model indexes exist on embeddings and visual_embeddings", () => {
			// biome-ignore lint/complexity/useLiteralKeys: accessing private db for test verification
			const indexes = storage["db"]
				.prepare(
					`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE '%model%'`
				)
				.all() as { name: string; tbl_name: string }[]

			const indexNames = indexes.map((i) => i.name)
			expect(indexNames).toContain("idx_embeddings_model")
			expect(indexNames).toContain("idx_visual_embeddings_model")

			// Verify they're on the right tables
			const embIdx = indexes.find((i) => i.name === "idx_embeddings_model")
			expect(embIdx?.tbl_name).toBe("embeddings")

			const visIdx = indexes.find(
				(i) => i.name === "idx_visual_embeddings_model"
			)
			expect(visIdx?.tbl_name).toBe("visual_embeddings")
		})

		it("migration queries use the model index (EXPLAIN QUERY PLAN)", () => {
			// biome-ignore lint/complexity/useLiteralKeys: accessing private db for test verification
			const plan = storage["db"]
				.prepare(
					`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM embeddings WHERE model != ?`
				)
				.all("bge-base-en-v1.5") as { detail: string }[]

			const planText = plan.map((r) => r.detail).join(" ")
			// Should use the index, not a full table scan
			expect(
				planText.includes("idx_embeddings_model") || planText.includes("SEARCH")
			).toBe(true)
		})
	})

	// =========================================================================
	// Scale Test
	// =========================================================================

	describe("scale", () => {
		it("handles migration of 500 embeddings efficiently", () => {
			// Store 500 memories with Ollama embeddings
			const ids: string[] = []
			for (let i = 0; i < 500; i++) {
				const m = storage.storeMemory({ content: `Scale test memory ${i}` })
				ids.push(m.id)
			}

			// Batch-insert embeddings
			for (const id of ids) {
				storage.storeEmbedding(
					id,
					[Math.random(), Math.random()],
					"nomic-embed-text"
				)
			}

			const start = performance.now()

			// Count stale
			const stale = storage.countEmbeddingsNotMatching("bge-base-en-v1.5")
			expect(stale).toBe(500)

			// Delete stale
			const deleted = storage.deleteEmbeddingsNotMatching("bge-base-en-v1.5")
			expect(deleted).toBe(500)

			// Verify all pending
			const stats = storage.getStats()
			expect(stats.pendingEmbeddingCount).toBe(500)
			expect(stats.embeddingCount).toBe(0)

			const elapsed = performance.now() - start
			// Count + delete + stats on 500 rows should be well under 1 second
			expect(elapsed).toBeLessThan(1000)

			// Re-embed in batches of 10 (simulating background processor)
			let totalProcessed = 0
			while (totalProcessed < 500) {
				const batch = storage.getMemoriesWithoutEmbeddings(10)
				if (batch.length === 0) break
				for (const m of batch) {
					storage.storeEmbedding(
						m.id,
						[Math.random(), Math.random()],
						"bge-base-en-v1.5"
					)
				}
				totalProcessed += batch.length
			}

			expect(totalProcessed).toBe(500)
			expect(storage.getStats().pendingEmbeddingCount).toBe(0)
		})
	})
})
