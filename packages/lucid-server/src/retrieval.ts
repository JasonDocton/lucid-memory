/**
 * Retrieval Module
 *
 * Combines storage with cognitive memory ranking.
 * This is where lucid-core's ACT-R algorithms meet SQLite.
 *
 * Uses native Rust bindings for high-performance retrieval when available:
 * - 2.7ms for 2000 memories
 * - 743,000 memories/second throughput
 *
 * Falls back to TypeScript implementation if native module not built.
 *
 * The retrieval pipeline:
 * 1. Get probe embedding
 * 2. Compute similarity to all stored embeddings
 * 3. Apply base-level activation (recency/frequency)
 * 4. Apply spreading activation through associations
 * 5. Rank and return top candidates
 */

import {
	EmbeddingClient,
	type EmbeddingConfig,
	cosineSimilarity as tsCosineSimilarity,
} from "./embeddings.ts"
import { estimateTokens, generateGist } from "./gist.ts"
import {
	type Association,
	LucidStorage,
	type Memory,
	type StorageConfig,
	type VisualMemory,
	type VisualMemoryInput,
} from "./storage.ts"

// Try to load native Rust bindings, fall back to TypeScript if not available
let nativeModule: typeof import("@lucid-memory/native") | null = null
let shouldUseNative = false

try {
	nativeModule = await import("@lucid-memory/native")
	shouldUseNative = true
	console.log("[lucid] Using native Rust retrieval engine (100x faster)")
} catch {
	console.log("[lucid] Native module not available, using TypeScript fallback")
}

// Type aliases for native module types
type JsAssociation = {
	source: number
	target: number
	forwardStrength: number
	backwardStrength: number
}

type JsRetrievalConfig = {
	decayRate?: number
	activationThreshold?: number
	noiseParameter?: number
	spreadingDepth?: number
	spreadingDecay?: number
	minProbability?: number
	maxResults?: number
	isBidirectional?: boolean
}

export interface RetrievalCandidate {
	memory: Memory
	score: number
	similarity: number
	baseLevel: number
	spreading: number
	probability: number
}

export interface VisualRetrievalCandidate {
	visual: VisualMemory
	score: number
	similarity: number
	baseLevel: number
	spreading: number
	probability: number
}

export interface RetrievalConfig {
	/** Maximum candidates to return */
	maxResults: number
	/** Legacy alias for maxResults */
	limit?: number
	/** Minimum probability threshold (0-1) */
	minProbability: number
	/** Base-level decay parameter (higher = faster decay) */
	decay: number
	/** Noise parameter for retrieval probability */
	noise: number
	/** Retrieval threshold for probability calculation */
	threshold: number
	/** Weight for probe similarity (0-1) */
	probeWeight: number
	/** Weight for base-level activation (0-1) */
	baseLevelWeight: number
	/** Weight for spreading activation (0-1) */
	spreadingWeight: number
}

export const DEFAULT_CONFIG: RetrievalConfig = {
	maxResults: 10,
	minProbability: 0.1,
	decay: 0.5,
	noise: 0.25,
	threshold: 0.0,
	probeWeight: 0.4,
	baseLevelWeight: 0.3,
	spreadingWeight: 0.3,
}

/**
 * High-level retrieval interface.
 * Uses native Rust bindings for cognitive memory retrieval.
 */
export class LucidRetrieval {
	public readonly storage: LucidStorage
	private embedder: EmbeddingClient | null = null
	private didWarnNoEmbeddings = false

	constructor(storageConfig?: StorageConfig) {
		this.storage = new LucidStorage(storageConfig)
	}

	/**
	 * Set embedding configuration (can be done after construction).
	 */
	setEmbeddingConfig(config: EmbeddingConfig): void {
		this.embedder = new EmbeddingClient(config)
	}

	/**
	 * Check if embeddings are available.
	 */
	hasEmbeddings(): boolean {
		return this.embedder !== null
	}

	/**
	 * Retrieve memories relevant to a query.
	 * Uses native Rust bindings when available for high-performance cognitive retrieval.
	 */
	async retrieve(
		query: string,
		options: Partial<RetrievalConfig> & { filterType?: Memory["type"] } = {},
		projectId?: string
	): Promise<RetrievalCandidate[]> {
		const config = { ...DEFAULT_CONFIG, ...options }
		const limit = config.maxResults ?? config.limit ?? 10

		// Get all data needed for retrieval
		const { memories, accessHistories } =
			this.storage.getAllForRetrieval(projectId)
		const associations = this.storage.getAllAssociations()

		// Filter by type if specified
		const filteredMemories = options.filterType
			? memories.filter((m) => m.type === options.filterType)
			: memories

		// If no embedder, fall back to recency-based ranking
		if (!this.embedder) {
			if (!this.didWarnNoEmbeddings) {
				console.error(
					"[lucid] ⚠️  No embeddings available - results based on recency only, not semantic relevance"
				)
				this.didWarnNoEmbeddings = true
			}
			const now = Date.now()
			const candidates: RetrievalCandidate[] = filteredMemories.map(
				(memory, _i) => {
					const history = accessHistories[memories.indexOf(memory)] ?? []
					const baseLevel =
						shouldUseNative && nativeModule
							? nativeModule.computeBaseLevel(history, now, config.decay)
							: computeBaseLevelTS(history, now, config.decay)
					const probability =
						shouldUseNative && nativeModule
							? nativeModule.retrievalProbability(
									baseLevel,
									config.threshold,
									config.noise
								)
							: retrievalProbabilityTS(
									baseLevel,
									config.threshold,
									config.noise
								)

					return {
						memory,
						score: baseLevel,
						similarity: 0,
						baseLevel,
						spreading: 0,
						probability,
					}
				}
			)

			candidates.sort((a, b) => b.score - a.score)
			return candidates.slice(0, limit)
		}

		// Get probe embedding
		const probeResult = await this.embedder.embed(query)
		const probeVector = probeResult.vector

		const embeddingsMap = this.storage.getAllEmbeddings()

		// Build arrays for retrieval
		// Only include memories that have embeddings
		const memoriesWithEmbeddings: Memory[] = []
		const memoryEmbeddings: number[][] = []
		const memoryAccessHistories: number[][] = []
		const emotionalWeights: number[] = []
		const decayRates: number[] = []
		const memoryIdToIndex = new Map<string, number>()

		for (const memory of filteredMemories) {
			const embedding = embeddingsMap.get(memory.id)
			if (!embedding) continue

			const idx = memoriesWithEmbeddings.length
			memoryIdToIndex.set(memory.id, idx)
			memoriesWithEmbeddings.push(memory)
			memoryEmbeddings.push(embedding)

			const originalIdx = memories.indexOf(memory)
			memoryAccessHistories.push(accessHistories[originalIdx] || [Date.now()])
			emotionalWeights.push(memory.emotionalWeight ?? 0.5)
			decayRates.push(config.decay)
		}

		if (memoriesWithEmbeddings.length === 0) {
			return []
		}

		// Use native Rust retrieval if available
		if (shouldUseNative && nativeModule) {
			return this.retrieveNative(
				probeVector,
				memoriesWithEmbeddings,
				memoryEmbeddings,
				memoryAccessHistories,
				emotionalWeights,
				decayRates,
				associations,
				memoryIdToIndex,
				config,
				limit
			)
		}

		// Fall back to TypeScript implementation
		return this.retrieveTypeScript(
			probeVector,
			memoriesWithEmbeddings,
			memoryEmbeddings,
			memoryAccessHistories,
			associations,
			embeddingsMap,
			config,
			limit
		)
	}

	/**
	 * Native Rust retrieval implementation.
	 */
	private retrieveNative(
		probeVector: number[],
		memoriesWithEmbeddings: Memory[],
		memoryEmbeddings: number[][],
		memoryAccessHistories: number[][],
		emotionalWeights: number[],
		decayRates: number[],
		associations: Association[],
		memoryIdToIndex: Map<string, number>,
		config: RetrievalConfig,
		limit: number
	): RetrievalCandidate[] {
		if (!nativeModule) return []

		// Convert associations to native format (using indices instead of IDs)
		const nativeAssociations: JsAssociation[] = []
		for (const assoc of associations) {
			const sourceIdx = memoryIdToIndex.get(assoc.sourceId)
			const targetIdx = memoryIdToIndex.get(assoc.targetId)
			if (sourceIdx !== undefined && targetIdx !== undefined) {
				nativeAssociations.push({
					source: sourceIdx,
					target: targetIdx,
					forwardStrength: assoc.strength,
					backwardStrength: assoc.strength * 0.5,
				})
			}
		}

		// Configure native retrieval
		const nativeConfig: JsRetrievalConfig = {
			decayRate: config.decay,
			activationThreshold: config.threshold,
			noiseParameter: config.noise,
			spreadingDepth: 3,
			spreadingDecay: 0.7,
			minProbability: config.minProbability,
			maxResults: limit,
			isBidirectional: true,
		}

		// Call native Rust retrieval
		const now = Date.now()
		const nativeResults = nativeModule.retrieve(
			probeVector,
			memoryEmbeddings,
			memoryAccessHistories,
			emotionalWeights,
			decayRates,
			now,
			nativeAssociations.length > 0 ? nativeAssociations : null,
			nativeConfig
		)

		// Map native results back to Memory objects
		const candidates: RetrievalCandidate[] = nativeResults
			.map((result) => {
				const memory = memoriesWithEmbeddings[result.index]
				const embedding = memoryEmbeddings[result.index]
				if (!memory || !embedding) return null
				const similarity =
					nativeModule?.cosineSimilarity(probeVector, embedding) ?? 0

				return {
					memory,
					score: result.totalActivation,
					similarity,
					baseLevel: result.baseLevel,
					spreading: result.spreading,
					probability: result.probability,
				}
			})
			.filter((c): c is NonNullable<typeof c> => c !== null)

		// Record access for returned memories
		for (const candidate of candidates) {
			this.storage.recordAccess(candidate.memory.id)
		}

		return candidates
	}

	/**
	 * TypeScript fallback retrieval implementation.
	 */
	private retrieveTypeScript(
		probeVector: number[],
		memoriesWithEmbeddings: Memory[],
		memoryEmbeddings: number[][],
		memoryAccessHistories: number[][],
		associations: Association[],
		embeddingsMap: Map<string, number[]>,
		config: RetrievalConfig,
		limit: number
	): RetrievalCandidate[] {
		const now = Date.now()
		const candidates: RetrievalCandidate[] = []

		for (let i = 0; i < memoriesWithEmbeddings.length; i++) {
			const memory = memoriesWithEmbeddings[i]
			const embedding = memoryEmbeddings[i]
			if (!memory || !embedding) continue

			// Compute similarity
			const similarity = tsCosineSimilarity(probeVector, embedding)

			// Apply nonlinear activation (MINERVA 2)
			const probeActivation = similarity ** 3

			// Compute base-level activation
			const history = memoryAccessHistories[i] ?? []
			const baseLevel = computeBaseLevelTS(history, now, config.decay)

			// Compute spreading activation
			const spreading = computeSpreadingActivationTS(
				memory.id,
				associations,
				embeddingsMap,
				probeVector
			)

			// Combine scores
			const score =
				config.probeWeight * probeActivation +
				config.baseLevelWeight * baseLevel +
				config.spreadingWeight * spreading

			// Compute retrieval probability
			const probability = retrievalProbabilityTS(
				score,
				config.threshold,
				config.noise
			)

			if (probability >= config.minProbability) {
				candidates.push({
					memory,
					score,
					similarity,
					baseLevel,
					spreading,
					probability,
				})
			}
		}

		// Sort by score and limit
		candidates.sort((a, b) => b.score - a.score)
		const results = candidates.slice(0, limit)

		// Record access for returned memories
		for (const candidate of results) {
			this.storage.recordAccess(candidate.memory.id)
		}

		return results
	}

	/**
	 * Store a memory with automatic embedding and gist generation.
	 */
	async store(
		content: string,
		options: {
			type?: Memory["type"]
			gist?: string
			emotionalWeight?: number
			projectId?: string
			tags?: string[]
		} = {}
	): Promise<Memory> {
		// Generate gist if not provided
		const gist = options.gist ?? generateGist(content, 150)

		// Store the memory
		const memory = this.storage.storeMemory({
			content,
			type: options.type ?? "learning",
			gist,
			emotionalWeight: options.emotionalWeight ?? 0.5,
			projectId: options.projectId,
			tags: options.tags,
		})

		// Generate and store embedding if embedder is available
		if (this.embedder) {
			try {
				const embedding = await this.embedder.embed(content)
				this.storage.storeEmbedding(
					memory.id,
					embedding.vector,
					embedding.model
				)
			} catch (error) {
				// Embedding failed, memory is still stored - will be processed later
				console.error("[lucid] Embedding failed:", error)
			}
		}

		return memory
	}

	/**
	 * Get context relevant to a query (higher-level retrieval for hooks).
	 *
	 * Token budgeting:
	 * - Default budget: 300 tokens (~1200 chars)
	 * - Only includes memories with similarity > minSimilarity
	 * - Uses gists when available, falls back to truncated content
	 */
	async getContext(
		currentTask: string,
		projectId?: string,
		options: {
			tokenBudget?: number
			minSimilarity?: number
		} = {}
	): Promise<{
		memories: RetrievalCandidate[]
		summary: string
		tokensUsed: number
	}> {
		const tokenBudget = options.tokenBudget ?? 300
		const minSimilarity = options.minSimilarity ?? 0.3

		// Retrieve more than we need, then filter and budget
		const candidates = await this.retrieve(
			currentTask,
			{ maxResults: 10 },
			projectId
		)

		// Filter by similarity threshold - weak matches get nothing
		const relevant = candidates.filter((c) => c.similarity >= minSimilarity)

		if (relevant.length === 0) {
			return {
				memories: [],
				summary: "",
				tokensUsed: 0,
			}
		}

		// Budget allocation: fit as many memories as possible
		const selected: RetrievalCandidate[] = []
		let tokensUsed = 0

		for (const candidate of relevant) {
			// Use gist if available, otherwise generate one on the fly
			const text =
				candidate.memory.gist ?? generateGist(candidate.memory.content, 150)
			const tokens = estimateTokens(text)

			if (tokensUsed + tokens <= tokenBudget) {
				selected.push(candidate)
				tokensUsed += tokens
			} else {
				// Budget exhausted
				break
			}
		}

		// Generate summary only if we have results
		const summary =
			selected.length > 0
				? `Relevant context (${selected.length} memories, ~${tokensUsed} tokens):`
				: ""

		return { memories: selected, summary, tokensUsed }
	}

	/**
	 * Process pending embeddings (for background generation).
	 */
	async processPendingEmbeddings(batchSize = 10): Promise<number> {
		if (!this.embedder) return 0

		const pending = this.storage.getMemoriesWithoutEmbeddings(batchSize)
		if (pending.length === 0) return 0

		const texts = pending.map((m) => m.content)
		const embeddings = await this.embedder.embedBatch(texts)

		for (let i = 0; i < pending.length; i++) {
			const memory = pending[i]
			const embedding = embeddings[i]
			if (!memory || !embedding) continue
			this.storage.storeEmbedding(memory.id, embedding.vector, embedding.model)
		}

		return pending.length
	}

	// ============================================================================
	// Visual Memory Retrieval
	// ============================================================================

	/**
	 * Retrieve visual memories relevant to a query.
	 * Uses native Rust bindings when available for high-performance retrieval.
	 */
	async retrieveVisual(
		query: string,
		options: Partial<RetrievalConfig> = {}
	): Promise<VisualRetrievalCandidate[]> {
		const config = { ...DEFAULT_CONFIG, ...options }
		const limit = config.maxResults ?? config.limit ?? 10

		// Get all visual data needed for retrieval
		const { visuals, accessHistories, emotionalWeights, significanceScores } =
			this.storage.getAllVisualsForRetrieval()

		if (visuals.length === 0) {
			return []
		}

		// If no embedder, fall back to recency-based ranking
		if (!this.embedder) {
			if (!this.didWarnNoEmbeddings) {
				console.error(
					"[lucid] ⚠️  No embeddings available - visual results based on recency only"
				)
				this.didWarnNoEmbeddings = true
			}
			const now = Date.now()
			const candidates: VisualRetrievalCandidate[] = visuals.map(
				(visual, i) => {
					const history = accessHistories[i] ?? []
					const baseLevel =
						shouldUseNative && nativeModule
							? nativeModule.computeBaseLevel(history, now, config.decay)
							: computeBaseLevelTS(history, now, config.decay)
					const probability =
						shouldUseNative && nativeModule
							? nativeModule.retrievalProbability(
									baseLevel,
									config.threshold,
									config.noise
								)
							: retrievalProbabilityTS(
									baseLevel,
									config.threshold,
									config.noise
								)

					return {
						visual,
						score: baseLevel,
						similarity: 0,
						baseLevel,
						spreading: 0,
						probability,
					}
				}
			)

			candidates.sort((a, b) => b.score - a.score)
			return candidates.slice(0, limit)
		}

		// Get probe embedding
		const probeResult = await this.embedder.embed(query)
		const probeVector = probeResult.vector

		const embeddingsMap = this.storage.getAllVisualEmbeddings()

		// Build arrays for retrieval - only include visuals with embeddings
		const visualsWithEmbeddings: VisualMemory[] = []
		const visualEmbeddings: number[][] = []
		const visualAccessHistories: number[][] = []
		const visualEmotionalWeights: number[] = []
		const visualSignificanceScores: number[] = []

		for (let i = 0; i < visuals.length; i++) {
			const visual = visuals[i]
			if (!visual) continue
			const embedding = embeddingsMap.get(visual.id)
			if (!embedding) continue

			visualsWithEmbeddings.push(visual)
			visualEmbeddings.push(embedding)
			visualAccessHistories.push(accessHistories[i] ?? [Date.now()])
			visualEmotionalWeights.push(emotionalWeights[i] ?? 1)
			visualSignificanceScores.push(significanceScores[i] ?? 0.5)
		}

		if (visualsWithEmbeddings.length === 0) {
			return []
		}

		// Use native Rust visual retrieval if available
		if (shouldUseNative && nativeModule) {
			const now = Date.now()
			const nativeResults = nativeModule.visualRetrieve(
				probeVector,
				visualEmbeddings,
				visualAccessHistories,
				visualEmotionalWeights,
				visualSignificanceScores,
				now,
				null, // No associations for now
				{
					decayRate: config.decay,
					activationThreshold: config.threshold,
					noiseParameter: config.noise,
					spreadingDepth: 3,
					spreadingDecay: 0.7,
					minProbability: config.minProbability,
					maxResults: limit,
					bidirectional: true,
					emotionalBoost: 0.3,
					significanceBoost: 0.2,
				}
			)

			const candidates: VisualRetrievalCandidate[] = nativeResults
				.map((result) => {
					const visual = visualsWithEmbeddings[result.index]
					const embedding = visualEmbeddings[result.index]
					if (!visual || !embedding) return null
					const similarity =
						nativeModule?.cosineSimilarity(probeVector, embedding) ?? 0

					return {
						visual,
						score: result.totalActivation,
						similarity,
						baseLevel: result.baseLevel,
						spreading: result.spreading,
						probability: result.probability,
					}
				})
				.filter((c): c is NonNullable<typeof c> => c !== null)

			// Record access for returned visuals
			for (const candidate of candidates) {
				this.storage.recordVisualAccess(candidate.visual.id)
			}

			return candidates
		}

		// TypeScript fallback for visual retrieval
		const now = Date.now()
		const candidates: VisualRetrievalCandidate[] = []

		for (let i = 0; i < visualsWithEmbeddings.length; i++) {
			const visual = visualsWithEmbeddings[i]
			const embedding = visualEmbeddings[i]
			if (!visual || !embedding) continue

			const similarity = tsCosineSimilarity(probeVector, embedding)
			const probeActivation = similarity ** 3
			const history = visualAccessHistories[i] ?? []
			const baseLevel = computeBaseLevelTS(history, now, config.decay)

			// Add significance and emotional boosts
			const emotionalWeight = visualEmotionalWeights[i] ?? 1
			const significance = visualSignificanceScores[i] ?? 0.5
			const emotionalBoost =
				emotionalWeight > 0.7 ? (emotionalWeight - 0.7) * 0.3 : 0
			const significanceBoost = significance * 0.2

			const score =
				config.probeWeight * probeActivation +
				config.baseLevelWeight * baseLevel +
				emotionalBoost +
				significanceBoost

			const probability = retrievalProbabilityTS(
				score,
				config.threshold,
				config.noise
			)

			if (probability >= config.minProbability) {
				candidates.push({
					visual,
					score,
					similarity,
					baseLevel,
					spreading: 0,
					probability,
				})
			}
		}

		candidates.sort((a, b) => b.score - a.score)
		const results = candidates.slice(0, limit)

		// Record access for returned visuals
		for (const candidate of results) {
			this.storage.recordVisualAccess(candidate.visual.id)
		}

		return results
	}

	/**
	 * Store a visual memory with automatic embedding generation.
	 */
	async storeVisual(input: VisualMemoryInput): Promise<VisualMemory> {
		// Store the visual memory
		const visual = this.storage.storeVisualMemory(input)

		// Generate and store embedding from description if embedder is available
		if (this.embedder) {
			try {
				const embedding = await this.embedder.embed(input.description)
				this.storage.storeVisualEmbedding(
					visual.id,
					embedding.vector,
					embedding.model
				)
			} catch (error) {
				console.error("[lucid] Visual embedding failed:", error)
			}
		}

		return visual
	}

	/**
	 * Process pending visual embeddings (for background generation).
	 */
	async processPendingVisualEmbeddings(batchSize = 10): Promise<number> {
		if (!this.embedder) return 0

		const pending = this.storage.getVisualMemoriesWithoutEmbeddings(batchSize)
		if (pending.length === 0) return 0

		const texts = pending.map((v) => v.description)
		const embeddings = await this.embedder.embedBatch(texts)

		for (let i = 0; i < pending.length; i++) {
			const visual = pending[i]
			const embedding = embeddings[i]
			if (!visual || !embedding) continue
			this.storage.storeVisualEmbedding(
				visual.id,
				embedding.vector,
				embedding.model
			)
		}

		return pending.length
	}

	/**
	 * Get unified context including both text and visual memories.
	 *
	 * Token budgeting with visual ratio:
	 * - Default budget: 300 tokens
	 * - Default visualRatio: 0.3 (30% for visual, 70% for text)
	 */
	async getContextWithVisuals(
		currentTask: string,
		projectId?: string,
		options: {
			tokenBudget?: number
			minSimilarity?: number
			visualRatio?: number
		} = {}
	): Promise<{
		memories: RetrievalCandidate[]
		visualMemories: VisualRetrievalCandidate[]
		summary: string
		tokensUsed: number
	}> {
		const tokenBudget = options.tokenBudget ?? 300
		const minSimilarity = options.minSimilarity ?? 0.3
		const visualRatio = options.visualRatio ?? 0.3

		// Calculate budget splits
		const visualBudget = Math.floor(tokenBudget * visualRatio)
		const textBudget = tokenBudget - visualBudget

		// Retrieve text memories
		const textCandidates = await this.retrieve(
			currentTask,
			{ maxResults: 10 },
			projectId
		)
		const relevantText = textCandidates.filter(
			(c) => c.similarity >= minSimilarity
		)

		// Retrieve visual memories
		const visualCandidates = await this.retrieveVisual(currentTask, {
			maxResults: 5,
		})
		const relevantVisual = visualCandidates.filter(
			(c) => c.similarity >= minSimilarity
		)

		// Budget allocation for text memories
		const selectedText: RetrievalCandidate[] = []
		let textTokensUsed = 0

		for (const candidate of relevantText) {
			const text =
				candidate.memory.gist ?? generateGist(candidate.memory.content, 150)
			const tokens = estimateTokens(text)

			if (textTokensUsed + tokens <= textBudget) {
				selectedText.push(candidate)
				textTokensUsed += tokens
			} else {
				break
			}
		}

		// Budget allocation for visual memories
		const selectedVisual: VisualRetrievalCandidate[] = []
		let visualTokensUsed = 0

		for (const candidate of relevantVisual) {
			const tokens = estimateTokens(candidate.visual.description)

			if (visualTokensUsed + tokens <= visualBudget) {
				selectedVisual.push(candidate)
				visualTokensUsed += tokens
			} else {
				break
			}
		}

		const totalTokensUsed = textTokensUsed + visualTokensUsed
		const totalMemories = selectedText.length + selectedVisual.length

		const summary =
			totalMemories > 0
				? `Relevant context (${selectedText.length} text, ${selectedVisual.length} visual, ~${totalTokensUsed} tokens):`
				: ""

		return {
			memories: selectedText,
			visualMemories: selectedVisual,
			summary,
			tokensUsed: totalTokensUsed,
		}
	}
}

// ============================================================================
// TypeScript Fallback Functions (ACT-R Computational Functions)
// ============================================================================

/**
 * Compute base-level activation from access history.
 *
 * B(m) = ln[Σ(t_k)^(-d)]
 *
 * Where:
 * - t_k is the time since the k-th access
 * - d is the decay parameter (typically 0.5)
 */
function computeBaseLevelTS(
	accessTimesMs: number[],
	currentTimeMs: number,
	decay: number
): number {
	if (accessTimesMs.length === 0) return 0

	let sum = 0
	for (const accessTime of accessTimesMs) {
		const timeSinceSeconds = Math.max(1, (currentTimeMs - accessTime) / 1000)
		sum += timeSinceSeconds ** -decay
	}

	return Math.log(sum)
}

/**
 * Compute spreading activation from associated memories.
 *
 * For each associated memory, activation spreads based on:
 * - Association strength
 * - How similar the associated memory is to the probe
 */
function computeSpreadingActivationTS(
	memoryId: string,
	allAssociations: Association[],
	embeddings: Map<string, number[]>,
	probeVector: number[]
): number {
	// Find associations involving this memory
	const relevant = allAssociations.filter(
		(a) => a.sourceId === memoryId || a.targetId === memoryId
	)

	if (relevant.length === 0) return 0

	let totalSpread = 0

	for (const assoc of relevant) {
		// Get the other memory in the association
		const otherId =
			assoc.sourceId === memoryId ? assoc.targetId : assoc.sourceId
		const otherEmbedding = embeddings.get(otherId)

		if (!otherEmbedding) continue

		// Spread = association strength * similarity of associated memory to probe
		const otherSimilarity = tsCosineSimilarity(probeVector, otherEmbedding)
		totalSpread += assoc.strength * Math.max(0, otherSimilarity)
	}

	// Normalize by number of associations (fan effect)
	return relevant.length > 0 ? totalSpread / relevant.length : 0
}

/**
 * Compute retrieval probability using logistic function.
 *
 * P(retrieval) = 1 / (1 + e^((τ - A) / s))
 *
 * Where:
 * - A is the total activation
 * - τ is the retrieval threshold
 * - s is the noise parameter
 */
function retrievalProbabilityTS(
	activation: number,
	threshold: number,
	noise: number
): number {
	const exponent = (threshold - activation) / noise
	return 1 / (1 + Math.exp(exponent))
}
