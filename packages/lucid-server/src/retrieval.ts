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
	type EmbeddingResult,
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
interface JsAssociation {
	source: number
	target: number
	forwardStrength: number
	backwardStrength: number
}

interface JsRetrievalConfig {
	decayRate?: number
	activationThreshold?: number
	noiseParameter?: number
	spreadingDepth?: number
	spreadingDecay?: number
	minProbability?: number
	maxResults?: number
	bidirectional?: boolean // LOW-3: Must match Rust field name
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

/**
 * Working Memory item - tracks recently activated memories for temporal boost.
 * Implements cognitive WM with τ≈4s decay (Baddeley, 2000; Cowan, 2001).
 */
interface WorkingMemoryItem {
	readonly memoryId: string
	readonly activatedAt: number
	readonly strength: number
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

	// Working Memory Buffer (Phase 1: Temporal Retrieval)
	// Tracks recently activated memories with exponential decay
	private workingMemory: Map<string, WorkingMemoryItem> = new Map()
	private readonly wmCapacity = 7 // K≈4-7 items (Cowan, 2001)
	private readonly wmDecayMs = 4000 // τ≈4 seconds
	private readonly wmCutoffMultiplier = 5 // Remove after 5τ (20 seconds)
	private readonly wmMaxBoost = 1.0 // Max boost added (1.0 + 1.0 = 2.0x)

	// Session Tracking (Phase 4: Temporal Retrieval)
	// Caches current session ID per project to avoid repeated DB lookups
	private sessionCache: Map<string, { sessionId: string; touchedAt: number }> =
		new Map()
	private readonly sessionCacheTtlMs = 60000 // Re-check session every minute
	private sessionCacheLastPruneAt = 0 // LOW-6: Track last prune to avoid O(n) on every call
	private readonly sessionCoAccessBoost = 1.5 // Memories accessed in same session get 1.5x boost

	// MED-5: Association cache to avoid repeated full table scans
	private associationCache: { data: Association[]; cachedAt: number } | null =
		null
	private readonly associationCacheTtlMs = 300000 // 5 minute TTL - associations rarely change

	// Auto-association settings
	// When a memory is stored, automatically link it to recent similar memories
	private readonly autoAssociationLimit = 5 // Max associations to create per memory
	private readonly autoAssociationMinSimilarity = 0.4 // Minimum similarity to create link
	private readonly autoAssociationRecencyMs = 30 * 60 * 1000 // Only link to memories from last 30 min

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
	 * Close the retrieval system and release resources.
	 * LOW-5: Explicit cleanup of ephemeral state on shutdown.
	 */
	close(): void {
		// Clear working memory
		this.workingMemory.clear()

		// Clear session cache
		this.sessionCache.clear()

		// Clear association cache
		this.associationCache = null

		// Close underlying storage
		this.storage.close()
	}

	/**
	 * Get associations with caching to avoid repeated full table scans.
	 * MED-5: Uses 5-second TTL cache for performance.
	 */
	private getCachedAssociations(): Association[] {
		const now = Date.now()
		if (
			this.associationCache &&
			now - this.associationCache.cachedAt < this.associationCacheTtlMs
		) {
			return this.associationCache.data
		}

		const data = this.storage.getAllAssociations()
		this.associationCache = { data, cachedAt: now }
		return data
	}

	/**
	 * Invalidate association cache (call when associations change).
	 */
	invalidateAssociationCache(): void {
		this.associationCache = null
	}

	/**
	 * Update working memory with a newly activated memory.
	 * Implements LRU eviction when over capacity.
	 */
	private updateWorkingMemory(memoryId: string, now: number): void {
		// Prune expired entries (older than 5τ)
		const cutoff = now - this.wmDecayMs * this.wmCutoffMultiplier
		for (const [id, item] of this.workingMemory) {
			if (item.activatedAt < cutoff) {
				this.workingMemory.delete(id)
			}
		}

		// Add or refresh this memory
		this.workingMemory.set(memoryId, {
			memoryId,
			activatedAt: now,
			strength: 1.0,
		})

		// Enforce capacity (LRU eviction)
		// LOW-1: Use while loop for defensive programming (handles multiple additions)
		while (this.workingMemory.size > this.wmCapacity) {
			let oldestId: string | null = null
			let oldestTime = Infinity
			for (const [id, item] of this.workingMemory) {
				if (item.activatedAt < oldestTime) {
					oldestTime = item.activatedAt
					oldestId = id
				}
			}
			if (oldestId) {
				this.workingMemory.delete(oldestId)
			} else {
				break // Safety: prevent infinite loop if no oldest found
			}
		}
	}

	/**
	 * Get WM boost for a specific memory.
	 * Returns 1.0 (no boost) to 2.0 (max boost).
	 * Implements exponential decay: e^(-t/τ)
	 */
	private getWorkingMemoryBoost(memoryId: string, now: number): number {
		const item = this.workingMemory.get(memoryId)
		if (!item) return 1.0

		const age = now - item.activatedAt
		// LOW-2: Guard against clock skew (negative age would cause boost > 2.0)
		if (age < 0) return 1.0

		// Exponential decay: e^(-t/τ) ranges from 1.0 (t=0) to ~0.007 (t=5τ)
		const decayFactor = Math.exp(-age / this.wmDecayMs)

		// Return boost in range [1.0, 2.0]
		return 1.0 + this.wmMaxBoost * decayFactor
	}

	/**
	 * Compute session-aware decay rate for a memory (Phase 2: Temporal Retrieval).
	 * Recent memories decay slower (higher base-level activation).
	 * Stays within ACT-R model by modulating d parameter, not activation directly.
	 *
	 * @param lastAccessMs - Timestamp of most recent access
	 * @param now - Current timestamp
	 * @returns Decay rate (0.3 to 0.5)
	 */
	private getSessionDecayRate(lastAccessMs: number, now: number): number {
		const hoursAgo = (now - lastAccessMs) / 3600000

		// Guard against future timestamps (clock skew, data corruption)
		if (hoursAgo < 0) return 0.5

		// Smooth decay rate based on recency
		if (hoursAgo < 0.5) {
			// Last 30 minutes: much slower decay → higher activation
			return 0.3
		}
		if (hoursAgo < 2) {
			// Last 2 hours: slower decay
			return 0.4
		}
		if (hoursAgo < 24) {
			// Last day: slightly slower
			return 0.45
		}
		// Default ACT-R decay rate
		return 0.5
	}

	/**
	 * Adjust emotional weight for project context (Phase 3: Temporal Retrieval).
	 * In-project memories get a modest boost via emotional weight.
	 * This is safe because:
	 * - Keeps filtering (no cross-project association leakage)
	 * - Bounded boost via emotional weight (max 1.0)
	 * - Small effect (0.15 increase = ~1.15x multiplier)
	 *
	 * @param baseWeight - Original emotional weight (0-1)
	 * @param memoryProjectId - Memory's project ID
	 * @param currentProjectId - Current retrieval project ID
	 * @returns Adjusted emotional weight (0-1)
	 */
	private adjustEmotionalWeightForProject(
		baseWeight: number,
		memoryProjectId: string | null,
		currentProjectId: string | undefined
	): number {
		// No boost if no project context
		if (!currentProjectId || !memoryProjectId) return baseWeight

		// Boost in-project memories
		if (memoryProjectId === currentProjectId) {
			return Math.min(baseWeight + 0.15, 1.0)
		}

		return baseWeight
	}

	/**
	 * Get or create a session for the current context (Phase 4: Temporal Retrieval).
	 * Uses a local cache to avoid repeated DB lookups within the same minute.
	 *
	 * Sessions provide temporal context for co-access tracking:
	 * - Files accessed in the same session get 1.5x association boost
	 * - Sessions auto-expire after 30 minutes of inactivity
	 *
	 * @param projectId - Optional project ID for project-scoped sessions
	 * @returns Session ID
	 */
	getOrCreateSession(projectId?: string): string {
		const cacheKey = projectId ?? ""
		const now = Date.now()

		this.pruneSessionCacheIfNeeded()

		// Check cache first
		const cached = this.sessionCache.get(cacheKey)
		if (cached && now - cached.touchedAt < this.sessionCacheTtlMs) {
			return cached.sessionId
		}

		// Get or create session from storage
		const sessionId = this.storage.getOrCreateSession(projectId)

		// Update cache
		this.sessionCache.set(cacheKey, { sessionId, touchedAt: now })

		return sessionId
	}

	/**
	 * Prune stale entries from session cache.
	 * Called periodically to prevent memory leaks in long-running sessions.
	 */
	private pruneSessionCacheIfNeeded(): void {
		const now = Date.now()
		if (now - this.sessionCacheLastPruneAt >= this.sessionCacheTtlMs) {
			for (const [key, entry] of this.sessionCache) {
				if (now - entry.touchedAt >= this.sessionCacheTtlMs) {
					this.sessionCache.delete(key)
				}
			}
			this.sessionCacheLastPruneAt = now
		}
	}

	/**
	 * Get the current session ID for a project (if any).
	 * Unlike getOrCreateSession, this does not create a new session.
	 *
	 * @param projectId - Optional project ID
	 * @returns Session ID if active, undefined otherwise
	 */
	getCurrentSession(projectId?: string): string | undefined {
		this.pruneSessionCacheIfNeeded()
		return this.storage.getCurrentSession(projectId)
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
		const associations = this.getCachedAssociations()

		// Build memory ID to index map once (O(n) instead of O(n²) from repeated indexOf)
		const memoryIndexMap = new Map<string, number>()
		for (let i = 0; i < memories.length; i++) {
			const m = memories[i]
			if (m) memoryIndexMap.set(m.id, i)
		}

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
					const history = accessHistories[memoryIndexMap.get(memory.id) ?? -1] ?? []
					// Phase 2: Use session-aware decay rate
					const lastAccess = history.length > 0 ? history[0] : 0
					const decayRate = this.getSessionDecayRate(lastAccess, now)
					const baseLevel =
						shouldUseNative && nativeModule
							? nativeModule.computeBaseLevel(history, now, decayRate)
							: computeBaseLevelTS(history, now, decayRate)
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

		// Get probe embedding - fall back to recency if embedding fails
		let probeResult: EmbeddingResult | undefined
		try {
			probeResult = await this.embedder.embed(query)
		} catch (error) {
			console.error(
				"[lucid] Embedding failed, falling back to recency-based retrieval:",
				error
			)
			// Fall back to recency-based retrieval (same as no-embedder path)
			const now = Date.now()
			const candidates: RetrievalCandidate[] = filteredMemories.map(
				(memory, _i) => {
					const history = accessHistories[memoryIndexMap.get(memory.id) ?? -1] ?? []
					const lastAccess = history.length > 0 ? history[0] : 0
					const decayRate = this.getSessionDecayRate(lastAccess, now)
					const baseLevel =
						shouldUseNative && nativeModule
							? nativeModule.computeBaseLevel(history, now, decayRate)
							: computeBaseLevelTS(history, now, decayRate)
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
		const probeVector = probeResult.vector

		const embeddingsMap = this.storage.getAllEmbeddings()

		// Build arrays for retrieval
		// Only include memories that have embeddings
		const memoriesWithEmbeddings: Memory[] = []
		const memoryEmbeddings: number[][] = []
		const memoryAccessHistories: number[][] = []
		const emotionalWeights: number[] = []
		const decayRates: number[] = []
		const workingMemoryBoosts: number[] = []
		const memoryIdToIndex = new Map<string, number>()

		const now = Date.now()
		for (const memory of filteredMemories) {
			const embedding = embeddingsMap.get(memory.id)
			if (!embedding) continue

			// Use pre-built index map instead of O(n) indexOf
			const originalIdx = memoryIndexMap.get(memory.id)
			if (originalIdx === undefined) {
				console.error(
					"[lucid] Memory not found in index map during retrieval:",
					memory.id
				)
				continue
			}

			const idx = memoriesWithEmbeddings.length
			memoryIdToIndex.set(memory.id, idx)
			memoriesWithEmbeddings.push(memory)
			memoryEmbeddings.push(embedding)

			const history = accessHistories[originalIdx] || [now]
			memoryAccessHistories.push(history)

			// Phase 3: Project Context Boost
			// In-project memories get +0.15 emotional weight (~1.15x multiplier)
			emotionalWeights.push(
				this.adjustEmotionalWeightForProject(
					memory.emotionalWeight ?? 0.5,
					memory.projectId,
					projectId
				)
			)

			// Phase 2: Session Decay Modulation
			// Use session-aware decay rate instead of fixed config.decay
			const lastAccess = history.length > 0 ? history[0] : 0
			decayRates.push(this.getSessionDecayRate(lastAccess, now))

			// Phase 1: Working Memory Boost (now computed here, applied in Rust)
			workingMemoryBoosts.push(this.getWorkingMemoryBoost(memory.id, now))
		}

		// HIGH-7: Validate array alignment - all parallel arrays must have same length
		const arrLen = memoriesWithEmbeddings.length
		if (
			memoryEmbeddings.length !== arrLen ||
			memoryAccessHistories.length !== arrLen ||
			emotionalWeights.length !== arrLen ||
			decayRates.length !== arrLen ||
			workingMemoryBoosts.length !== arrLen
		) {
			console.error(
				"[lucid] Array alignment mismatch in retrieval - this is a bug"
			)
			return []
		}

		if (memoriesWithEmbeddings.length === 0) {
			return []
		}

		// Get candidates from native or TypeScript implementation
		let candidates: RetrievalCandidate[]
		if (shouldUseNative && nativeModule) {
			candidates = this.retrieveNative(
				probeVector,
				memoriesWithEmbeddings,
				memoryEmbeddings,
				memoryAccessHistories,
				emotionalWeights,
				decayRates,
				workingMemoryBoosts,
				associations,
				memoryIdToIndex,
				config,
				limit * 2 // Fetch extra to allow for re-ranking after session boost
			)
		} else {
			candidates = this.retrieveTypeScript(
				probeVector,
				memoriesWithEmbeddings,
				memoryEmbeddings,
				memoryAccessHistories,
				associations,
				embeddingsMap,
				config,
				limit * 2 // Fetch extra to allow for re-ranking after session boost
			)
		}

		// Phase 4: Apply session co-access boost
		// Memories accessed in the same session get 1.5x score boost
		const sessionId = this.getCurrentSession(projectId)
		if (sessionId) {
			const sessionMemoryIds = this.storage.getMemoryIdsInSession(sessionId)
			for (const candidate of candidates) {
				if (sessionMemoryIds.has(candidate.memory.id)) {
					candidate.score *= this.sessionCoAccessBoost
				}
			}
			// Re-sort after applying boost
			candidates.sort((a, b) => b.score - a.score)
		}

		// Final slice and record access for returned memories only
		const finalCandidates = candidates.slice(0, limit)

		// Record access and update Working Memory for returned memories
		const accessNow = Date.now()
		for (const candidate of finalCandidates) {
			try {
				this.storage.recordAccess(candidate.memory.id)
			} catch (error) {
				console.error("[lucid] Failed to record access:", error)
			}
			this.updateWorkingMemory(candidate.memory.id, accessNow)
		}

		return finalCandidates
	}

	/**
	 * Native Rust retrieval implementation.
	 * WM boost is now applied in Rust before MINERVA 2 cubing (biologically correct).
	 */
	private retrieveNative(
		probeVector: number[],
		memoriesWithEmbeddings: Memory[],
		memoryEmbeddings: number[][],
		memoryAccessHistories: number[][],
		emotionalWeights: number[],
		decayRates: number[],
		workingMemoryBoosts: number[],
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
			bidirectional: true, // LOW-3: Fixed to match Rust field name
		}

		// Call native Rust retrieval (WM boost is applied in Rust before MINERVA 2)
		const now = Date.now()
		const nativeResults = nativeModule.retrieve(
			probeVector,
			memoryEmbeddings,
			memoryAccessHistories,
			emotionalWeights,
			decayRates,
			workingMemoryBoosts,
			now,
			nativeAssociations.length > 0 ? nativeAssociations : null,
			nativeConfig
		)

		// Map native results back to Memory objects
		// WM boost is already applied in Rust (before MINERVA 2 cubing)
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

		// Note: Access recording moved to main retrieve() after session boost and final slice
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

		// MED-4: Build association index map once (O(n) instead of O(n²))
		const associationIndex = buildAssociationIndex(associations)

		for (let i = 0; i < memoriesWithEmbeddings.length; i++) {
			const memory = memoriesWithEmbeddings[i]
			const embedding = memoryEmbeddings[i]
			if (!memory || !embedding) continue

			// Compute similarity
			const similarity = tsCosineSimilarity(probeVector, embedding)

			// Apply Working Memory boost to similarity (Phase 1: Temporal Retrieval)
			// WM boost only affects probe similarity, not base-level or spreading
			const wmBoost = this.getWorkingMemoryBoost(memory.id, now)
			const boostedSimilarity = Math.min(similarity * wmBoost, 1.0)

			// Apply nonlinear activation (MINERVA 2) to boosted similarity
			const probeActivation = boostedSimilarity ** 3

			// Compute base-level activation with session-aware decay (Phase 2)
			const history = memoryAccessHistories[i] ?? []
			const lastAccess = history.length > 0 ? history[0] : 0
			const decayRate = this.getSessionDecayRate(lastAccess, now)
			const baseLevel = computeBaseLevelTS(history, now, decayRate)

			// Compute spreading activation (using pre-built index)
			const spreading = computeSpreadingActivationTS(
				memory.id,
				associationIndex,
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

		// Note: Access recording moved to main retrieve() after session boost and final slice
		return candidates.slice(0, limit)
	}

	/**
	 * Store a memory with automatic embedding, gist generation, and association creation.
	 *
	 * Auto-association: When a memory is stored, we automatically link it to
	 * recent similar memories (last 30 min, similarity > 0.4). This enables
	 * spreading activation to surface related context even when semantic
	 * similarity alone wouldn't find it.
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

				// Auto-associate with recent similar memories
				await this.createAutoAssociations(
					memory.id,
					embedding.vector,
					options.projectId
				)
			} catch (error) {
				// Embedding failed, memory is still stored - will be processed later
				console.error("[lucid] Embedding failed:", error)
			}
		}

		return memory
	}

	/**
	 * Automatically create associations between a new memory and recent similar memories.
	 *
	 * This enables spreading activation to work in practice:
	 * - When you store memories about "Button.tsx" and "Button.module.css" in the same session,
	 *   they get linked even though CSS has very different vocabulary than TypeScript.
	 * - Later queries for "Button component" will find the CSS via spreading activation.
	 *
	 * Association strength is based on semantic similarity (0.4-1.0 → 0.4-1.0 strength).
	 */
	private async createAutoAssociations(
		memoryId: string,
		embedding: number[],
		projectId?: string
	): Promise<void> {
		const now = Date.now()
		const cutoff = now - this.autoAssociationRecencyMs

		// Get recent memories with embeddings from the same project
		const { memories } = this.storage.getAllForRetrieval(projectId)

		// Filter to recent memories (created in last 30 min) excluding the new one
		const recentMemories = memories.filter(
			(m) => m.id !== memoryId && m.createdAt.getTime() > cutoff
		)

		if (recentMemories.length === 0) return

		// Calculate similarities and create associations
		const similarities: { id: string; similarity: number }[] = []

		for (const recent of recentMemories) {
			const recentEmbedding = this.storage.getEmbedding(recent.id)
			if (!recentEmbedding) continue

			// Use native or TS cosine similarity
			const similarity = nativeModule
				? nativeModule.cosineSimilarity(embedding, recentEmbedding)
				: tsCosineSimilarity(embedding, recentEmbedding)

			if (similarity >= this.autoAssociationMinSimilarity) {
				similarities.push({ id: recent.id, similarity })
			}
		}

		// Sort by similarity and take top N
		similarities.sort((a, b) => b.similarity - a.similarity)
		const topAssociations = similarities.slice(0, this.autoAssociationLimit)

		// Create bidirectional associations
		for (const { id: targetId, similarity } of topAssociations) {
			// Use similarity as strength (already in 0.4-1.0 range due to threshold)
			this.storage.associate(memoryId, targetId, similarity, "temporal")
		}

		// Invalidate association cache since we added new ones
		if (topAssociations.length > 0) {
			this.invalidateAssociationCache()
		}
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
		let embeddings: EmbeddingResult[]
		try {
			embeddings = await this.embedder.embedBatch(texts)
		} catch (error) {
			console.error("[lucid] Batch embedding failed:", error)
			return 0
		}

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
	 *
	 * @param query - Search query
	 * @param options - Retrieval configuration
	 * @param projectId - Optional project ID for Phase 3 project context boost
	 */
	async retrieveVisual(
		query: string,
		options: Partial<RetrievalConfig> = {},
		projectId?: string
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
					// Phase 2: Session-aware decay rate
					const lastAccess = history.length > 0 ? history[0] : 0
					const decayRate = this.getSessionDecayRate(lastAccess, now)
					const baseLevel =
						shouldUseNative && nativeModule
							? nativeModule.computeBaseLevel(history, now, decayRate)
							: computeBaseLevelTS(history, now, decayRate)
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
			// Phase 3: Apply project context boost to emotional weight
			const baseWeight = emotionalWeights[i] ?? 1
			const boostedWeight = this.adjustEmotionalWeightForProject(
				baseWeight,
				visual.projectId,
				projectId
			)
			visualEmotionalWeights.push(boostedWeight)
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
			// Phase 2: Session-aware decay rate
			const lastAccess = history.length > 0 ? history[0] : 0
			const decayRate = this.getSessionDecayRate(lastAccess, now)
			const baseLevel = computeBaseLevelTS(history, now, decayRate)

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
		let embeddings: EmbeddingResult[]
		try {
			embeddings = await this.embedder.embedBatch(texts)
		} catch (error) {
			console.error("[lucid] Batch visual embedding failed:", error)
			return 0
		}

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
 * Build an index map from associations for O(1) lookup.
 * MED-4: This eliminates the O(n²) filter operation in spreading activation.
 */
function buildAssociationIndex(
	associations: Association[]
): Map<string, Association[]> {
	const index = new Map<string, Association[]>()

	for (const assoc of associations) {
		// Index by source
		const sourceList = index.get(assoc.sourceId) ?? []
		sourceList.push(assoc)
		index.set(assoc.sourceId, sourceList)

		// Index by target (for bidirectional lookup)
		const targetList = index.get(assoc.targetId) ?? []
		targetList.push(assoc)
		index.set(assoc.targetId, targetList)
	}

	return index
}

/**
 * Compute spreading activation from associated memories.
 *
 * For each associated memory, activation spreads based on:
 * - Association strength
 * - How similar the associated memory is to the probe
 *
 * MED-4: Uses pre-built index for O(1) lookup instead of O(n) filter.
 */
function computeSpreadingActivationTS(
	memoryId: string,
	associationIndex: Map<string, Association[]>,
	embeddings: Map<string, number[]>,
	probeVector: number[]
): number {
	// O(1) lookup instead of O(n) filter
	const relevant = associationIndex.get(memoryId) ?? []

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
