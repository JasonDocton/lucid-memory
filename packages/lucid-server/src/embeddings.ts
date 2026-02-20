/**
 * Embedding Pipeline
 *
 * Converts text to vectors for semantic search.
 * Supports native in-process ONNX (BGE-base-en-v1.5), Ollama (legacy), and OpenAI (cloud).
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Simple file logger for embedding failures
const logDir = join(homedir(), ".lucid", "logs")
const logFile = join(logDir, "embeddings.log")

// Log rotation settings
const maxLogSize = 10 * 1024 * 1024 // 10MB
const maxOldLogs = 5

/**
 * Rotate log file if it exceeds maxLogSize.
 * Creates sequential backups: embeddings.log.1, embeddings.log.2, etc.
 */
function rotateLogIfNeeded(): void {
	try {
		if (!existsSync(logFile)) return

		const stats = statSync(logFile)
		if (stats.size < maxLogSize) return

		// Rotate existing old logs (shift numbers up)
		// Delete oldest if at max
		const oldestLog = `${logFile}.${maxOldLogs}`
		if (existsSync(oldestLog)) {
			unlinkSync(oldestLog)
		}

		// Shift .4 -> .5, .3 -> .4, .2 -> .3, .1 -> .2
		for (let i = maxOldLogs - 1; i >= 1; i--) {
			const older = `${logFile}.${i}`
			const newer = `${logFile}.${i + 1}`
			if (existsSync(older)) {
				renameSync(older, newer)
			}
		}

		// Rename current log to .1
		renameSync(logFile, `${logFile}.1`)
	} catch {
		// Silently fail - rotation is best-effort
	}
}

function logError(message: string, error?: Error): void {
	try {
		if (!existsSync(logDir)) {
			mkdirSync(logDir, { recursive: true })
		}
		rotateLogIfNeeded()
		const timestamp = new Date().toISOString()
		const errorDetail = error ? `: ${error.message}` : ""
		appendFileSync(logFile, `[${timestamp}] ERROR: ${message}${errorDetail}\n`)
	} catch {
		// Silently fail if we can't write logs
	}
}

function logWarn(message: string): void {
	try {
		if (!existsSync(logDir)) {
			mkdirSync(logDir, { recursive: true })
		}
		rotateLogIfNeeded()
		const timestamp = new Date().toISOString()
		appendFileSync(logFile, `[${timestamp}] WARN: ${message}\n`)
	} catch {
		// Silently fail if we can't write logs
	}
}

export type EmbeddingProvider = "native" | "ollama" | "openai"

export interface EmbeddingConfig {
	provider: EmbeddingProvider
	model?: string
	ollamaHost?: string
	openaiApiKey?: string
}

export interface EmbeddingResult {
	vector: number[]
	model: string
	dimensions: number
}

export interface ProviderDiagnostics {
	nativeStatus:
		| "loaded"
		| "load_failed"
		| "files_missing"
		| "module_unavailable"
	nativeError?: string
	ollamaStatus?: "connected" | "no_model" | "timeout" | "refused" | "error"
	ollamaError?: string
	openaiAvailable: boolean
}

export interface DetectProviderResult {
	config: EmbeddingConfig | null
	diagnostics: ProviderDiagnostics
}

const defaultOllamaHost = "http://localhost:11434"
const defaultOllamaModel = "nomic-embed-text"
const defaultOpenaiModel = "text-embedding-3-small"

// Native embedding module (loaded with try/catch)
let nativeEmbedding: {
	loadEmbeddingModel: (
		modelPath?: string | null,
		tokenizerPath?: string | null
	) => boolean
	isEmbeddingModelLoaded: () => boolean
	isEmbeddingModelAvailable: (
		modelPath?: string | null,
		tokenizerPath?: string | null
	) => boolean
	embed: (text: string) => {
		vector: number[]
		model: string
		dimensions: number
	}
	embedBatch: (
		texts: string[]
	) => Array<{ vector: number[]; model: string; dimensions: number }>
} | null = null

try {
	// biome-ignore lint/style/noCommonJs: Dynamic require for native module with fallback
	const native = require("@lucid-memory/native")
	if (native.loadEmbeddingModel) {
		nativeEmbedding = native
	}
} catch {
	// Native module not available
}

/**
 * Try to load the native embedding model.
 * Returns { success, error? } so callers can report specific failures.
 */
export function loadNativeEmbeddingModel(
	modelPath?: string,
	tokenizerPath?: string
): { success: boolean; error?: string } {
	if (!nativeEmbedding)
		return { success: false, error: "Native module not available" }
	try {
		const loaded = nativeEmbedding.loadEmbeddingModel(
			modelPath ?? null,
			tokenizerPath ?? null
		)
		return loaded
			? { success: true }
			: { success: false, error: "loadEmbeddingModel returned false" }
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error))
		logError("Failed to load native embedding model", err)
		return { success: false, error: err.message }
	}
}

/**
 * Check if native embedding model files exist.
 */
export function isNativeEmbeddingAvailable(): boolean {
	if (!nativeEmbedding) return false
	try {
		return nativeEmbedding.isEmbeddingModelAvailable(null, null)
	} catch {
		return false
	}
}

/**
 * Embedding client for generating vectors from text.
 */
export class EmbeddingClient {
	private config: EmbeddingConfig

	constructor(config: EmbeddingConfig) {
		this.config = config
	}

	/**
	 * Generate embedding for a single text.
	 */
	embed(text: string): Promise<EmbeddingResult> {
		if (this.config.provider === "native") {
			return this.embedNative(text)
		}
		if (this.config.provider === "ollama") {
			return this.embedOllama(text)
		}
		return this.embedOpenAI(text)
	}

	/**
	 * Generate embeddings for multiple texts.
	 */
	async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
		if (this.config.provider === "native") {
			return this.embedNativeBatch(texts)
		}
		if (this.config.provider === "openai") {
			return this.embedOpenAIBatch(texts)
		}

		// Ollama: process sequentially
		const results: EmbeddingResult[] = []
		for (const text of texts) {
			results.push(await this.embedOllama(text))
		}
		return results
	}

	/**
	 * Check if the embedding provider is available.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			if (this.config.provider === "native") {
				return nativeEmbedding?.isEmbeddingModelLoaded() ?? false
			}
			if (this.config.provider === "ollama") {
				const host = this.config.ollamaHost ?? defaultOllamaHost
				const response = await fetch(`${host}/api/tags`)
				return response.ok
			}
			// OpenAI: just check if API key exists
			return !!this.config.openaiApiKey
		} catch {
			return false
		}
	}

	/**
	 * Get the model being used.
	 */
	getModel(): string {
		if (this.config.provider === "native") {
			return "bge-base-en-v1.5"
		}
		if (this.config.provider === "ollama") {
			return this.config.model ?? defaultOllamaModel
		}
		return this.config.model ?? defaultOpenaiModel
	}

	// ============================================================================
	// Native (In-Process ONNX) Implementation
	// ============================================================================

	// biome-ignore lint/suspicious/useAwait: matches async interface of other providers (Ollama, OpenAI)
	private async embedNative(text: string): Promise<EmbeddingResult> {
		if (!nativeEmbedding) {
			throw new Error("Native embedding module not available")
		}
		const result = nativeEmbedding.embed(text)
		return {
			vector: result.vector,
			model: result.model,
			dimensions: result.dimensions,
		}
	}

	// biome-ignore lint/suspicious/useAwait: matches async interface of other providers (Ollama, OpenAI)
	private async embedNativeBatch(texts: string[]): Promise<EmbeddingResult[]> {
		if (!nativeEmbedding) {
			throw new Error("Native embedding module not available")
		}
		const results = nativeEmbedding.embedBatch(texts)
		return results.map((r) => ({
			vector: r.vector,
			model: r.model,
			dimensions: r.dimensions,
		}))
	}

	// ============================================================================
	// Ollama Implementation (Legacy)
	// ============================================================================

	private async embedOllama(text: string): Promise<EmbeddingResult> {
		const host = this.config.ollamaHost ?? defaultOllamaHost
		const model = this.config.model ?? defaultOllamaModel

		let response: Response
		try {
			response = await fetch(`${host}/api/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model, prompt: text }),
				signal: AbortSignal.timeout(30000), // 30 second timeout
			})
		} catch (error: unknown) {
			const err = error instanceof Error ? error : new Error(String(error))
			if ((err.cause as { code?: string })?.code === "ECONNREFUSED") {
				logError("Ollama connection refused - is Ollama running?", err)
				throw new Error(
					"Ollama is not running. Start it with: ollama serve\n" +
						"Or check status with: lucid status"
				)
			}
			if (err.name === "TimeoutError") {
				logError("Ollama request timed out", err)
				throw new Error(
					"Ollama request timed out. The service may be overloaded."
				)
			}
			logError("Ollama connection error", err)
			throw err
		}

		if (!response.ok) {
			const error = await response.text()
			logError(
				`Ollama embedding failed with status ${response.status}: ${error}`
			)
			throw new Error(`Ollama embedding failed: ${error}`)
		}

		const data = (await response.json()) as { embedding: number[] }

		return {
			vector: data.embedding,
			model,
			dimensions: data.embedding.length,
		}
	}

	// ============================================================================
	// OpenAI Implementation
	// ============================================================================

	private async embedOpenAI(text: string): Promise<EmbeddingResult> {
		const results = await this.embedOpenAIBatch([text])
		const result = results[0]
		if (!result) {
			throw new Error("No embedding result returned")
		}
		return result
	}

	private async embedOpenAIBatch(texts: string[]): Promise<EmbeddingResult[]> {
		const apiKey = this.config.openaiApiKey
		if (!apiKey) {
			throw new Error("OpenAI API key required")
		}

		const model = this.config.model ?? defaultOpenaiModel

		const response = await fetch("https://api.openai.com/v1/embeddings", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				input: texts,
			}),
		})

		if (!response.ok) {
			const error = await response.text()
			throw new Error(`OpenAI embedding failed: ${error}`)
		}

		const data = (await response.json()) as {
			data: { embedding: number[]; index: number }[]
		}

		// Sort by index to maintain order
		const sorted = data.data.sort((a, b) => a.index - b.index)

		return sorted.map((item) => ({
			vector: item.embedding,
			model,
			dimensions: item.embedding.length,
		}))
	}
}

/**
 * Auto-detect the best available embedding provider.
 *
 * Priority: native → OpenAI (env var) → Ollama (legacy) → null
 *
 * Returns both the config and diagnostics so callers can report
 * exactly why each provider was skipped.
 */
export async function detectProvider(): Promise<DetectProviderResult> {
	const diagnostics: ProviderDiagnostics = {
		nativeStatus: "module_unavailable",
		openaiAvailable: false,
	}

	// 1. Try native in-process embeddings (zero deps, best UX)
	if (!nativeEmbedding) {
		diagnostics.nativeStatus = "module_unavailable"
	} else if (nativeEmbedding.isEmbeddingModelLoaded?.()) {
		diagnostics.nativeStatus = "loaded"
		return {
			config: { provider: "native", model: "bge-base-en-v1.5" },
			diagnostics,
		}
	} else if (isNativeEmbeddingAvailable()) {
		// Model files exist — try loading
		const loadResult = loadNativeEmbeddingModel()
		if (loadResult.success) {
			diagnostics.nativeStatus = "loaded"
			return {
				config: { provider: "native", model: "bge-base-en-v1.5" },
				diagnostics,
			}
		}
		diagnostics.nativeStatus = "load_failed"
		diagnostics.nativeError = loadResult.error
	} else {
		diagnostics.nativeStatus = "files_missing"
	}

	// 2. Check for OpenAI API key in environment
	// biome-ignore lint/style/noProcessEnv: Config detection requires environment access
	const openaiKey = process.env.OPENAI_API_KEY
	diagnostics.openaiAvailable = !!openaiKey
	if (openaiKey) {
		return {
			config: { provider: "openai", openaiApiKey: openaiKey },
			diagnostics,
		}
	}

	// 3. Try Ollama (legacy fallback for users who have it installed)
	try {
		const response = await fetch(`${defaultOllamaHost}/api/tags`, {
			signal: AbortSignal.timeout(2000),
		})

		if (response.ok) {
			const data = (await response.json()) as { models: { name: string }[] }
			const hasModel = data.models?.some((m) =>
				m.name.includes("nomic-embed-text")
			)

			if (hasModel) {
				diagnostics.ollamaStatus = "connected"
				return {
					config: { provider: "ollama", model: defaultOllamaModel },
					diagnostics,
				}
			}
			diagnostics.ollamaStatus = "no_model"
			diagnostics.ollamaError = "nomic-embed-text model not found"
		} else {
			diagnostics.ollamaStatus = "error"
			diagnostics.ollamaError = `HTTP ${response.status}`
		}
	} catch (error: unknown) {
		const err = error instanceof Error ? error : new Error(String(error))
		if ((err.cause as { code?: string })?.code === "ECONNREFUSED") {
			diagnostics.ollamaStatus = "refused"
			diagnostics.ollamaError = "connection refused (not running)"
			logWarn("Ollama not running during provider detection")
		} else if (err.name === "TimeoutError") {
			diagnostics.ollamaStatus = "timeout"
			diagnostics.ollamaError = "connection timed out"
		} else {
			diagnostics.ollamaStatus = "error"
			diagnostics.ollamaError = err.message
		}
	}

	return { config: null, diagnostics }
}

/**
 * Normalize a vector to unit length.
 */
export function normalize(vector: number[]): number[] {
	let sum = 0
	for (const v of vector) {
		sum += v * v
	}
	const norm = Math.sqrt(sum)
	if (norm === 0) return vector
	return vector.map((v) => v / norm)
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error("Vectors must have same dimension")
	}

	let dotProduct = 0
	let normA = 0
	let normB = 0

	for (let i = 0; i < a.length; i++) {
		const ai = a[i] ?? 0
		const bi = b[i] ?? 0
		dotProduct += ai * bi
		normA += ai * ai
		normB += bi * bi
	}

	normA = Math.sqrt(normA)
	normB = Math.sqrt(normB)

	if (normA === 0 || normB === 0) return 0
	return dotProduct / (normA * normB)
}
