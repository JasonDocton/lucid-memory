/**
 * Retrieval Module
 *
 * Combines storage with cognitive memory ranking.
 * This is where lucid-core's ACT-R algorithms meet SQLite.
 *
 * The retrieval pipeline:
 * 1. Get probe embedding
 * 2. Compute similarity to all stored embeddings
 * 3. Apply base-level activation (recency/frequency)
 * 4. Apply spreading activation through associations
 * 5. Rank and return top candidates
 */

import { LucidStorage, type Memory, type Association, type StorageConfig } from "./storage.js";
import { EmbeddingClient, cosineSimilarity, type EmbeddingConfig } from "./embeddings.js";
import { generateGist, estimateTokens } from "./gist.js";

export interface RetrievalCandidate {
  memory: Memory;
  score: number;
  similarity: number;
  baseLevel: number;
  spreading: number;
  probability: number;
}

export interface RetrievalConfig {
  /** Maximum candidates to return */
  maxResults: number;
  /** Legacy alias for maxResults */
  limit?: number;
  /** Minimum probability threshold (0-1) */
  minProbability: number;
  /** Base-level decay parameter (higher = faster decay) */
  decay: number;
  /** Noise parameter for retrieval probability */
  noise: number;
  /** Retrieval threshold for probability calculation */
  threshold: number;
  /** Weight for probe similarity (0-1) */
  probeWeight: number;
  /** Weight for base-level activation (0-1) */
  baseLevelWeight: number;
  /** Weight for spreading activation (0-1) */
  spreadingWeight: number;
}

export const DEFAULT_CONFIG: RetrievalConfig = {
  maxResults: 10,
  minProbability: 0.1,
  decay: 0.5,
  noise: 0.25,
  threshold: 0.0,
  probeWeight: 0.4,
  baseLevelWeight: 0.3,
  spreadingWeight: 0.3
};

/**
 * High-level retrieval interface.
 */
export class LucidRetrieval {
  public readonly storage: LucidStorage;
  private embedder: EmbeddingClient | null = null;

  constructor(storageConfig?: StorageConfig) {
    this.storage = new LucidStorage(storageConfig);
  }

  /**
   * Set embedding configuration (can be done after construction).
   */
  setEmbeddingConfig(config: EmbeddingConfig): void {
    this.embedder = new EmbeddingClient(config);
  }

  /**
   * Check if embeddings are available.
   */
  hasEmbeddings(): boolean {
    return this.embedder !== null;
  }

  /**
   * Retrieve memories relevant to a query.
   */
  async retrieve(
    query: string,
    options: Partial<RetrievalConfig> & { filterType?: Memory["type"] } = {},
    projectId?: string
  ): Promise<RetrievalCandidate[]> {
    const config = { ...DEFAULT_CONFIG, ...options };
    const limit = config.maxResults ?? config.limit ?? 10;

    // 2. Get all data needed for retrieval
    const { memories, accessHistories } = this.storage.getAllForRetrieval(projectId);
    const associations = this.storage.getAllAssociations();

    // Filter by type if specified
    const filteredMemories = options.filterType
      ? memories.filter(m => m.type === options.filterType)
      : memories;

    // If no embedder, fall back to recency-based ranking
    if (!this.embedder) {
      const now = Date.now();
      const candidates: RetrievalCandidate[] = filteredMemories.map((memory, i) => {
        const history = accessHistories[memories.indexOf(memory)];
        const baseLevel = computeBaseLevel(history, now, config.decay);
        const probability = retrievalProbability(baseLevel, config.threshold, config.noise);

        return {
          memory,
          score: baseLevel,
          similarity: 0,
          baseLevel,
          spreading: 0,
          probability,
        };
      });

      candidates.sort((a, b) => b.score - a.score);
      return candidates.slice(0, limit);
    }

    // 1. Get probe embedding
    const probeResult = await this.embedder.embed(query);
    const probeVector = probeResult.vector;

    const embeddings = this.storage.getAllEmbeddings();

    const now = Date.now();
    const candidates: RetrievalCandidate[] = [];

    // 3. Score each memory
    for (const memory of filteredMemories) {
      const originalIndex = memories.indexOf(memory);
      const embedding = embeddings.get(memory.id);

      // Skip memories without embeddings
      if (!embedding) continue;

      // Compute similarity
      const similarity = cosineSimilarity(probeVector, embedding);

      // Apply nonlinear activation (MINERVA 2)
      const probeActivation = Math.pow(similarity, 3);

      // Compute base-level activation
      const history = accessHistories[originalIndex];
      const baseLevel = computeBaseLevel(history, now, config.decay);

      // Compute spreading activation
      const spreading = computeSpreadingActivation(
        memory.id,
        associations,
        embeddings,
        probeVector
      );

      // Combine scores
      const score =
        config.probeWeight * probeActivation +
        config.baseLevelWeight * baseLevel +
        config.spreadingWeight * spreading;

      // Compute retrieval probability
      const probability = retrievalProbability(score, config.threshold, config.noise);

      if (probability >= config.minProbability) {
        candidates.push({
          memory,
          score,
          similarity,
          baseLevel,
          spreading,
          probability
        });
      }
    }

    // 4. Sort by score and limit
    candidates.sort((a, b) => b.score - a.score);
    const results = candidates.slice(0, limit);

    // 5. Record access for returned memories (strengthens them)
    for (const candidate of results) {
      this.storage.recordAccess(candidate.memory.id);
    }

    return results;
  }

  /**
   * Store a memory with automatic embedding and gist generation.
   */
  async store(
    content: string,
    options: {
      type?: Memory["type"];
      gist?: string;
      emotionalWeight?: number;
      projectId?: string;
      tags?: string[];
    } = {}
  ): Promise<Memory> {
    // Generate gist if not provided
    const gist = options.gist ?? generateGist(content, 150);

    // Store the memory
    const memory = this.storage.storeMemory({
      content,
      type: options.type ?? "learning",
      gist,
      emotionalWeight: options.emotionalWeight ?? 0.5,
      projectId: options.projectId,
      tags: options.tags
    });

    // Generate and store embedding if embedder is available
    if (this.embedder) {
      try {
        const embedding = await this.embedder.embed(content);
        this.storage.storeEmbedding(memory.id, embedding.vector, embedding.model);
      } catch (error) {
        // Embedding failed, memory is still stored - will be processed later
        console.error("[lucid] Embedding failed:", error);
      }
    }

    return memory;
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
      tokenBudget?: number;
      minSimilarity?: number;
    } = {}
  ): Promise<{
    memories: RetrievalCandidate[];
    summary: string;
    tokensUsed: number;
  }> {
    const tokenBudget = options.tokenBudget ?? 300;
    const minSimilarity = options.minSimilarity ?? 0.3;

    // Retrieve more than we need, then filter and budget
    const candidates = await this.retrieve(currentTask, { maxResults: 10 }, projectId);

    // Filter by similarity threshold - weak matches get nothing
    const relevant = candidates.filter(c => c.similarity >= minSimilarity);

    if (relevant.length === 0) {
      return {
        memories: [],
        summary: "",
        tokensUsed: 0
      };
    }

    // Budget allocation: fit as many memories as possible
    const selected: RetrievalCandidate[] = [];
    let tokensUsed = 0;

    for (const candidate of relevant) {
      // Use gist if available, otherwise generate one on the fly
      const text = candidate.memory.gist ?? generateGist(candidate.memory.content, 150);
      const tokens = estimateTokens(text);

      if (tokensUsed + tokens <= tokenBudget) {
        selected.push(candidate);
        tokensUsed += tokens;
      } else {
        // Budget exhausted
        break;
      }
    }

    // Generate summary only if we have results
    const summary = selected.length > 0
      ? `Relevant context (${selected.length} memories, ~${tokensUsed} tokens):`
      : "";

    return { memories: selected, summary, tokensUsed };
  }

  /**
   * Process pending embeddings (for background generation).
   */
  async processPendingEmbeddings(batchSize = 10): Promise<number> {
    if (!this.embedder) return 0;

    const pending = this.storage.getMemoriesWithoutEmbeddings(batchSize);
    if (pending.length === 0) return 0;

    const texts = pending.map(m => m.content);
    const embeddings = await this.embedder.embedBatch(texts);

    for (let i = 0; i < pending.length; i++) {
      this.storage.storeEmbedding(
        pending[i].id,
        embeddings[i].vector,
        embeddings[i].model
      );
    }

    return pending.length;
  }
}

// ============================================================================
// ACT-R Computational Functions
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
function computeBaseLevel(
  accessTimesMs: number[],
  currentTimeMs: number,
  decay: number
): number {
  if (accessTimesMs.length === 0) return 0;

  let sum = 0;
  for (const accessTime of accessTimesMs) {
    const timeSinceSeconds = Math.max(1, (currentTimeMs - accessTime) / 1000);
    sum += Math.pow(timeSinceSeconds, -decay);
  }

  return Math.log(sum);
}

/**
 * Compute spreading activation from associated memories.
 *
 * For each associated memory, activation spreads based on:
 * - Association strength
 * - How similar the associated memory is to the probe
 */
function computeSpreadingActivation(
  memoryId: string,
  allAssociations: Association[],
  embeddings: Map<string, number[]>,
  probeVector: number[]
): number {
  // Find associations involving this memory
  const relevant = allAssociations.filter(
    a => a.sourceId === memoryId || a.targetId === memoryId
  );

  if (relevant.length === 0) return 0;

  let totalSpread = 0;

  for (const assoc of relevant) {
    // Get the other memory in the association
    const otherId = assoc.sourceId === memoryId ? assoc.targetId : assoc.sourceId;
    const otherEmbedding = embeddings.get(otherId);

    if (!otherEmbedding) continue;

    // Spread = association strength * similarity of associated memory to probe
    const otherSimilarity = cosineSimilarity(probeVector, otherEmbedding);
    totalSpread += assoc.strength * Math.max(0, otherSimilarity);
  }

  // Normalize by number of associations (fan effect)
  return relevant.length > 0 ? totalSpread / relevant.length : 0;
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
function retrievalProbability(
  activation: number,
  threshold: number,
  noise: number
): number {
  const exponent = (threshold - activation) / noise;
  return 1 / (1 + Math.exp(exponent));
}
