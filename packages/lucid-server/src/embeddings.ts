/**
 * Embedding Pipeline
 *
 * Converts text to vectors for semantic search.
 * Supports Ollama (local, free) and OpenAI (cloud, paid).
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Simple file logger for embedding failures
const logDir = join(homedir(), ".lucid", "logs")
const logFile = join(logDir, "embeddings.log")

function logError(message: string, error?: Error): void {
	try {
		if (!existsSync(logDir)) {
			mkdirSync(logDir, { recursive: true })
		}
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
		const timestamp = new Date().toISOString()
		appendFileSync(logFile, `[${timestamp}] WARN: ${message}\n`)
	} catch {
		// Silently fail if we can't write logs
	}
}

export type EmbeddingProvider = "ollama" | "openai"

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

const defaultOllamaHost = "http://localhost:11434"
const defaultOllamaModel = "nomic-embed-text"
const defaultOpenaiModel = "text-embedding-3-small"

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
		if (this.config.provider === "ollama") {
			return this.embedOllama(text)
		}
		return this.embedOpenAI(text)
	}

	/**
	 * Generate embeddings for multiple texts.
	 */
	async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
		if (this.config.provider === "openai") {
			// OpenAI supports batch embedding
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
			if (this.config.provider === "ollama") {
				const host = this.config.ollamaHost ?? defaultOllamaHost
				const response = await fetch(`${host}/api/tags`)
				return response.ok
			} else {
				// Just check if API key exists
				return !!this.config.openaiApiKey
			}
		} catch {
			return false
		}
	}

	/**
	 * Get the model being used.
	 */
	getModel(): string {
		if (this.config.provider === "ollama") {
			return this.config.model ?? defaultOllamaModel
		}
		return this.config.model ?? defaultOpenaiModel
	}

	// ============================================================================
	// Ollama Implementation
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
 */
export async function detectProvider(): Promise<EmbeddingConfig | null> {
	// Try Ollama first (local, free)
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
				return { provider: "ollama", model: defaultOllamaModel }
			}
		}
	} catch (error: unknown) {
		// Ollama not available - log it
		if (
			error instanceof Error &&
			(error.cause as { code?: string })?.code === "ECONNREFUSED"
		) {
			logWarn("Ollama not running during provider detection")
		}
	}

	// Check for OpenAI API key in environment
	// biome-ignore lint/style/noProcessEnv: Config detection requires environment access
	const openaiKey = process.env.OPENAI_API_KEY
	if (openaiKey) {
		return { provider: "openai", openaiApiKey: openaiKey }
	}

	return null
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
