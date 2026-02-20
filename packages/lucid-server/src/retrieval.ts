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
	ActivationConfig,
	AssociationDecayConfig,
	EpisodicMemoryConfig,
	InstanceNoiseConfig,
	PrpConfig,
	ReconsolidationConfig,
	SessionConfig,
	WorkingMemoryConfig,
} from "./config.ts"
import {
	EmbeddingClient,
	type EmbeddingConfig,
	type EmbeddingResult,
	cosineSimilarity as tsCosineSimilarity,
} from "./embeddings.ts"
import { estimateTokens, generateGist } from "./gist.ts"
import {
	type Association,
	type Episode,
	type EpisodeBoundaryType,
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

export interface RetrievalResult {
	candidates: RetrievalCandidate[]
	method: "semantic" | "recency"
	warning?: string
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
	maxResults: ActivationConfig.maxResults,
	minProbability: ActivationConfig.minProbability,
	decay: ActivationConfig.baseLevelDecay,
	noise: 0.25, // Instance noise base - will be per-memory when feature enabled
	threshold: ActivationConfig.retrievalThreshold,
	probeWeight: ActivationConfig.probeWeight,
	baseLevelWeight: ActivationConfig.baseLevelWeight,
	spreadingWeight: ActivationConfig.spreadingWeight,
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
	private readonly wmCapacity = WorkingMemoryConfig.capacity
	private readonly wmDecayMs = WorkingMemoryConfig.decayMs
	private readonly wmCutoffMultiplier = WorkingMemoryConfig.cutoffMultiplier
	private readonly wmMaxBoost = WorkingMemoryConfig.maxBoost

	// Session Tracking (Phase 4: Temporal Retrieval)
	// Caches current session ID per project to avoid repeated DB lookups
	private sessionCache: Map<string, { sessionId: string; touchedAt: number }> =
		new Map()
	private readonly sessionCacheTtlMs = SessionConfig.cacheTtlMs
	private sessionCacheLastPruneAt = 0 // LOW-6: Track last prune to avoid O(n) on every call
	private readonly sessionCoAccessBoost = 1.5 // Memories accessed in same session get 1.5x boost

	// MED-5: Association cache to avoid repeated full table scans
	private associationCache: { data: Association[]; cachedAt: number } | null =
		null
	private readonly associationCacheTtlMs = 300000 // 5 minute TTL - associations rarely change

	// Episode cache: memoryId → episodeIds (5-min TTL like association cache)
	private episodeCache: Map<
		string,
		{ episodeIds: string[]; cachedAt: number }
	> = new Map()
	private readonly episodeCacheTtlMs = 300000

	// Auto-association settings
	// When a memory is stored, automatically link it to recent similar memories
	private readonly autoAssociationLimit = 5 // Max associations to create per memory
	private readonly autoAssociationMinSimilarity = 0.4 // Minimum similarity to create link
	private readonly autoAssociationRecencyMs = 30 * 60 * 1000 // Only link to memories from last 30 min

	// PRP State (0.6.0 - Protein Synthesis Tagging)
	// Ephemeral, in-process only (like working memory). Not persisted.
	private prpState = {
		active: false,
		strength: 0,
		activatedAt: 0,
		activatedBy: "",
	}

	constructor(storageConfig?: StorageConfig) {
		this.storage = new LucidStorage(storageConfig)
	}

	// PRP helpers (0.6.0)
	private getPrpModifier(): number {
		if (!PrpConfig.enabled || !this.prpState.active) return 0
		const elapsed = Date.now() - this.prpState.activatedAt
		const decay = 0.5 ** (elapsed / PrpConfig.halfLifeMs)
		const modifier = this.prpState.strength * decay
		if (modifier < 0.01) {
			this.prpState.active = false
			return 0
		}
		return modifier
	}

	private activatePrp(memoryId: string, importance: number): void {
		if (!PrpConfig.enabled || importance < PrpConfig.activationThreshold) return
		const newStrength = Math.min(
			(importance - PrpConfig.activationThreshold) * 1.67,
			PrpConfig.maxStrength
		)
		if (this.prpState.active && this.getPrpModifier() > newStrength) return
		this.prpState = {
			active: true,
			strength: newStrength,
			activatedAt: Date.now(),
			activatedBy: memoryId,
		}
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
	 * Migrate stale embeddings when the model changes (e.g., nomic-embed-text → bge-base-en-v1.5).
	 * Deletes old embeddings so the background processor re-generates them.
	 */
	migrateEmbeddingsIfNeeded(config: EmbeddingConfig): void {
		const currentModel =
			config.model ||
			(config.provider === "native" ? "bge-base-en-v1.5" : "unknown")

		const staleCount = this.storage.countEmbeddingsNotMatching(currentModel)
		if (staleCount > 0) {
			const deleted = this.storage.deleteEmbeddingsNotMatching(currentModel)
			console.error(
				`[lucid] Migrated ${deleted} text embeddings (model != ${currentModel})`
			)
		}

		const staleVisualCount =
			this.storage.countVisualEmbeddingsNotMatching(currentModel)
		if (staleVisualCount > 0) {
			const deleted =
				this.storage.deleteVisualEmbeddingsNotMatching(currentModel)
			console.error(
				`[lucid] Migrated ${deleted} visual embeddings (model != ${currentModel})`
			)
		}

		const totalMigrated = staleCount + staleVisualCount
		if (totalMigrated > 0) {
			const estimatedSeconds = Math.ceil(totalMigrated / 10) * 5
			console.error(
				`[lucid] Re-embedding ${totalMigrated} memories in background (~${estimatedSeconds}s). Run 'lucid status' to check progress.`
			)
		}
	}

	/**
	 * Close the retrieval system and release resources.
	 * LOW-5: Explicit cleanup of ephemeral state on shutdown.
	 */
	close(): void {
		// End active sessions before clearing cache
		for (const entry of this.sessionCache.values()) {
			try {
				this.storage.endSession(entry.sessionId)
			} catch {
				// Best-effort during shutdown
			}
		}

		// Clear working memory
		this.workingMemory.clear()

		// Clear session cache
		this.sessionCache.clear()

		// Clear association cache
		this.associationCache = null

		// Clear episode cache
		this.episodeCache.clear()

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

	private getCachedEpisodeIds(memoryId: string): string[] {
		const now = Date.now()
		const cached = this.episodeCache.get(memoryId)
		if (cached && now - cached.cachedAt < this.episodeCacheTtlMs) {
			return cached.episodeIds
		}
		const episodes = this.storage.getEpisodesForMemory(memoryId)
		const episodeIds = episodes.map((e) => e.id)
		this.episodeCache.set(memoryId, { episodeIds, cachedAt: now })
		return episodeIds
	}

	private applyTemporalSpreading(
		candidates: RetrievalCandidate[],
		memoriesWithEmbeddings: Memory[],
		memoryIdToIndex: Map<string, number>
	): RetrievalCandidate[] {
		// Take top 5 seeds
		const seeds = candidates.slice(0, 5)
		const boosts = new Map<number, number>()

		for (const seed of seeds) {
			const episodeIds = this.getCachedEpisodeIds(seed.memory.id)

			for (const episodeId of episodeIds) {
				const events = this.storage.getEpisodeEvents(episodeId)
				const temporalLinks = this.storage.getEpisodeTemporalLinks(episodeId)

				// Build event-to-memory mapping
				const eventToMemoryIndex = new Map<string, number>()
				for (const event of events) {
					const idx = memoryIdToIndex.get(event.memoryId)
					if (idx !== undefined) {
						eventToMemoryIndex.set(event.id, idx)
					}
				}

				// Convert SQLite temporal links to merged JsTemporalLink format
				const jsLinks = mergeTemporalLinks(
					temporalLinks,
					events,
					eventToMemoryIndex
				)

				if (jsLinks.length === 0) continue

				const seedIdx = memoryIdToIndex.get(seed.memory.id)
				if (seedIdx === undefined) continue

				const config = {
					forwardStrength: EpisodicMemoryConfig.forwardLinkStrength,
					backwardStrength: EpisodicMemoryConfig.backwardLinkStrength,
					distanceDecayRate: EpisodicMemoryConfig.distanceDecayRate,
					episodeBoost: EpisodicMemoryConfig.episodeBoost,
					contextPersistence: EpisodicMemoryConfig.contextPersistence,
					maxTemporalDistance: EpisodicMemoryConfig.maxTemporalDistance,
				}

				let activations: number[]
				if (shouldUseNative && nativeModule) {
					const result = nativeModule.spreadTemporalActivation(
						memoriesWithEmbeddings.length,
						jsLinks,
						seedIdx,
						seed.score,
						config
					)
					activations = result.activations
				} else {
					activations = spreadTemporalActivationTS(
						memoriesWithEmbeddings.length,
						jsLinks,
						seedIdx,
						seed.score,
						config
					)
				}

				for (let i = 0; i < activations.length; i++) {
					const activation = activations[i]
					if (activation && activation > 0) {
						const current = boosts.get(i) ?? 0
						boosts.set(i, Math.max(current, activation))
					}
				}
			}
		}

		// Apply boosts (episodeBoost already applied inside spreading function)
		for (const candidate of candidates) {
			const idx = memoryIdToIndex.get(candidate.memory.id)
			if (idx === undefined) continue
			const boost = boosts.get(idx)
			if (boost && boost > 0) {
				candidate.score += boost
			}
		}

		candidates.sort((a, b) => b.score - a.score)
		return candidates
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
	 * Uses native Rust implementation when available.
	 */
	private getWorkingMemoryBoost(memoryId: string, now: number): number {
		const item = this.workingMemory.get(memoryId)
		if (!item) return 1.0

		// Use native Rust implementation when available
		if (shouldUseNative && nativeModule) {
			return nativeModule.computeWorkingMemoryBoost(item.activatedAt, now, {
				decayMs: this.wmDecayMs,
				maxBoost: this.wmMaxBoost,
			})
		}

		// TypeScript fallback
		const age = now - item.activatedAt
		if (age < 0) return 1.0
		const decayFactor = Math.exp(-age / this.wmDecayMs)
		return 1.0 + this.wmMaxBoost * decayFactor
	}

	/**
	 * Compute session-aware decay rate for a memory (Phase 2: Temporal Retrieval).
	 * Recent memories decay slower (higher base-level activation).
	 * Uses native Rust implementation when available.
	 *
	 * @param lastAccessMs - Timestamp of most recent access
	 * @param now - Current timestamp
	 * @returns Decay rate (0.3 to 0.5)
	 */
	private getSessionDecayRate(lastAccessMs: number, now: number): number {
		// Use native Rust implementation when available
		if (shouldUseNative && nativeModule) {
			return nativeModule.computeSessionDecayRate(lastAccessMs, now)
		}

		// TypeScript fallback
		const hoursAgo = (now - lastAccessMs) / 3600000
		if (hoursAgo < 0) return 0.5
		if (hoursAgo < 0.5) return 0.3
		if (hoursAgo < 2) return 0.4
		if (hoursAgo < 24) return 0.45
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
		this.storage.touchSession(sessionId)

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
	 *
	 * Returns RetrievalResult with candidates, method used, and optional warning
	 * so callers can surface degraded retrieval to users.
	 */
	async retrieve(
		query: string,
		options: Partial<RetrievalConfig> & { filterType?: Memory["type"] } = {},
		projectId?: string
	): Promise<RetrievalResult> {
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
					const history =
						accessHistories[memoryIndexMap.get(memory.id) ?? -1] ?? []
					// Phase 2: Use session-aware decay rate
					const lastAccess = (history.length > 0 ? history[0] : 0) ?? 0
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
			return {
				candidates: candidates.slice(0, limit),
				method: "recency",
				warning:
					"No embedding provider configured — results ranked by recency only, not relevance",
			}
		}

		// Get probe embedding - fall back to recency if embedding fails
		let probeResult: EmbeddingResult | undefined
		try {
			probeResult = await this.embedder.embed(query)
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error)
			console.error(
				"[lucid] Embedding failed, falling back to recency-based retrieval:",
				error
			)
			// Fall back to recency-based retrieval (same as no-embedder path)
			const now = Date.now()
			const candidates: RetrievalCandidate[] = filteredMemories.map(
				(memory, _i) => {
					const history =
						accessHistories[memoryIndexMap.get(memory.id) ?? -1] ?? []
					const lastAccess = (history.length > 0 ? history[0] : 0) ?? 0
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
			return {
				candidates: candidates.slice(0, limit),
				method: "recency",
				warning: `Embedding failed — results ranked by recency only, not relevance (${errMsg})`,
			}
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
		const lastAccessTimes: number[] = []
		const wmActivatedTimes: number[] = []
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

			// Collect raw data for batch computation below
			const lastAccess = (history.length > 0 ? history[0] : 0) ?? 0
			lastAccessTimes.push(lastAccess)
			wmActivatedTimes.push(this.workingMemory.get(memory.id)?.activatedAt ?? 0)
		}

		// Batch compute decay rates and working memory boosts
		if (shouldUseNative && nativeModule && lastAccessTimes.length > 0) {
			decayRates.push(
				...nativeModule.computeSessionDecayRateBatch(lastAccessTimes, now)
			)
			workingMemoryBoosts.push(
				...nativeModule.computeWorkingMemoryBoostBatch(
					wmActivatedTimes.map((t) => t || now),
					now,
					{
						decayMs: this.wmDecayMs,
						maxBoost: this.wmMaxBoost,
					}
				)
			)
			// Zero out boosts for memories not in working memory
			for (let i = 0; i < wmActivatedTimes.length; i++) {
				if (!wmActivatedTimes[i]) workingMemoryBoosts[i] = 1.0
			}
		} else {
			for (let i = 0; i < lastAccessTimes.length; i++) {
				decayRates.push(
					this.getSessionDecayRate(lastAccessTimes[i] ?? now, now)
				)
				workingMemoryBoosts.push(
					this.getWorkingMemoryBoost(memoriesWithEmbeddings[i]?.id ?? "", now)
				)
			}
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
			return { candidates: [], method: "semantic" }
		}

		if (memoriesWithEmbeddings.length === 0) {
			return { candidates: [], method: "semantic" }
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

		// Instance noise (0.6.0) — per-memory noise based on encoding strength
		if (InstanceNoiseConfig.enabled) {
			for (const candidate of candidates) {
				const es = candidate.memory.encodingStrength ?? 0.5
				const instanceNoise =
					shouldUseNative && nativeModule
						? nativeModule.computeInstanceNoise(
								es,
								InstanceNoiseConfig.noiseBase
							)
						: InstanceNoiseConfig.noiseBase * (2.0 - es)
				const adjustedProb =
					shouldUseNative && nativeModule
						? nativeModule.retrievalProbability(
								candidate.score,
								config.threshold,
								instanceNoise
							)
						: 1.0 /
							(1.0 +
								Math.exp((config.threshold - candidate.score) / instanceNoise))
				candidate.probability = adjustedProb
			}
		}

		// Phase 5: Episodic temporal spreading
		if (EpisodicMemoryConfig.enabled) {
			candidates = this.applyTemporalSpreading(
				candidates,
				memoriesWithEmbeddings,
				memoryIdToIndex
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

		// Association reinforcement (0.6.0) — co-retrieved memories strengthen links
		if (AssociationDecayConfig.enabled && finalCandidates.length > 1) {
			try {
				const topIds = finalCandidates.slice(0, 5).map((c) => c.memory.id)
				for (let i = 0; i < topIds.length; i++) {
					const sourceId = topIds[i] ?? ""
					for (let j = i + 1; j < topIds.length; j++) {
						const assocs = this.storage.getAssociations(sourceId)
						const existing = assocs.find(
							(a) =>
								(a.sourceId === topIds[i] && a.targetId === topIds[j]) ||
								(a.sourceId === topIds[j] && a.targetId === topIds[i])
						)
						if (existing) {
							const boosted =
								shouldUseNative && nativeModule
									? nativeModule.reinforceAssociation(existing.strength, null)
									: Math.min(existing.strength + 0.05, 1.0)
							this.storage.reinforceAssociation(
								existing.sourceId,
								existing.targetId,
								boosted
							)
						}
					}
				}
				this.associationCache = null
			} catch (error) {
				console.error("[lucid] Association reinforcement failed:", error)
			}
		}

		return { candidates: finalCandidates, method: "semantic" }
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
			const probeActivation = nativeModule
				? nativeModule.nonlinearActivation(boostedSimilarity)
				: boostedSimilarity ** 3

			// Compute base-level activation with session-aware decay (Phase 2)
			const history = memoryAccessHistories[i] ?? []
			const lastAccess = (history.length > 0 ? history[0] : 0) ?? 0
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

	private detectEpisodeBoundary(
		currentEpisode: Episode | null,
		projectId?: string
	): { needsNew: boolean; boundaryType: EpisodeBoundaryType } {
		if (!currentEpisode) {
			return { needsNew: true, boundaryType: "time_gap" }
		}

		// Time gap check
		const events = this.storage.getEpisodeEvents(currentEpisode.id)
		const lastEvent = events[events.length - 1]
		if (lastEvent) {
			const gapMs = Date.now() - lastEvent.createdAt
			if (gapMs > EpisodicMemoryConfig.boundaryGapMinutes * 60_000) {
				return { needsNew: true, boundaryType: "time_gap" }
			}
		}

		// Event count check
		const count = this.storage.getEventCountForEpisode(currentEpisode.id)
		if (count >= EpisodicMemoryConfig.maxEventsPerEpisode) {
			return { needsNew: true, boundaryType: "time_gap" }
		}

		// Context switch check
		if (projectId && currentEpisode.projectId !== projectId) {
			return { needsNew: true, boundaryType: "context_switch" }
		}

		return { needsNew: false, boundaryType: "time_gap" }
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
		const ew = options.emotionalWeight ?? 0.5

		// Reconsolidation check (0.6.0) — before creating a new memory,
		// check if similar content already exists and route to PE zone
		if (ReconsolidationConfig.enabled && this.embedder) {
			try {
				const embedding = await this.embedder.embed(content)
				const similar = this.storage.findMostSimilarMemory(
					embedding.vector,
					options.projectId,
					ReconsolidationConfig.similarityThreshold
				)

				if (similar) {
					const surprise =
						shouldUseNative && nativeModule
							? nativeModule.computeSurprise(
									similar.embedding,
									embedding.vector,
									similar.ageDays,
									similar.encodingStrength,
									0.5
								)
							: 1.0 -
								this.storage.cosineSimilarity(
									similar.embedding,
									embedding.vector
								)

					// Compute effective thresholds modulated by memory age and access count
					let thetaLow: number = ReconsolidationConfig.thetaLow
					let thetaHigh: number = ReconsolidationConfig.thetaHigh
					if (shouldUseNative && nativeModule) {
						const thresholds = nativeModule.computeEffectiveThresholds(
							thetaLow,
							thetaHigh,
							similar.accessCount,
							similar.ageDays,
							{
								strengthShift: ReconsolidationConfig.strengthShift,
								ageShift: ReconsolidationConfig.ageShift,
								baselineCount: ReconsolidationConfig.baselineCount,
								baselineDays: ReconsolidationConfig.baselineDays,
							}
						)
						thetaLow = thresholds[0] ?? thetaLow
						thetaHigh = thresholds[1] ?? thetaHigh
					} else {
						// TS fallback: age shifts θ_low up, use shifts θ_high down
						const ageFactor = Math.min(
							similar.ageDays / ReconsolidationConfig.baselineDays,
							5.0
						)
						thetaLow += ReconsolidationConfig.ageShift * ageFactor
						const useFactor = Math.min(
							similar.accessCount / ReconsolidationConfig.baselineCount,
							3.0
						)
						thetaHigh -= ReconsolidationConfig.strengthShift * useFactor
						thetaHigh = Math.max(thetaHigh, thetaLow + 0.05)
					}

					const zone =
						shouldUseNative && nativeModule
							? nativeModule.peZone(surprise, thetaLow, thetaHigh)
							: surprise < thetaLow
								? "reinforce"
								: surprise < thetaHigh
									? "reconsolidate"
									: "new_trace"

					if (zone === "reinforce") {
						this.storage.recordAccess(similar.memoryId)
						this.storage.updateEncodingStrength(
							similar.memoryId,
							Math.min(similar.encodingStrength + 0.05, 1.0)
						)
						const existing = this.storage.getMemory(similar.memoryId)
						if (existing) return existing
					}

					if (zone === "reconsolidate") {
						this.storage.updateMemory(similar.memoryId, {
							content,
							gist,
						})
						this.storage.updateConsolidationState(
							similar.memoryId,
							"reconsolidating"
						)
						this.storage.storeEmbedding(
							similar.memoryId,
							embedding.vector,
							embedding.model
						)
						const updated = this.storage.getMemory(similar.memoryId)
						if (updated) return updated
					}
					// zone === "new_trace": fall through to normal store
				}
			} catch (error) {
				console.error("[lucid] Reconsolidation check failed:", error)
			}
		}

		// Compute encoding strength (0.6.0)
		const prpModifier = this.getPrpModifier()
		const attention = ew > 0.7 ? 1.0 : 0.0
		let encodingStrength: number
		if (shouldUseNative && nativeModule) {
			encodingStrength = nativeModule.computeEncodingStrength(
				attention,
				ew,
				1,
				null
			)
		} else {
			encodingStrength = 0.3 + attention * 0.2 + ew * 0.2
		}
		encodingStrength = Math.min(encodingStrength + prpModifier, 1.0)

		// Store the memory
		const memory = this.storage.storeMemory({
			content,
			type: options.type ?? "learning",
			gist,
			emotionalWeight: ew,
			projectId: options.projectId,
			tags: options.tags,
			encodingStrength,
			encodingContext: {
				projectId: options.projectId,
			},
		})

		// Activate PRP for high-importance memories
		this.activatePrp(memory.id, ew)

		// Accumulate project metadata
		if (options.projectId) {
			const project = this.storage.getOrCreateProject(options.projectId)
			const context = project.context as Record<string, unknown>
			const memoryCount = ((context.memoryCount as number) ?? 0) + 1
			const typesSeen = ((context.typesSeen as string[]) ?? []).slice()
			const memType = options.type ?? "learning"
			if (!typesSeen.includes(memType)) typesSeen.push(memType)
			const allTags = ((context.allTags as string[]) ?? []).slice()
			for (const tag of options.tags ?? []) {
				if (!allTags.includes(tag)) allTags.push(tag)
			}
			this.storage.updateProjectContext(project.id, {
				...context,
				memoryCount,
				typesSeen,
				allTags,
				lastMemoryAt: Date.now(),
			})
		}

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

		// Episode lifecycle (0.5.0 Episodic Memory)
		if (EpisodicMemoryConfig.enabled) {
			try {
				let episode = this.storage.getCurrentEpisode(options.projectId)
				const { needsNew, boundaryType } = this.detectEpisodeBoundary(
					episode,
					options.projectId
				)

				if (needsNew) {
					if (episode) {
						this.storage.endEpisode(episode.id)
					}
					episode = this.storage.createEpisode({
						projectId: options.projectId,
						boundaryType,
					})
				}

				// episode is guaranteed non-null: either from getCurrentEpisode (needsNew=false)
				// or from createEpisode (which always returns Episode or throws)
				const ep = episode as NonNullable<typeof episode>
				const event = this.storage.addEventToEpisode(ep.id, memory.id)

				// Invalidate episode cache for this memory
				this.episodeCache.delete(memory.id)

				// Create temporal links to prior events in this episode
				if (event) {
					const events = this.storage.getEpisodeEvents(ep.id)

					if (shouldUseNative && nativeModule && events.length > 1) {
						// Use Rust createEpisodeLinks for batch link generation
						const memoryIndices = events.map((e) => e.position)
						const links = nativeModule.createEpisodeLinks(memoryIndices)
						for (const link of links) {
							const sourceEvent = events[link.sourcePosition]
							const targetEvent = events[link.targetPosition]
							if (!sourceEvent || !targetEvent) continue

							this.storage.createTemporalLink({
								episodeId: ep.id,
								sourceEventId: sourceEvent.id,
								targetEventId: targetEvent.id,
								strength: link.forwardStrength,
								direction: "forward",
							})
							this.storage.createTemporalLink({
								episodeId: ep.id,
								sourceEventId: targetEvent.id,
								targetEventId: sourceEvent.id,
								strength: link.backwardStrength,
								direction: "backward",
							})
						}
					} else {
						// TypeScript fallback
						for (const priorEvent of events) {
							if (priorEvent.id === event.id) continue
							const distance = event.position - priorEvent.position
							if (distance > EpisodicMemoryConfig.maxTemporalDistance) continue

							const decayFactor = Math.exp(
								-distance * EpisodicMemoryConfig.distanceDecayRate
							)

							this.storage.createTemporalLink({
								episodeId: ep.id,
								sourceEventId: priorEvent.id,
								targetEventId: event.id,
								strength:
									EpisodicMemoryConfig.forwardLinkStrength * decayFactor,
								direction: "forward",
							})
							this.storage.createTemporalLink({
								episodeId: ep.id,
								sourceEventId: event.id,
								targetEventId: priorEvent.id,
								strength:
									EpisodicMemoryConfig.backwardLinkStrength * decayFactor,
								direction: "backward",
							})
						}
					}
				}
			} catch (error) {
				console.error("[lucid] Episode lifecycle failed:", error)
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
	// biome-ignore lint/suspicious/useAwait: kept async for future embedding work
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
			(m) => m.id !== memoryId && m.createdAt > cutoff
		)

		if (recentMemories.length === 0) return

		// Calculate similarities and create associations
		const similarities: { id: string; similarity: number }[] = []

		for (const recent of recentMemories) {
			const recentEmbedding = this.storage.getEmbedding(recent.id)
			if (!recentEmbedding) continue

			// Use native or TS cosine similarity
			const similarity =
				shouldUseNative && nativeModule
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
		// Wrapped in try-catch to handle race conditions where a memory
		// could be deleted between listing and associating (MIG-3)
		let associationsCreated = 0
		for (const { id: targetId, similarity } of topAssociations) {
			try {
				// Use similarity as strength (already in 0.4-1.0 range due to threshold)
				this.storage.associate(memoryId, targetId, similarity, "temporal")
				associationsCreated++
			} catch (error) {
				// Log but don't fail - the target memory may have been deleted
				// or there could be a transient database issue
				console.warn(
					`[lucid] Failed to create association ${memoryId} -> ${targetId}:`,
					error instanceof Error ? error.message : error
				)
			}
		}

		// Invalidate association cache since we added new ones
		if (associationsCreated > 0) {
			this.invalidateAssociationCache()
		}
	}

	async retrieveTemporalNeighbors(
		anchorQuery: string,
		direction: "before" | "after" | "both" = "before",
		options?: { limit?: number; projectId?: string }
	): Promise<RetrievalCandidate[]> {
		const limit = options?.limit ?? 5

		// Find anchor candidates — try multiple and pick the one with the most
		// neighbors in the requested direction. Without embeddings, the top
		// retrieval result may be the last event (no "after" neighbors).
		const { candidates: anchors } = await this.retrieve(
			anchorQuery,
			{ maxResults: 10 },
			options?.projectId
		)
		if (anchors.length === 0) return []

		let bestResults: RetrievalCandidate[] = []

		for (const anchor of anchors) {
			const episodeIds = this.getCachedEpisodeIds(anchor.memory.id)
			if (episodeIds.length === 0) continue

			const results = new Map<string, RetrievalCandidate>()

			for (const episodeId of episodeIds) {
				const events = this.storage.getEpisodeEvents(episodeId)
				const temporalLinks = this.storage.getEpisodeTemporalLinks(episodeId)

				// Build event-to-memory mapping
				const eventToMemoryIdx = new Map<string, number>()
				const memoryMap = new Map<number, Memory>()
				let idx = 0
				for (const event of events) {
					eventToMemoryIdx.set(event.id, idx)
					const mem = this.storage.getMemory(event.memoryId)
					if (mem) memoryMap.set(idx, mem)
					idx++
				}

				// Find anchor index
				const anchorEvent = events.find((e) => e.memoryId === anchor.memory.id)
				if (!anchorEvent) continue
				const anchorIdx = eventToMemoryIdx.get(anchorEvent.id)
				if (anchorIdx === undefined) continue

				// Convert temporal links (merge forward+backward into single links per pair)
				const jsLinks = mergeTemporalLinks(
					temporalLinks,
					events,
					eventToMemoryIdx
				)

				if (jsLinks.length === 0) continue

				let neighbors: Array<{
					memoryIndex: number
					strength: number
				}>
				if (shouldUseNative && nativeModule) {
					neighbors = nativeModule.findTemporalNeighbors(
						jsLinks,
						anchorIdx,
						direction,
						limit
					)
				} else {
					neighbors = findTemporalNeighborsTS(
						jsLinks,
						anchorIdx,
						direction,
						limit
					)
				}

				for (const neighbor of neighbors) {
					const mem = memoryMap.get(neighbor.memoryIndex)
					if (!mem || mem.id === anchor.memory.id) continue
					if (!results.has(mem.id)) {
						results.set(mem.id, {
							memory: mem,
							score: neighbor.strength,
							similarity: 0,
							baseLevel: 0,
							spreading: neighbor.strength,
							probability: 1.0,
						})
					}
				}
			}

			if (results.size > bestResults.length) {
				bestResults = Array.from(results.values())
					.sort((a, b) => b.score - a.score)
					.slice(0, limit)
			}

			// With embeddings, the first anchor is the best semantic match
			if (bestResults.length >= limit) break
		}

		return bestResults
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
		const { candidates } = await this.retrieve(
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
					const lastAccess = (history.length > 0 ? history[0] : 0) ?? 0
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
			const probeActivation = nativeModule
				? nativeModule.nonlinearActivation(similarity)
				: similarity ** 3
			const history = visualAccessHistories[i] ?? []
			// Phase 2: Session-aware decay rate
			const lastAccess = (history.length > 0 ? history[0] : 0) ?? 0
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
		const { candidates: textCandidates } = await this.retrieve(
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
 * Exported for testing and potential Rust migration.
 */
export function buildAssociationIndex(
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

// ============================================================================
// Episodic Memory TypeScript Fallbacks
// ============================================================================

interface JsTemporalLinkTS {
	sourcePosition: number
	targetPosition: number
	sourceMemory: number
	targetMemory: number
	forwardStrength: number
	backwardStrength: number
}

/**
 * Merge separate forward/backward SQLite rows into single links per event pair.
 *
 * SQLite stores two rows per pair (forward: earlier→later, backward: later→earlier).
 * Rust expects one link per pair with source=earlier, target=later, both strengths set.
 */
function mergeTemporalLinks(
	rawLinks: Array<{
		sourceEventId: string
		targetEventId: string
		strength: number
		direction: "forward" | "backward"
	}>,
	events: Array<{ id: string; memoryId: string; position: number }>,
	eventToMemoryIdx: Map<string, number>
): JsTemporalLinkTS[] {
	const eventMap = new Map(events.map((e) => [e.id, e]))
	const merged = new Map<string, JsTemporalLinkTS>()

	for (const link of rawLinks) {
		const srcEvent = eventMap.get(link.sourceEventId)
		const tgtEvent = eventMap.get(link.targetEventId)
		if (!srcEvent || !tgtEvent) continue

		// Normalize: earlier position is always "source"
		const earlierEvent =
			srcEvent.position <= tgtEvent.position ? srcEvent : tgtEvent
		const laterEvent =
			srcEvent.position <= tgtEvent.position ? tgtEvent : srcEvent

		const earlierIdx = eventToMemoryIdx.get(earlierEvent.id)
		const laterIdx = eventToMemoryIdx.get(laterEvent.id)
		if (earlierIdx === undefined || laterIdx === undefined) continue

		const key = `${earlierEvent.id}-${laterEvent.id}`
		const existing = merged.get(key) ?? {
			sourcePosition: earlierEvent.position,
			targetPosition: laterEvent.position,
			sourceMemory: earlierIdx,
			targetMemory: laterIdx,
			forwardStrength: 0,
			backwardStrength: 0,
		}

		if (link.direction === "forward") {
			existing.forwardStrength = Math.max(
				existing.forwardStrength,
				link.strength
			)
		} else {
			existing.backwardStrength = Math.max(
				existing.backwardStrength,
				link.strength
			)
		}

		merged.set(key, existing)
	}

	return Array.from(merged.values())
}

function spreadTemporalActivationTS(
	numMemories: number,
	links: JsTemporalLinkTS[],
	seedMemory: number,
	seedActivation: number,
	config: {
		episodeBoost?: number
	}
): number[] {
	const activations = new Array<number>(numMemories).fill(0)
	const boost = config.episodeBoost ?? 1.2

	// Set seed activation (matches Rust behavior)
	if (seedMemory < numMemories) {
		activations[seedMemory] = seedActivation
	}

	for (const link of links) {
		if (link.sourceMemory === seedMemory && link.forwardStrength > 0) {
			const spread = seedActivation * link.forwardStrength * boost
			activations[link.targetMemory] =
				(activations[link.targetMemory] ?? 0) + spread
		}
		if (link.targetMemory === seedMemory && link.backwardStrength > 0) {
			const spread = seedActivation * link.backwardStrength * boost
			activations[link.sourceMemory] =
				(activations[link.sourceMemory] ?? 0) + spread
		}
	}

	return activations
}

function findTemporalNeighborsTS(
	links: JsTemporalLinkTS[],
	anchorMemory: number,
	direction: string,
	limit: number
): Array<{ memoryIndex: number; strength: number }> {
	const neighbors = new Map<number, number>()

	for (const link of links) {
		if (
			link.sourceMemory === anchorMemory &&
			link.forwardStrength > 0 &&
			(direction === "after" || direction === "both")
		) {
			const current = neighbors.get(link.targetMemory) ?? 0
			neighbors.set(link.targetMemory, Math.max(current, link.forwardStrength))
		}
		if (
			link.targetMemory === anchorMemory &&
			link.backwardStrength > 0 &&
			(direction === "before" || direction === "both")
		) {
			const current = neighbors.get(link.sourceMemory) ?? 0
			neighbors.set(link.sourceMemory, Math.max(current, link.backwardStrength))
		}
	}

	return Array.from(neighbors.entries())
		.map(([memoryIndex, strength]) => ({ memoryIndex, strength }))
		.sort((a, b) => b.strength - a.strength)
		.slice(0, limit)
}
