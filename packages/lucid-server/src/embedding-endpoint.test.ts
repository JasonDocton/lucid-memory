import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { env } from "node:process"
import {
	detectProvider,
	EmbeddingClient,
	type EmbeddingConfig,
} from "./embeddings.ts"
import { LucidRetrieval } from "./retrieval.ts"

const base = "http://one.test/v1"
const config: EmbeddingConfig = {
	provider: "openai",
	openaiBaseUrl: base,
	model: "shared-alias",
}
const originalUrl = env.LUCID_EMBEDDING_URL
const originalModel = env.LUCID_EMBEDDING_MODEL
const originalKey = env.OPENAI_API_KEY
let fetchMock: ReturnType<typeof mockFetch>
let retrieval: LucidRetrieval

function mockFetch() {
	return spyOn(globalThis, "fetch")
}

function mockVectors(width = 2): void {
	fetchMock.mockImplementation(
		Object.assign(
			(_: Parameters<typeof fetch>[0], init?: RequestInit) =>
				Promise.resolve(vectors(JSON.parse(String(init?.body)).input, width)),
			{ preconnect: fetch.preconnect }
		)
	)
}

function vectors(input: string[], width: number): Response {
	// Reverse the result order, preserving OpenAI-compatible input indices.
	return Response.json({
		data: input
			.map((_, index) => ({
				index,
				embedding: [1, ...Array<number>(width - 1).fill(0)],
			}))
			.reverse(),
	})
}

beforeEach(() => {
	fetchMock = mockFetch()
	mockVectors()
	retrieval = new LucidRetrieval({ dbPath: ":memory:" })
	env.LUCID_EMBEDDING_URL = base
	delete env.LUCID_EMBEDDING_MODEL
})

afterEach(() => {
	fetchMock.mockRestore()
	retrieval.close()
	if (originalUrl === undefined) delete env.LUCID_EMBEDDING_URL
	else env.LUCID_EMBEDDING_URL = originalUrl
	if (originalModel === undefined) delete env.LUCID_EMBEDDING_MODEL
	else env.LUCID_EMBEDDING_MODEL = originalModel
	if (originalKey === undefined) delete env.OPENAI_API_KEY
	else env.OPENAI_API_KEY = originalKey
})

it("selects a keyless endpoint only after it embeds the requested model", async () => {
	env.LUCID_EMBEDDING_URL = `${base}/`
	env.LUCID_EMBEDDING_MODEL = "local-encoder"
	env.OPENAI_API_KEY = "cloud-key-must-stay-local-to-the-process"
	const timeout = spyOn(AbortSignal, "timeout")
	let result: Awaited<ReturnType<typeof detectProvider>>
	try {
		result = await detectProvider()
		expect(timeout).toHaveBeenCalledWith(30_000)
	} finally {
		timeout.mockRestore()
	}
	expect(result.config?.model).toBe("local-encoder")
	expect(fetchMock).toHaveBeenCalledTimes(1)
	const [url, options] = fetchMock.mock.calls[0] ?? []
	expect(String(url)).toBe(`${base}/embeddings`)
	expect(options?.method).toBe("POST")
	expect(options?.signal).toBeInstanceOf(AbortSignal)
	expect(new Headers(options?.headers).has("authorization")).toBe(false)
	expect(JSON.parse(String(options?.body)).model).toBe("local-encoder")
	expect(result.config?.dimensions).toBe(2)
})

it("falls through to the existing providers on failure, including loaded BGE", () => {
	// Isolate the native module stub from other suites. No weights or listening sockets needed.
	const child = Bun.spawnSync({
		cmd: [
			process.execPath,
			"-e",
			`
			import { mock } from "bun:test"
			let loaded = true
			mock.module("@lucid-memory/native", () => ({
				loadEmbeddingModel: () => loaded,
				isEmbeddingModelLoaded: () => loaded,
				isEmbeddingModelAvailable: () => false,
			}))
			const { detectProvider } = await import("./embeddings.ts")
			let mode = "refused"
			globalThis.fetch = async url => {
				if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "chat-only" }] })
				if (String(url).endsWith("/api/tags")) return Response.json({ models: mode === "ollama" ? [{ name: "nomic-embed-text" }] : [] })
				if (mode === "refused") throw new Error("connection refused")
				if (mode === "timeout") throw new DOMException("probe timed out", "TimeoutError")
				return new Response("model cannot embed", { status: 400 })
			}
			const results = []
			const check = async () => {
				const result = await detectProvider()
				results.push([result.config?.provider ?? null, !!result.diagnostics.endpointError])
			}
			for (mode of ["refused", "timeout", "wrong model"]) await check()
			process.env.LUCID_EMBEDDING_URL = "not a URL"
			await check()
			delete process.env.LUCID_EMBEDDING_URL
			await check()
			process.env.LUCID_EMBEDDING_URL = "http://one.test/v1"
			loaded = false
			process.env.OPENAI_API_KEY = "test-key"
			await check()
			delete process.env.OPENAI_API_KEY
			mode = "ollama"
			await check()
			mode = "none"
			await check()
			console.log(JSON.stringify(results))
		`,
		],
		cwd: import.meta.dir,
		env: { ...env, LUCID_EMBEDDING_URL: base },
	})
	expect(child.exitCode).toBe(0)
	expect(JSON.parse(child.stdout.toString())).toEqual([
		["native", true],
		["native", true],
		["native", true],
		["native", true],
		["native", false],
		["openai", true],
		["ollama", true],
		[null, true],
	])
})

it("shows the effective model in CLI status and never probes twice", () => {
	const child = Bun.spawnSync({
		cmd: [
			process.execPath,
			"-e",
			`
			const file = Bun.file.bind(Bun)
			Bun.file = (path, ...args) => String(path).endsWith("/.lucid/config.json")
				? { exists: async () => true, json: async () => ({
					databaseMode: "profiles", profiles: { default: { dbPath: ":memory:" } }
				}) } : file(path, ...args)
			globalThis.fetch = async (url) => {
				console.log("STATUS_PROBE", String(url))
				return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
			}
			process.argv = [process.execPath, "cli.ts", "status"]
			await import("./cli.ts")
		`,
		],
		cwd: import.meta.dir,
		env: { ...env, LUCID_EMBEDDING_URL: base },
	})
	const output = child.stdout.toString()
	expect(child.exitCode).toBe(0)
	expect(output).toContain("Model: text-embedding-3-small")
	expect(output).toContain("Status: ✓ ready")
	expect(output.match(/STATUS_PROBE/g)).toHaveLength(1)
	expect(output).toContain(`STATUS_PROBE ${base}/embeddings`)
})

it("preserves text and visual embeddings across URL-only restarts", async () => {
	const first = (await detectProvider()).config
	if (!first) throw new Error("Missing endpoint")
	retrieval.setEmbeddingConfig(first)
	const memory = await retrieval.store("A red kite")
	const visual = await retrieval.storeVisual({
		description: "A red kite",
		mediaType: "image",
		source: "direct",
	})
	const restart = (await detectProvider()).config
	if (!restart) throw new Error("Missing endpoint on restart")
	retrieval.setEmbeddingConfig(restart)
	retrieval.migrateEmbeddingsIfNeeded(restart)
	expect(retrieval.storage.getEmbedding(memory.id)).toEqual([1, 0])
	expect(retrieval.storage.getVisualEmbedding(visual.id)).toEqual([1, 0])
	expect(await retrieval.processPendingEmbeddings()).toBe(0)
	expect(await retrieval.processPendingVisualEmbeddings()).toBe(0)
	expect(restart.model).toBe("text-embedding-3-small")
})

for (const change of ["model", "endpoint", "width"] as const) {
	it(`skips stale text and visuals when ${change} changes and rebuilds both`, async () => {
		const previous = { ...config, dimensions: 2 }
		retrieval.setEmbeddingConfig(previous)
		const memory = await retrieval.store("Old text")
		const visual = await retrieval.storeVisual({
			description: "Old image",
			mediaType: "image",
			source: "direct",
		})
		const width = change === "width" ? 3 : 2
		const next = {
			...previous,
			dimensions: width,
			openaiBaseUrl: change === "endpoint" ? "http://two.test/v1" : base,
			model: change === "model" ? "new-model" : previous.model,
		}
		mockVectors(width)
		// The CLI sets the config without running the server startup migration.
		retrieval.setEmbeddingConfig(next)
		expect((await retrieval.retrieve("query")).candidates).toHaveLength(0)
		expect(await retrieval.retrieveVisual("query")).toHaveLength(0)
		const fresh = await retrieval.store("Distinct new memory")
		expect(fresh.id).not.toBe(memory.id)
		expect(retrieval.storage.getAssociations(fresh.id)).toHaveLength(0)
		expect(
			(await retrieval.retrieve("query")).candidates.map((c) => c.memory.id)
		).toEqual([fresh.id])
		expect(await retrieval.processPendingEmbeddings()).toBe(1)
		expect(await retrieval.processPendingVisualEmbeddings()).toBe(1)
		expect(
			(await retrieval.retrieve("query")).candidates.map((c) => c.memory.id)
		).toContain(memory.id)
		expect(
			(await retrieval.retrieveVisual("query")).map((c) => c.visual.id)
		).toEqual([visual.id])
		expect(await retrieval.processPendingEmbeddings()).toBe(0)
		expect(await retrieval.processPendingVisualEmbeddings()).toBe(0)
	})
}

it("rebuilds a changed width even if a library caller starts the worker before its first query", async () => {
	retrieval.setEmbeddingConfig(config)
	const memory = await retrieval.store("text")
	const visual = await retrieval.storeVisual({
		description: "image",
		mediaType: "image",
		source: "direct",
	})
	mockVectors(3)
	retrieval.setEmbeddingConfig(config)
	expect(await retrieval.processPendingEmbeddings()).toBe(1)
	expect(await retrieval.processPendingVisualEmbeddings()).toBe(1)
	expect(retrieval.storage.getEmbedding(memory.id)).toHaveLength(3)
	expect(retrieval.storage.getVisualEmbedding(visual.id)).toHaveLength(3)
})

it("never reinforces a different model's memory just because its vector is identical", async () => {
	retrieval.setEmbeddingConfig(config)
	const old = await retrieval.store("The old model embedded this memory")
	retrieval.setEmbeddingConfig({ ...config, model: "different-model" })
	const fresh = await retrieval.store("An unrelated new memory")
	expect(fresh.id).not.toBe(old.id)
	expect(retrieval.storage.getMemory(old.id)?.content).toBe(old.content)
	expect(retrieval.storage.getAssociations(fresh.id)).toHaveLength(0)
})

it("keeps a usable BGE index when the preferred endpoint fails at startup", () => {
	const child = Bun.spawnSync({
		cmd: [
			process.execPath,
			"-e",
			`
			import { mock } from "bun:test"
			mock.module("@lucid-memory/native", () => ({
				loadEmbeddingModel: () => true, isEmbeddingModelLoaded: () => true,
			}))
			globalThis.fetch = async () => new Response("unavailable", { status: 503 })
			const { detectProvider } = await import("./embeddings.ts")
			const { LucidRetrieval } = await import("./retrieval.ts")
			const r = new LucidRetrieval({ dbPath: ":memory:" })
			const text = r.storage.storeMemory({ content: "text" })
			const visual = r.storage.storeVisualMemory({ description: "image", mediaType: "image", source: "direct" })
			const vector = Array(768).fill(1)
			r.storage.storeEmbedding(text.id, vector, "bge-base-en-v1.5")
			r.storage.storeVisualEmbedding(visual.id, vector, "bge-base-en-v1.5")
			const { config } = await detectProvider()
			r.setEmbeddingConfig(config)
			r.migrateEmbeddingsIfNeeded(config)
			console.log("retained", r.storage.hasEmbedding(text.id), r.storage.hasVisualEmbedding(visual.id))
			r.storage.close()
		`,
		],
		cwd: import.meta.dir,
		env: {
			...env,
			LUCID_EMBEDDING_URL: base,
			LUCID_EMBEDDING_MODEL: "local-encoder",
		},
	})
	expect(child.exitCode).toBe(0)
	expect(child.stdout.toString()).toContain("retained true true")
})

it("requeues native caches only when a working external model is selected", async () => {
	const memory = retrieval.storage.storeMemory({ content: "legacy" })
	const visual = retrieval.storage.storeVisualMemory({
		description: "legacy",
		mediaType: "image",
		source: "direct",
	})
	retrieval.storage.storeEmbedding(memory.id, [0, 1], "bge-base-en-v1.5")
	retrieval.storage.storeVisualEmbedding(visual.id, [0, 1], "bge-base-en-v1.5")
	const next = (await detectProvider()).config
	if (!next) throw new Error("Missing endpoint")
	retrieval.setEmbeddingConfig(next)
	retrieval.migrateEmbeddingsIfNeeded(next)
	const space = retrieval.getEmbeddingSpace()
	expect(retrieval.storage.getStats(space).pendingEmbeddingCount).toBe(1)
	expect(retrieval.storage.getStats(space).pendingVisualEmbeddingCount).toBe(1)
	expect(retrieval.storage.getVisualEmbedding(visual.id, space)).toBeNull()
	fetchMock.mockRejectedValue(new Error("endpoint went offline after startup"))
	expect(await retrieval.processPendingEmbeddings()).toBe(0)
	expect(await retrieval.processPendingVisualEmbeddings()).toBe(0)
	expect(retrieval.storage.getEmbedding(memory.id)).toEqual([0, 1])
	expect(retrieval.storage.getVisualEmbedding(visual.id)).toEqual([0, 1])
	mockVectors()
	expect(await retrieval.processPendingEmbeddings()).toBe(1)
	expect(await retrieval.processPendingVisualEmbeddings()).toBe(1)
	expect(retrieval.storage.getEmbedding(memory.id)).toEqual([1, 0])
	expect(retrieval.storage.getVisualEmbedding(visual.id)).toEqual([1, 0])
})

it("rejects incomplete or malformed batches before associating vectors with memories", async () => {
	const a = retrieval.storage.storeMemory({ content: "a" })
	const b = retrieval.storage.storeMemory({ content: "b" })
	retrieval.setEmbeddingConfig({ ...config, dimensions: 2 })
	for (const data of [
		[{ index: 1, embedding: [1, 0] }],
		[
			{ index: 0, embedding: [1, 0] },
			{ index: 0, embedding: [0, 1] },
		],
		[
			{ index: 0, embedding: [1, 0] },
			{ index: 1, embedding: [] },
		],
		[
			{ index: 0, embedding: [1, 0] },
			{ index: 1, embedding: ["bad", 0] },
		],
		[
			{ index: 0, embedding: [1, 0] },
			{ index: 1, embedding: [0, 1, 0] },
		],
	]) {
		fetchMock.mockResolvedValue(Response.json({ data }))
		expect(await retrieval.processPendingEmbeddings()).toBe(0)
		expect(retrieval.storage.getEmbedding(a.id)).toBeNull()
		expect(retrieval.storage.getEmbedding(b.id)).toBeNull()
	}
	fetchMock.mockResolvedValue(
		Response.json({
			data: [
				{ index: 1, embedding: [0, 1] },
				{ index: 0, embedding: [1, 0] },
			],
		})
	)
	expect(await retrieval.processPendingEmbeddings()).toBe(2)
	expect(retrieval.storage.getEmbedding(a.id)).toEqual([1, 0])
	expect(retrieval.storage.getEmbedding(b.id)).toEqual([0, 1])
})

it("degrades both retrieval paths if the selected endpoint goes offline", async () => {
	retrieval.setEmbeddingConfig(config)
	await retrieval.store("text")
	const visual = await retrieval.storeVisual({
		description: "image",
		mediaType: "image",
		source: "direct",
	})
	fetchMock.mockRejectedValue(new Error("offline"))
	expect(await new EmbeddingClient(config).isAvailable()).toBe(false)
	expect((await retrieval.retrieve("query")).method).toBe("recency")
	const results = await retrieval.retrieveVisual("query")
	expect(results[0]?.visual.id).toBe(visual.id)
	expect(results[0]?.similarity).toBe(0)
})
