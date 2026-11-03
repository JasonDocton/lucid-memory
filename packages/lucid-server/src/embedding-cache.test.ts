import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LucidRetrieval } from "./retrieval.ts"
import { LucidStorage } from "./storage.ts"

let dir: string
let dbPath: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lucid-cache-"))
	dbPath = join(dir, "memory.db")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function legacyDatabase() {
	const storage = new LucidStorage({ dbPath })
	const m = storage.storeMemory({ content: "legacy" })
	const v = storage.storeVisualMemory({
		description: "legacy visual",
		mediaType: "image",
		source: "direct",
	})
	storage.close()
	const db = new Database(dbPath)
	db.exec(`
		DROP TRIGGER invalidate_embeddings; DROP TRIGGER invalidate_visual_embeddings;
		DROP TABLE embeddings; DROP TABLE visual_embeddings;
		CREATE TABLE embeddings(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE, vector BLOB NOT NULL, model TEXT NOT NULL);
		CREATE TABLE visual_embeddings(visual_memory_id TEXT PRIMARY KEY REFERENCES visual_memories(id) ON DELETE CASCADE, vector BLOB NOT NULL, model TEXT NOT NULL);
	`)
	const bytes = new Uint8Array(new Float32Array([0.25, 0.75]).buffer)
	db.query("INSERT INTO embeddings VALUES (?,?,'legacy')").run(m.id, bytes)
	db.query("INSERT INTO visual_embeddings VALUES (?,?,'legacy')").run(
		v.id,
		bytes
	)
	return { db, m, v }
}

it("upgrades both legacy caches without losing vectors; current-schema readers do not take a writer lock", () => {
	const { db, m, v } = legacyDatabase()
	const first = new LucidStorage({ dbPath })
	const space = { model: "legacy", dimensions: 2 }
	try {
		expect(first.getEmbedding(m.id, space)).toEqual([0.25, 0.75])
		expect(first.getVisualEmbedding(v.id, space)).toEqual([0.25, 0.75])
		db.exec("BEGIN IMMEDIATE")
		try {
			const reader = new LucidStorage({ dbPath })
			try {
				expect(reader.getStats(space).embeddingCount).toBe(1)
				expect(reader.getStats(space).pendingVisualEmbeddingCount).toBe(0)
			} finally {
				reader.close()
			}
		} finally {
			db.exec("ROLLBACK")
		}
	} finally {
		first.close()
		db.close()
	}
})

it("rolls back the entire upgrade if either legacy table cannot be copied", () => {
	const { db } = legacyDatabase()
	try {
		db.exec(
			"PRAGMA foreign_keys=OFF; INSERT INTO visual_embeddings VALUES ('orphan', X'00', 'legacy')"
		)
		expect(() => new LucidStorage({ dbPath })).toThrow()
		for (const [table, key] of [
			["embeddings", "memory_id"],
			["visual_embeddings", "visual_memory_id"],
		]) {
			expect(
				db
					.query("SELECT pk FROM pragma_table_info(?) WHERE name=?")
					.get(table, key)
			).toEqual({ pk: 1 })
		}
		expect(db.query("SELECT count(*) AS n FROM embeddings").get()).toEqual({
			n: 1,
		})
		expect(
			db.query("SELECT count(*) AS n FROM visual_embeddings").get()
		).toEqual({ n: 2 })
	} finally {
		db.close()
	}
})

it("two servers keep local and fallback caches across reopen, edits and deletes", async () => {
	const local = new LucidRetrieval({ dbPath })
	const fallback = new LucidRetrieval({ dbPath })
	let calls = 0
	const mocked = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			(_: Parameters<typeof fetch>[0], init?: RequestInit) => {
				calls++
				const { input } = JSON.parse(String(init?.body)) as { input: string[] }
				return Promise.resolve(
					Response.json({
						data: input.map((_, index) => ({ index, embedding: [1, 0] })),
					})
				)
			},
			{ preconnect: fetch.preconnect }
		)
	)
	try {
		local.setEmbeddingConfig({
			provider: "openai",
			model: "alias",
			openaiBaseUrl: "http://localhost:42424/v1",
		})
		fallback.setEmbeddingConfig({
			provider: "openai",
			model: "text-embedding-3-small",
			openaiApiKey: "synthetic",
		})
		const m = local.storage.storeMemory({ content: "previous" })
		const v = local.storage.storeVisualMemory({
			description: "previous visual",
			mediaType: "image",
			source: "direct",
		})
		for (const r of [local, fallback]) {
			expect(await r.processPendingEmbeddings()).toBe(1)
			expect(await r.processPendingVisualEmbeddings()).toBe(1)
		}
		const firstCalls = calls
		for (const r of [local, fallback, local]) {
			expect(await r.processPendingEmbeddings()).toBe(0)
			expect(await r.processPendingVisualEmbeddings()).toBe(0)
		}
		expect(calls).toBe(firstCalls)
		const reader = new LucidStorage({ dbPath })
		try {
			expect(reader.getStats().embeddingCount).toBe(1)
			for (const space of [
				local.getEmbeddingSpace(),
				fallback.getEmbeddingSpace(),
			]) {
				expect(reader.getEmbedding(m.id, space)).toEqual([1, 0])
				expect(reader.getVisualEmbedding(v.id, space)).toEqual([1, 0])
			}
			reader.updateMemory(m.id, { content: "edited" })
			reader.deleteVisualMemory(v.id)
			for (const space of [
				local.getEmbeddingSpace(),
				fallback.getEmbeddingSpace(),
			]) {
				expect(reader.getEmbedding(m.id, space)).toBeNull()
				expect(reader.getVisualEmbedding(v.id, space)).toBeNull()
				expect(reader.getStats(space).pendingEmbeddingCount).toBe(1)
			}
		} finally {
			reader.close()
		}
	} finally {
		mocked.mockRestore()
		local.close()
		fallback.close()
	}
})

it("rolls back a reconsolidation if its replacement vector cannot be written", () => {
	const s = new LucidStorage({ dbPath })
	const db = new Database(dbPath)
	try {
		const memory = s.storeMemory({ content: "old text" })
		s.storeEmbedding(memory.id, [1, 0], "model")
		db.exec(
			"CREATE TRIGGER test_failure BEFORE INSERT ON embeddings BEGIN SELECT RAISE(ABORT, 'simulated failure'); END"
		)
		expect(() =>
			s.reconsolidateMemory(memory.id, "new text", "gist", [0, 1], "model")
		).toThrow("simulated failure")
		expect(s.getMemory(memory.id)?.content).toBe("old text")
		expect(s.getEmbedding(memory.id)).toEqual([1, 0])
	} finally {
		db.close()
		s.close()
	}
})
