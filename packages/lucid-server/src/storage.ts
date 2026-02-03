/**
 * Lucid Memory Storage Layer
 *
 * SQLite-based persistent storage for memories, embeddings, and associations.
 * This is the foundation layer - it handles persistence, not retrieval ranking.
 *
 * Uses Bun's built-in SQLite for zero-dependency speed.
 */

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ============================================================================
// Native Rust Bindings (with TypeScript fallback)
// ============================================================================
//
// Location Intuitions algorithms are implemented in Rust for performance.
// When the native module is available, we use it. Otherwise, we fall back
// to equivalent TypeScript implementations for cross-platform compatibility.
//
// This dual-implementation approach ensures:
// 1. Maximum performance on supported platforms (sub-microsecond operations)
// 2. Graceful degradation when native module can't be built
// 3. Behavioral consistency (verified by integration tests)

let nativeLocation: {
	locationComputeFamiliarity: (accessCount: number, config?: unknown) => number
	locationInferActivity: (
		context: string,
		toolName?: string | null,
		explicitType?: string | null
	) => {
		activityType: string // NAPI-RS converts snake_case to camelCase
		source: string
		confidence: number
	}
	locationAssociationStrength: (
		currentCount: number,
		isSameTask: boolean,
		isSameActivity: boolean,
		config?: unknown
	) => number
	locationIsWellKnown: (familiarity: number, config?: unknown) => boolean
} | null = null

try {
	// biome-ignore lint/style/noCommonJs: Dynamic require for native module with fallback
	const native = require("@lucid-memory/native")
	if (native.locationComputeFamiliarity) {
		nativeLocation = native
	}
} catch {
	// Native module not available - TypeScript fallback will be used
}

// ============================================================================
// Safe JSON Parsing
// ============================================================================

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
	if (!json) return fallback
	try {
		return JSON.parse(json) as T
	} catch {
		console.error("[lucid] Failed to parse JSON:", json.slice(0, 100))
		return fallback
	}
}

// Types
export type MemoryType =
	| "learning"
	| "decision"
	| "context"
	| "bug"
	| "solution"
	| "conversation"

export interface Memory {
	id: string
	type: MemoryType
	content: string
	gist: string | null
	createdAt: number
	lastAccessed: number | null
	accessCount: number
	emotionalWeight: number
	projectId: string | null
	tags: string[]
}

export interface MemoryInput {
	type?: MemoryType
	content: string
	gist?: string
	emotionalWeight?: number
	projectId?: string
	tags?: string[]
}

export interface Association {
	sourceId: string
	targetId: string
	strength: number
	type: "semantic" | "temporal" | "causal"
}

export interface Project {
	id: string
	path: string
	name: string | null
	lastActive: number
	context: Record<string, unknown>
}

export interface StorageConfig {
	dbPath?: string
	embeddingDim?: number
}

// ============================================================================
// Visual Memory Types
// ============================================================================

export type VisualMediaType = "image" | "video"
export type VisualSource = "direct" | "video_frame" | "other"

export interface VisualMemory {
	id: string
	description: string // The core memory content
	originalPath: string | null // Reference only, not stored
	mediaType: VisualMediaType
	objects: string[]
	emotionalValence: number
	emotionalArousal: number
	significance: number
	sharedBy: string | null
	source: VisualSource
	receivedAt: number
	lastAccessed: number | null
	accessCount: number
	createdAt: number
	projectId: string | null // Project context for Phase 3 boost
}

export interface VisualMemoryInput {
	description: string
	mediaType: VisualMediaType
	source: VisualSource
	originalPath?: string
	objects?: string[]
	emotionalValence?: number
	emotionalArousal?: number
	significance?: number
	sharedBy?: string
	projectId?: string // Project context for Phase 3 boost
}

// ============================================================================
// Location Intuitions Types
// ============================================================================

export type ActivityType =
	| "reading"
	| "writing"
	| "debugging"
	| "refactoring"
	| "reviewing"
	| "unknown"
export type InferenceSource = "explicit" | "keyword" | "tool" | "default"

const ACTIVITY_TYPES: readonly ActivityType[] = [
	"reading",
	"writing",
	"debugging",
	"refactoring",
	"reviewing",
	"unknown",
]
const INFERENCE_SOURCES: readonly InferenceSource[] = [
	"explicit",
	"keyword",
	"tool",
	"default",
]
const ASSOCIATION_TYPES: readonly Association["type"][] = [
	"semantic",
	"temporal",
	"causal",
]

function isActivityType(s: string): s is ActivityType {
	return ACTIVITY_TYPES.includes(s as ActivityType)
}

function isInferenceSource(s: string): s is InferenceSource {
	return INFERENCE_SOURCES.includes(s as InferenceSource)
}

function isAssociationType(s: string): s is Association["type"] {
	return ASSOCIATION_TYPES.includes(s as Association["type"])
}

export interface LocationIntuition {
	id: string
	projectId: string // '' means global/no project
	path: string
	description: string | null
	purpose: string | null
	familiarity: number // 0-1
	accessCount: number
	searchesSaved: number
	lastAccessed: string | null
	createdAt: string
	updatedAt: string
	contextLimit: number
	isPinned: boolean
}

export interface FileAccessRecord {
	path: string
	context: string
	wasDirectAccess: boolean
	projectId?: string
	taskContext?: string
	activityType?: ActivityType
	sessionId?: string
}

export interface LocationAccessContext {
	id: string
	locationId: string
	contextDescription: string
	wasDirectAccess: boolean
	taskContext: string | null
	activityType: ActivityType
	activitySource: InferenceSource
	isSummary: boolean
	accessedAt: string
}

export interface LocationWithContexts extends LocationIntuition {
	accessContexts: LocationAccessContext[]
}

export interface LocationStats {
	totalLocations: number
	highFamiliarity: number
	totalSearchesSaved: number
	averageFamiliarity: number
	mostFamiliarPaths: string[]
}

export interface ActivityInference {
	activityType: ActivityType
	source: InferenceSource
	confidence: number
}

export interface LocationAssociation {
	id: string
	sourceId: string
	targetId: string
	strength: number
	coAccessCount: number
	lastCoAccess: string
	createdAt: string
}

/**
 * Storage layer for Lucid Memory.
 * Handles all persistence operations for memories, embeddings, and associations.
 */
export class LucidStorage {
	private db: Database
	private embeddingDim: number

	constructor(config: StorageConfig = {}) {
		const defaultPath = join(homedir(), ".lucid", "memory.db")
		const dbPath = config.dbPath ?? defaultPath
		this.embeddingDim = config.embeddingDim ?? 768 // nomic-embed-text default

		// Ensure directory exists
		const dir = join(dbPath, "..")
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true })
		}

		this.db = new Database(dbPath)
		this.db.exec("PRAGMA journal_mode = WAL")
		this.db.exec("PRAGMA foreign_keys = ON")

		this.initSchema()
	}

	private initSchema(): void {
		this.db.exec(`
      -- Core memories table
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'learning',
        content TEXT NOT NULL,
        gist TEXT,
        created_at INTEGER NOT NULL,
        last_accessed INTEGER,
        access_count INTEGER DEFAULT 0,
        emotional_weight REAL DEFAULT 0.5,
        project_id TEXT,
        tags TEXT DEFAULT '[]'
      );

      -- Embeddings for semantic search
      CREATE TABLE IF NOT EXISTS embeddings (
        memory_id TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        model TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      -- Associations between memories
      CREATE TABLE IF NOT EXISTS associations (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        strength REAL DEFAULT 0.5,
        type TEXT DEFAULT 'semantic',
        PRIMARY KEY (source_id, target_id),
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      -- Project context
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT,
        last_active INTEGER,
        context TEXT DEFAULT '{}'
      );

      -- Access history for base-level activation
      CREATE TABLE IF NOT EXISTS access_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        accessed_at INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_access_history_memory ON access_history(memory_id);
      CREATE INDEX IF NOT EXISTS idx_associations_source ON associations(source_id);
      CREATE INDEX IF NOT EXISTS idx_associations_target ON associations(target_id);

      -- Location Intuitions (spatial/file familiarity)
      CREATE TABLE IF NOT EXISTS location_intuitions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT '',
        -- Note: '' (empty string) means global/no project. Avoids NULL uniqueness issues.
        -- No FK constraint: sentinel '' has no matching project, and we don't want
        -- CASCADE DELETE anyway (deleting a project shouldn't erase location familiarity).

        path TEXT NOT NULL,
        description TEXT,
        purpose TEXT,

        familiarity REAL NOT NULL DEFAULT 0.1,
        access_count INTEGER NOT NULL DEFAULT 0,
        searches_saved INTEGER NOT NULL DEFAULT 0,

        last_accessed TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),

        context_limit INTEGER DEFAULT 50,
        pinned INTEGER DEFAULT 0,

        UNIQUE(project_id, path)
      );

      CREATE INDEX IF NOT EXISTS idx_location_path ON location_intuitions(path);
      CREATE INDEX IF NOT EXISTS idx_location_project ON location_intuitions(project_id);
      CREATE INDEX IF NOT EXISTS idx_location_familiarity ON location_intuitions(familiarity DESC);

      -- Location Access Contexts (entorhinal binding)
      CREATE TABLE IF NOT EXISTS location_access_contexts (
        id TEXT PRIMARY KEY,
        location_id TEXT NOT NULL REFERENCES location_intuitions(id) ON DELETE CASCADE,

        context_description TEXT NOT NULL,
        was_direct_access INTEGER NOT NULL DEFAULT 0,
        task_context TEXT,

        activity_type TEXT DEFAULT 'unknown',
        activity_source TEXT DEFAULT 'default',
        is_summary INTEGER DEFAULT 0,

        accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_context_location ON location_access_contexts(location_id);
      CREATE INDEX IF NOT EXISTS idx_context_time ON location_access_contexts(accessed_at);
      CREATE INDEX IF NOT EXISTS idx_context_activity ON location_access_contexts(activity_type);
      CREATE INDEX IF NOT EXISTS idx_context_location_activity ON location_access_contexts(location_id, activity_type);

      -- Location Associations (hippocampal place field overlap)
      -- Files accessed together form associative networks, just as
      -- nearby places activate overlapping hippocampal place cells.
      CREATE TABLE IF NOT EXISTS location_associations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES location_intuitions(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES location_intuitions(id) ON DELETE CASCADE,
        strength REAL NOT NULL DEFAULT 0.1,
        co_access_count INTEGER NOT NULL DEFAULT 1,
        last_co_access TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_id, target_id)
      );

      CREATE INDEX IF NOT EXISTS idx_loc_assoc_source ON location_associations(source_id);
      CREATE INDEX IF NOT EXISTS idx_loc_assoc_target ON location_associations(target_id);
      CREATE INDEX IF NOT EXISTS idx_loc_assoc_strength ON location_associations(strength DESC);

      -- Visual Memories (description-based, not file storage)
      -- Stores Claude's semantic descriptions of images/videos with emotional context.
      -- The actual media files remain with the user - we only store the "memory" (description).
      CREATE TABLE IF NOT EXISTS visual_memories (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,           -- Claude's description (the actual "memory")
        original_path TEXT,                  -- Reference to original file (user's copy)
        media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
        objects TEXT DEFAULT '[]',           -- JSON array of detected objects
        emotional_valence REAL DEFAULT 0,    -- -1 to 1
        emotional_arousal REAL DEFAULT 0.5,  -- 0 to 1
        significance REAL DEFAULT 0.5,       -- 0 to 1
        shared_by TEXT,                      -- Who shared it
        source TEXT NOT NULL CHECK (source IN ('direct', 'video_frame', 'other')),
        received_at INTEGER NOT NULL,        -- When received
        last_accessed INTEGER,               -- For base-level activation
        access_count INTEGER DEFAULT 0,      -- Frequency tracking
        created_at INTEGER NOT NULL,
        project_id TEXT                      -- Project context for Phase 3 boost
      );

      -- Visual Memory Embeddings (from description text)
      CREATE TABLE IF NOT EXISTS visual_embeddings (
        visual_memory_id TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        model TEXT NOT NULL,
        FOREIGN KEY (visual_memory_id) REFERENCES visual_memories(id) ON DELETE CASCADE
      );

      -- Visual access history for ACT-R base-level activation
      CREATE TABLE IF NOT EXISTS visual_access_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visual_memory_id TEXT NOT NULL,
        accessed_at INTEGER NOT NULL,
        FOREIGN KEY (visual_memory_id) REFERENCES visual_memories(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_visual_memories_shared_by ON visual_memories(shared_by);
      CREATE INDEX IF NOT EXISTS idx_visual_memories_received_at ON visual_memories(received_at);
      CREATE INDEX IF NOT EXISTS idx_visual_memories_significance ON visual_memories(significance);
      CREATE INDEX IF NOT EXISTS idx_visual_memories_project ON visual_memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_visual_access_memory ON visual_access_history(visual_memory_id);

      -- Sessions for temporal context tracking (Phase 4)
      -- Sessions auto-expire after 30 minutes of inactivity
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        project_id TEXT,
        last_active_at INTEGER NOT NULL,
        metadata TEXT DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_at);
    `)
	}

	// ============================================================================
	// Memories
	// ============================================================================

	/**
	 * Store a new memory.
	 */
	storeMemory(input: MemoryInput): Memory {
		const id = randomUUID()
		const now = Date.now()
		const tags = JSON.stringify(input.tags ?? [])

		this.db
			.prepare(`
      INSERT INTO memories (id, type, content, gist, created_at, emotional_weight, project_id, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
			.run(
				id,
				input.type ?? "learning",
				input.content,
				input.gist ?? null,
				now,
				input.emotionalWeight ?? 0.5,
				input.projectId ?? null,
				tags
			)

		// Record initial access
		this.recordAccess(id)

		// biome-ignore lint/style/noNonNullAssertion: just inserted with this id
		return this.getMemory(id)!
	}

	/**
	 * Get a memory by ID.
	 */
	getMemory(id: string): Memory | null {
		const row = this.db
			.prepare(`
      SELECT * FROM memories WHERE id = ?
    `)
			.get(id) as MemoryRow | null

		return row ? this.rowToMemory(row) : null
	}

	/**
	 * Update a memory's content or metadata.
	 */
	updateMemory(id: string, updates: Partial<MemoryInput>): Memory | null {
		const sets: string[] = []
		const values: (string | number | null)[] = []

		if (updates.content !== undefined) {
			sets.push("content = ?")
			values.push(updates.content)
		}
		if (updates.gist !== undefined) {
			sets.push("gist = ?")
			values.push(updates.gist)
		}
		if (updates.emotionalWeight !== undefined) {
			sets.push("emotional_weight = ?")
			values.push(updates.emotionalWeight)
		}
		if (updates.tags !== undefined) {
			sets.push("tags = ?")
			values.push(JSON.stringify(updates.tags))
		}
		if (updates.type !== undefined) {
			sets.push("type = ?")
			values.push(updates.type)
		}

		if (sets.length === 0) return this.getMemory(id)

		values.push(id)
		this.db
			.prepare(`
      UPDATE memories SET ${sets.join(", ")} WHERE id = ?
    `)
			.run(...values)

		return this.getMemory(id)
	}

	/**
	 * Delete a memory and all its associations.
	 */
	deleteMemory(id: string): boolean {
		const result = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
		return result.changes > 0
	}

	/**
	 * Record an access event for a memory (updates recency/frequency).
	 */
	recordAccess(memoryId: string): void {
		const now = Date.now()

		this.db
			.prepare(`
      UPDATE memories SET last_accessed = ?, access_count = access_count + 1
      WHERE id = ?
    `)
			.run(now, memoryId)

		this.db
			.prepare(`
      INSERT INTO access_history (memory_id, accessed_at) VALUES (?, ?)
    `)
			.run(memoryId, now)
	}

	/**
	 * Get access history for a memory (for base-level activation).
	 */
	getAccessHistory(memoryId: string): number[] {
		const rows = this.db
			.prepare(`
      SELECT accessed_at FROM access_history WHERE memory_id = ? ORDER BY accessed_at DESC
    `)
			.all(memoryId) as { accessed_at: number }[]

		return rows.map((r) => r.accessed_at)
	}

	/**
	 * Query memories with filters.
	 */
	queryMemories(
		options: {
			projectId?: string
			type?: MemoryType
			limit?: number
			offset?: number
			minAccessCount?: number
		} = {}
	): Memory[] {
		const conditions: string[] = []
		const values: (string | number | null)[] = []

		if (options.projectId) {
			conditions.push("project_id = ?")
			values.push(options.projectId)
		}
		if (options.type) {
			conditions.push("type = ?")
			values.push(options.type)
		}
		if (options.minAccessCount !== undefined) {
			conditions.push("access_count >= ?")
			values.push(options.minAccessCount)
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
		const limit = options.limit ?? 100
		const offset = options.offset ?? 0

		const rows = this.db
			.prepare(`
      SELECT * FROM memories ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
			.all(...values, limit, offset) as MemoryRow[]

		return rows.map((r) => this.rowToMemory(r))
	}

	/**
	 * Get all memories for retrieval (includes metadata needed for ranking).
	 */
	getAllForRetrieval(projectId?: string): {
		memories: Memory[]
		accessHistories: number[][]
		emotionalWeights: number[]
	} {
		const condition = projectId ? "WHERE project_id = ?" : ""
		const values = projectId ? [projectId] : []

		const rows = this.db
			.prepare(`
      SELECT * FROM memories ${condition} ORDER BY created_at DESC
    `)
			.all(...values) as MemoryRow[]

		const memories = rows.map((r) => this.rowToMemory(r))
		const accessHistories = memories.map((m) => this.getAccessHistory(m.id))
		const emotionalWeights = memories.map((m) => m.emotionalWeight)

		return { memories, accessHistories, emotionalWeights }
	}

	// ============================================================================
	// Embeddings
	// ============================================================================

	/**
	 * Store an embedding for a memory.
	 */
	storeEmbedding(memoryId: string, vector: number[], model: string): void {
		const blob = new Uint8Array(new Float32Array(vector).buffer)

		this.db
			.prepare(`
      INSERT OR REPLACE INTO embeddings (memory_id, vector, model) VALUES (?, ?, ?)
    `)
			.run(memoryId, blob, model)
	}

	/**
	 * Get embedding for a memory.
	 */
	getEmbedding(memoryId: string): number[] | null {
		const row = this.db
			.prepare(`
      SELECT vector FROM embeddings WHERE memory_id = ?
    `)
			.get(memoryId) as { vector: Uint8Array } | null

		if (!row) return null

		// LOW-4: Use spread operator instead of Array.from() for better performance
		return [
			...new Float32Array(
				row.vector.buffer,
				row.vector.byteOffset,
				row.vector.byteLength / 4
			),
		]
	}

	/**
	 * Get all embeddings (for batch similarity operations).
	 */
	getAllEmbeddings(): Map<string, number[]> {
		const rows = this.db
			.prepare(`
      SELECT memory_id, vector FROM embeddings
    `)
			.all() as { memory_id: string; vector: Uint8Array }[]

		const map = new Map<string, number[]>()
		for (const row of rows) {
			// LOW-4: Use spread operator instead of Array.from() for better performance
			const vector = [
				...new Float32Array(
					row.vector.buffer,
					row.vector.byteOffset,
					row.vector.byteLength / 4
				),
			]
			map.set(row.memory_id, vector)
		}
		return map
	}

	/**
	 * Check if memory has an embedding.
	 */
	hasEmbedding(memoryId: string): boolean {
		const row = this.db
			.prepare(`
      SELECT 1 FROM embeddings WHERE memory_id = ?
    `)
			.get(memoryId)
		return !!row
	}

	/**
	 * Get memories missing embeddings.
	 */
	getMemoriesWithoutEmbeddings(limit = 100): Memory[] {
		const rows = this.db
			.prepare(`
      SELECT m.* FROM memories m
      LEFT JOIN embeddings e ON m.id = e.memory_id
      WHERE e.memory_id IS NULL
      LIMIT ?
    `)
			.all(limit) as MemoryRow[]

		return rows.map((r) => this.rowToMemory(r))
	}

	// ============================================================================
	// Associations
	// ============================================================================

	/**
	 * Create or update an association between two memories.
	 */
	associate(
		sourceId: string,
		targetId: string,
		strength: number,
		type: Association["type"] = "semantic"
	): void {
		this.db
			.prepare(`
      INSERT INTO associations (source_id, target_id, strength, type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (source_id, target_id) DO UPDATE SET strength = ?, type = ?
    `)
			.run(sourceId, targetId, strength, type, strength, type)
	}

	/**
	 * Get associations for a memory.
	 */
	getAssociations(memoryId: string): Association[] {
		const rows = this.db
			.prepare(`
      SELECT * FROM associations WHERE source_id = ? OR target_id = ?
    `)
			.all(memoryId, memoryId) as AssociationRow[]

		return rows.map((r) => ({
			sourceId: r.source_id,
			targetId: r.target_id,
			strength: r.strength,
			type: isAssociationType(r.type) ? r.type : "semantic",
		}))
	}

	/**
	 * Get all associations (for spreading activation).
	 */
	getAllAssociations(): Association[] {
		const rows = this.db
			.prepare(`SELECT * FROM associations`)
			.all() as AssociationRow[]

		return rows.map((r) => ({
			sourceId: r.source_id,
			targetId: r.target_id,
			strength: r.strength,
			type: isAssociationType(r.type) ? r.type : "semantic",
		}))
	}

	/**
	 * Remove an association.
	 */
	dissociate(sourceId: string, targetId: string): boolean {
		try {
			const result = this.db
				.prepare(`
        DELETE FROM associations WHERE source_id = ? AND target_id = ?
      `)
				.run(sourceId, targetId)
			return result.changes > 0
		} catch (error) {
			console.error("[lucid] Failed to dissociate:", error)
			return false
		}
	}

	// ============================================================================
	// Projects
	// ============================================================================

	/**
	 * Get or create a project by path.
	 */
	getOrCreateProject(path: string, name?: string): Project {
		const existing = this.db
			.prepare(`SELECT * FROM projects WHERE path = ?`)
			.get(path) as ProjectRow | null

		if (existing) {
			// Update last active
			this.db
				.prepare(`UPDATE projects SET last_active = ? WHERE id = ?`)
				.run(Date.now(), existing.id)
			return this.rowToProject(existing)
		}

		const id = randomUUID()
		const now = Date.now()
		this.db
			.prepare(`
      INSERT INTO projects (id, path, name, last_active, context) VALUES (?, ?, ?, ?, '{}')
    `)
			.run(id, path, name ?? null, now)

		return { id, path, name: name ?? null, lastActive: now, context: {} }
	}

	/**
	 * Update project context.
	 */
	updateProjectContext(
		projectId: string,
		context: Record<string, unknown>
	): void {
		this.db
			.prepare(`
      UPDATE projects SET context = ?, last_active = ? WHERE id = ?
    `)
			.run(JSON.stringify(context), Date.now(), projectId)
	}

	// ============================================================================
	// Location Intuitions
	// ============================================================================

	/**
	 * In-memory counter for batched pruning. Resets on server restart.
	 * This is intentional - pruning is an optimization, not correctness-critical.
	 */
	private contextPruningCounter: Map<string, number> = new Map()
	private readonly PRUNE_EVERY_N_ACCESSES = 10

	/**
	 * Recent access cache for co-access tracking.
	 *
	 * Biological analogy: Hippocampal place cells that fire together wire together.
	 * Files accessed in close temporal proximity form associative networks.
	 *
	 * We track two types of associations:
	 * 1. Task-based (strong): Files with matching taskContext are conceptually linked
	 *    regardless of timing - they're part of the same mental unit of work.
	 * 2. Time-based (fallback): Files accessed within 1 hour are likely related
	 *    when no explicit task context is available.
	 *
	 * Activity type matching strengthens associations further:
	 * - Files debugged together share a problem space
	 * - Files written together share a feature
	 * - Files read together share a knowledge domain
	 */
	private recentAccesses: {
		locationId: string
		timestamp: number
		projectId: string
		taskContext: string | null
		activityType: ActivityType
		sessionId: string | null
	}[] = []
	private readonly CO_ACCESS_WINDOW_MS = 60 * 60 * 1000 // 1 hour (fallback)

	/**
	 * Task context location cache - tracks all locations accessed under each task.
	 * This enables strong associations between files worked on for the same purpose,
	 * regardless of timing. Key insight: "implementing login" might span multiple
	 * sessions across days, but all those files are conceptually linked.
	 *
	 * MED-1: Uses LRU eviction to prevent unbounded growth (max 100 task keys).
	 */
	private taskContextLocations: Map<
		string,
		{ locationId: string; activityType: ActivityType; lastAccessedAt: number }[]
	> = new Map()
	private readonly MAX_TASK_CONTEXT_KEYS = 100
	private readonly MAX_RECENT_ACCESSES = 500

	/**
	 * Normalize project ID - empty string means global.
	 */
	private normalizeProjectId(projectId?: string | null): string {
		return projectId ?? ""
	}

	/**
	 * Infer activity type with explicit precedence:
	 * 1. Explicit (user-provided) - highest priority
	 * 2. Keyword-based (context analysis) - medium priority
	 * 3. Tool-based - lower priority
	 * 4. Default ('unknown') - fallback
	 *
	 * Uses Rust implementation when available for consistency with core algorithms.
	 */
	inferActivityType(
		context: string,
		toolName?: string,
		explicit?: ActivityType
	): ActivityInference {
		// Use Rust if available
		if (nativeLocation) {
			const result = nativeLocation.locationInferActivity(
				context,
				toolName ?? null,
				explicit ?? null
			)
			return {
				activityType: isActivityType(result.activityType)
					? result.activityType
					: "unknown",
				source: isInferenceSource(result.source) ? result.source : "default",
				confidence: result.confidence,
			}
		}

		// TypeScript fallback (mirrors Rust implementation for cross-platform support)
		// 1. Explicit always wins
		if (explicit && explicit !== "unknown") {
			return { activityType: explicit, source: "explicit", confidence: 1.0 }
		}

		// 2. Keyword-based (intent indicators)
		const lowerContext = context.toLowerCase()
		const keywordMatches: {
			type: ActivityType
			keywords: string[]
			confidence: number
		}[] = [
			{
				type: "debugging",
				keywords: ["debug", "fix", "bug", "issue", "error", "trace"],
				confidence: 0.9,
			},
			{
				type: "refactoring",
				keywords: ["refactor", "clean", "reorganize", "restructure"],
				confidence: 0.9,
			},
			{
				type: "reviewing",
				keywords: ["review", "understand", "check", "examine", "audit"],
				confidence: 0.8,
			},
			{
				type: "writing",
				keywords: ["implement", "add", "create", "write", "build"],
				confidence: 0.7,
			},
			{
				type: "reading",
				keywords: ["read", "look", "see", "view", "inspect"],
				confidence: 0.6,
			},
		]

		for (const match of keywordMatches) {
			if (match.keywords.some((kw) => lowerContext.includes(kw))) {
				return {
					activityType: match.type,
					source: "keyword",
					confidence: match.confidence,
				}
			}
		}

		// 3. Tool-based inference
		if (toolName) {
			const toolActivity: Record<string, ActivityType> = {
				Read: "reading",
				Edit: "writing",
				Write: "writing",
				Grep: "reading",
				Glob: "reading",
			}
			if (toolActivity[toolName]) {
				return {
					activityType: toolActivity[toolName],
					source: "tool",
					confidence: 0.5,
				}
			}
		}

		// 4. Default
		return { activityType: "unknown", source: "default", confidence: 0.0 }
	}

	/**
	 * Record a file access - the primary way locations become "known".
	 * Uses atomic upsert to avoid race conditions.
	 *
	 * Biological analogy: Each visit strengthens the hippocampal trace.
	 * Familiarity follows: f(n) = 1 - 1/(1 + 0.1n)
	 */
	recordFileAccess(record: FileAccessRecord): LocationIntuition {
		const now = new Date().toISOString()
		const id = randomUUID()
		const contextId = randomUUID()
		const projectId = this.normalizeProjectId(record.projectId)
		const inference = this.inferActivityType(
			record.context,
			undefined,
			record.activityType
		)

		// Compute initial familiarity using Rust if available
		const initialFamiliarity = nativeLocation
			? nativeLocation.locationComputeFamiliarity(1)
			: 0.091 // f(1) = 1 - 1/1.1 ≈ 0.091

		// HIGH-9: Wrap core DB operations in transaction for consistency
		let location: LocationIntuition
		try {
			this.db.exec("BEGIN IMMEDIATE")

			// Atomic upsert - no race condition
			// Note: SQL computes familiarity on update for efficiency (avoids round-trip)
			this.db
				.prepare(`
        INSERT INTO location_intuitions
        (id, project_id, path, description, familiarity, access_count, searches_saved, last_accessed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(project_id, path) DO UPDATE SET
          access_count = access_count + 1,
          searches_saved = searches_saved + excluded.searches_saved,
          familiarity = 1.0 - 1.0 / (1.0 + 0.1 * (access_count + 1)),
          last_accessed = excluded.last_accessed,
          updated_at = excluded.updated_at,
          description = COALESCE(description, excluded.description)
      `)
				.run(
					id,
					projectId,
					record.path,
					record.context,
					initialFamiliarity,
					record.wasDirectAccess ? 1 : 0,
					now,
					now,
					now
				)

			// Get the location (whether inserted or updated)
			// biome-ignore lint/style/noNonNullAssertion: just upserted this location
			location = this.getLocationByPath(record.path, record.projectId)!

			// Record access context (entorhinal binding)
			this.db
				.prepare(`
        INSERT INTO location_access_contexts
        (id, location_id, context_description, was_direct_access, task_context, activity_type, activity_source, accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
				.run(
					contextId,
					location.id,
					record.context,
					record.wasDirectAccess ? 1 : 0,
					record.taskContext ?? null,
					inference.activityType,
					inference.source,
					now
				)

			this.db.exec("COMMIT")
		} catch (error) {
			this.db.exec("ROLLBACK")
			throw error
		}

		// Post-transaction operations (can fail independently)
		// Batched pruning
		this.maybeRunPruning(location.id, location.contextLimit)

		// Co-access tracking (hippocampal place field overlap)
		// Phase 4: Pass session ID for session-based association boosting
		this.trackCoAccess(
			location.id,
			projectId,
			record.taskContext ?? null,
			inference.activityType,
			record.sessionId ?? null
		)

		// Phase 4: Keep session active during file access
		if (record.sessionId) {
			this.touchSession(record.sessionId)
		}

		return location
	}

	/**
	 * Track co-access relationships between locations.
	 *
	 * Two association mechanisms, reflecting how memory actually works:
	 *
	 * 1. TASK-BASED (primary, strong signal):
	 *    Files accessed with the same taskContext are conceptually linked.
	 *    "Implementing user login" might span multiple sessions over days,
	 *    but all those files are part of the same mental unit of work.
	 *    This is the user explicitly telling us "these belong together."
	 *
	 * 2. TIME-BASED (fallback, weaker signal):
	 *    Files accessed within 1 hour are likely related when no explicit
	 *    task context is provided. Less reliable but catches implicit patterns.
	 *
	 * Activity type matching provides additional signal:
	 * - Files debugged together share a problem space (strong link)
	 * - Files written together share a feature (strong link)
	 * - Mixed activities are still related but weaker
	 */
	private trackCoAccess(
		locationId: string,
		projectId: string,
		taskContext: string | null,
		activityType: ActivityType,
		sessionId: string | null = null
	): void {
		const now = Date.now()

		// === TASK-BASED ASSOCIATIONS (strong signal) ===
		if (taskContext) {
			const taskKey = `${projectId}:${taskContext}`
			const taskLocations = this.taskContextLocations.get(taskKey) || []

			// Associate with all other locations in the same task
			for (const other of taskLocations) {
				if (other.locationId !== locationId) {
					// Same task = true, activity match determines strength
					// Session info not tracked in task cache (spans sessions)
					const isSameActivity = other.activityType === activityType
					this.strengthenLocationAssociation(
						other.locationId,
						locationId,
						true,
						isSameActivity,
						false // Task-based associations span sessions
					)
				}
			}

			// Add current location to task cache with timestamp
			taskLocations.push({ locationId, activityType, lastAccessedAt: now })
			this.taskContextLocations.set(taskKey, taskLocations)

			// Limit per-task array size
			if (taskLocations.length > 100) {
				taskLocations.shift()
			}

			// MED-1: LRU eviction for task keys when over capacity
			if (this.taskContextLocations.size > this.MAX_TASK_CONTEXT_KEYS) {
				let oldestKey: string | null = null
				let oldestTime = Infinity
				for (const [key, locs] of this.taskContextLocations) {
					const lastAccess =
						locs.length > 0 ? locs[locs.length - 1].lastAccessedAt : 0
					if (lastAccess < oldestTime) {
						oldestTime = lastAccess
						oldestKey = key
					}
				}
				if (oldestKey) {
					this.taskContextLocations.delete(oldestKey)
				}
			}
		}

		// === TIME-BASED ASSOCIATIONS (fallback) ===
		// Prune old entries
		this.recentAccesses = this.recentAccesses.filter(
			(a) => now - a.timestamp < this.CO_ACCESS_WINDOW_MS
		)

		// Find recent accesses in the same project (excluding self)
		const recentInSameProject = this.recentAccesses.filter(
			(a) => a.projectId === projectId && a.locationId !== locationId
		)

		// Create/strengthen associations with recent locations
		for (const recent of recentInSameProject) {
			// If both have task context and they match, skip (already handled above)
			if (taskContext && recent.taskContext === taskContext) {
				continue
			}

			// Time-based: not same task, activity match determines strength
			// Phase 4: Session match provides 1.5x multiplier
			const isSameActivity = recent.activityType === activityType
			const isSameSession =
				sessionId !== null &&
				recent.sessionId !== null &&
				sessionId === recent.sessionId
			this.strengthenLocationAssociation(
				recent.locationId,
				locationId,
				false,
				isSameActivity,
				isSameSession
			)
		}

		// Add current access to the time-based cache
		this.recentAccesses.push({
			locationId,
			timestamp: now,
			projectId,
			taskContext,
			activityType,
			sessionId,
		})

		// MED-2: Hard limit on recentAccesses size as safeguard
		if (this.recentAccesses.length > this.MAX_RECENT_ACCESSES) {
			this.recentAccesses = this.recentAccesses.slice(-this.MAX_RECENT_ACCESSES)
		}
	}

	/**
	 * Strengthen association between two locations (bidirectional).
	 *
	 * Strength follows asymptotic curve: s(n) = 1 - 1/(1 + 0.1n * multiplier)
	 * Uses Rust for strength computation when available.
	 *
	 * Multiplier reflects association quality:
	 * - 5x: Same task + same activity (strongest conceptual link)
	 * - 3x: Same task, different activity (clear conceptual link)
	 * - 2x: Time-based + same activity (probable link)
	 * - 1x: Time-based only (possible link, fallback)
	 *
	 * Session multiplier (Phase 4):
	 * - 1.5x: Same session (applied on top of base multiplier)
	 *
	 * Higher multiplier = faster approach to max strength.
	 * This means task-based associations reach "strong" status in fewer accesses.
	 */
	private strengthenLocationAssociation(
		sourceId: string,
		targetId: string,
		isSameTask: boolean,
		isSameActivity: boolean,
		isSameSession = false
	): void {
		const now = new Date().toISOString()

		// Compute initial strength using Rust if available
		const initialStrength = nativeLocation
			? nativeLocation.locationAssociationStrength(
					1,
					isSameTask,
					isSameActivity
				)
			: this.computeAssociationStrengthTS(1, isSameTask, isSameActivity)

		// Determine base multiplier for SQL update (TypeScript fallback logic)
		const baseMultiplier = isSameTask
			? isSameActivity
				? 5
				: 3
			: isSameActivity
				? 2
				: 1

		// Phase 4: Session multiplier (1.5x for same session)
		const sessionMultiplier = isSameSession ? 1.5 : 1.0
		const multiplier = baseMultiplier * sessionMultiplier

		// HIGH-10: Wrap bidirectional upsert in transaction with error handling
		try {
			this.db.exec("BEGIN IMMEDIATE")

			// Upsert in both directions for bidirectional association
			const pairs: [string, string][] = [
				[sourceId, targetId],
				[targetId, sourceId],
			]
			for (const [src, tgt] of pairs) {
				this.db
					.prepare(`
          INSERT INTO location_associations
          (id, source_id, target_id, strength, co_access_count, last_co_access, created_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(source_id, target_id) DO UPDATE SET
            co_access_count = co_access_count + ?,
            strength = 1.0 - 1.0 / (1.0 + 0.1 * (co_access_count + ?)),
            last_co_access = excluded.last_co_access
        `)
					.run(
						randomUUID(),
						src,
						tgt,
						initialStrength,
						now,
						now,
						multiplier,
						multiplier
					)
			}

			this.db.exec("COMMIT")
		} catch (error) {
			this.db.exec("ROLLBACK")
			console.error("[lucid] Failed to strengthen location association:", error)
		}
	}

	/**
	 * TypeScript fallback for association strength computation.
	 */
	private computeAssociationStrengthTS(
		count: number,
		isSameTask: boolean,
		isSameActivity: boolean
	): number {
		const multiplier = isSameTask
			? isSameActivity
				? 5
				: 3
			: isSameActivity
				? 2
				: 1
		const effectiveCount = count * multiplier
		return 1.0 - 1.0 / (1.0 + 0.1 * effectiveCount)
	}

	/**
	 * Run pruning if we've hit the threshold for this location.
	 */
	private maybeRunPruning(locationId: string, limit: number): void {
		const count = (this.contextPruningCounter.get(locationId) || 0) + 1
		this.contextPruningCounter.set(locationId, count)

		if (count >= this.PRUNE_EVERY_N_ACCESSES) {
			this.pruneContextsIfNeeded(locationId, limit)
			this.contextPruningCounter.set(locationId, 0)
		}
	}

	/**
	 * Prune old contexts beyond the limit using window function.
	 */
	private pruneContextsIfNeeded(locationId: string, limit: number): void {
		this.db
			.prepare(`
      DELETE FROM location_access_contexts
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (ORDER BY accessed_at DESC) as rn
          FROM location_access_contexts
          WHERE location_id = ?
        ) WHERE rn > ?
      )
    `)
			.run(locationId, limit)
	}

	/**
	 * Get a location by ID.
	 */
	getLocation(id: string): LocationIntuition | null {
		const row = this.db
			.prepare(`
      SELECT * FROM location_intuitions WHERE id = ?
    `)
			.get(id) as LocationIntuitionRow | null

		return row ? this.rowToLocationIntuition(row) : null
	}

	/**
	 * Get a location by path (within project scope).
	 */
	getLocationByPath(
		path: string,
		projectId?: string
	): LocationIntuition | null {
		const row = this.db
			.prepare(`
      SELECT * FROM location_intuitions
      WHERE path = ? AND project_id = ?
    `)
			.get(
				path,
				this.normalizeProjectId(projectId)
			) as LocationIntuitionRow | null

		return row ? this.rowToLocationIntuition(row) : null
	}

	/**
	 * Check if a path is "well-known" (high familiarity).
	 * Uses Rust for threshold check when available.
	 */
	isLocationWellKnown(
		path: string,
		projectId?: string,
		threshold = 0.7
	): boolean {
		const location = this.getLocationByPath(path, projectId)
		if (!location) return false

		// Use Rust if available (handles config-based threshold)
		if (nativeLocation) {
			return nativeLocation.locationIsWellKnown(location.familiarity)
		}

		return location.familiarity >= threshold
	}

	/**
	 * Get all known locations, sorted by familiarity.
	 */
	getAllLocations(projectId?: string, limit = 50): LocationIntuition[] {
		const rows = this.db
			.prepare(`
      SELECT * FROM location_intuitions
      WHERE project_id = ?
      ORDER BY familiarity DESC
      LIMIT ?
    `)
			.all(this.normalizeProjectId(projectId), limit) as LocationIntuitionRow[]

		return rows.map((row) => this.rowToLocationIntuition(row))
	}

	/**
	 * Get most recently accessed locations.
	 */
	getRecentLocations(projectId?: string, limit = 20): LocationIntuition[] {
		const rows = this.db
			.prepare(`
      SELECT * FROM location_intuitions
      WHERE project_id = ?
      AND last_accessed IS NOT NULL
      ORDER BY last_accessed DESC
      LIMIT ?
    `)
			.all(this.normalizeProjectId(projectId), limit) as LocationIntuitionRow[]

		return rows.map((row) => this.rowToLocationIntuition(row))
	}

	/**
	 * Find locations matching a pattern (fuzzy search).
	 */
	findLocations(
		pattern: string,
		projectId?: string,
		limit = 20
	): LocationIntuition[] {
		const rows = this.db
			.prepare(`
      SELECT * FROM location_intuitions
      WHERE project_id = ?
      AND (path LIKE ? OR description LIKE ?)
      ORDER BY familiarity DESC
      LIMIT ?
    `)
			.all(
				this.normalizeProjectId(projectId),
				`%${pattern}%`,
				`%${pattern}%`,
				limit
			) as LocationIntuitionRow[]

		return rows.map((row) => this.rowToLocationIntuition(row))
	}

	/**
	 * Get access contexts for a location.
	 */
	getAccessContexts(locationId: string, limit = 50): LocationAccessContext[] {
		const rows = this.db
			.prepare(`
      SELECT * FROM location_access_contexts
      WHERE location_id = ?
      ORDER BY accessed_at DESC
      LIMIT ?
    `)
			.all(locationId, limit) as LocationAccessContextRow[]

		return rows.map((row) => this.rowToLocationAccessContext(row))
	}

	/**
	 * Get location with all its access contexts.
	 */
	getLocationWithContexts(
		path: string,
		projectId?: string
	): LocationWithContexts | null {
		const location = this.getLocationByPath(path, projectId)
		if (!location) return null

		const contexts = this.getAccessContexts(location.id)
		return { ...location, accessContexts: contexts }
	}

	/**
	 * Get locations by activity type.
	 *
	 * Answers: "What files have I debugged recently?" or "Where have I been writing?"
	 * This is a key entorhinal query pattern - context-based spatial retrieval.
	 */
	getLocationsByActivity(
		activityType: ActivityType,
		projectId?: string,
		limit = 20
	): (LocationIntuition & { activityCount: number; lastActivity: string })[] {
		const rows = this.db
			.prepare(`
      SELECT li.*,
             COUNT(lac.id) as activity_count,
             MAX(lac.accessed_at) as last_activity
      FROM location_intuitions li
      JOIN location_access_contexts lac ON lac.location_id = li.id
      WHERE lac.activity_type = ?
      AND li.project_id = ?
      GROUP BY li.id
      ORDER BY last_activity DESC
      LIMIT ?
    `)
			.all(
				activityType,
				this.normalizeProjectId(projectId),
				limit
			) as (LocationIntuitionRow & {
			activity_count: number
			last_activity: string
		})[]

		return rows.map((row) => ({
			...this.rowToLocationIntuition(row),
			activityCount: row.activity_count,
			lastActivity: row.last_activity,
		}))
	}

	/**
	 * Get location statistics.
	 */
	getLocationStats(projectId?: string): LocationStats {
		const normalizedProjectId = this.normalizeProjectId(projectId)

		const stats = this.db
			.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN familiarity > 0.7 THEN 1 ELSE 0 END) as high_familiarity,
        SUM(searches_saved) as total_searches_saved,
        AVG(familiarity) as avg_familiarity
      FROM location_intuitions
      WHERE project_id = ?
    `)
			.get(normalizedProjectId) as {
			total: number
			high_familiarity: number
			total_searches_saved: number
			avg_familiarity: number
		}

		const mostFamiliar = this.db
			.prepare(`
      SELECT path FROM location_intuitions
      WHERE project_id = ?
      ORDER BY familiarity DESC
      LIMIT 5
    `)
			.all(normalizedProjectId) as { path: string }[]

		return {
			totalLocations: stats.total || 0,
			highFamiliarity: stats.high_familiarity || 0,
			totalSearchesSaved: stats.total_searches_saved || 0,
			averageFamiliarity: stats.avg_familiarity || 0,
			mostFamiliarPaths: mostFamiliar.map((r) => r.path),
		}
	}

	/**
	 * Continuous decay function - rate smoothly decreases with familiarity.
	 *
	 * decayRate(f) = maxDecay * (1 - f * dampening)
	 * floor(f) = baseFloor + (f > 0.5 ? stickyBonus * (f - 0.5) : 0)
	 *
	 * Default 30-day threshold before decay begins reflects realistic usage:
	 * - Vacation/time off shouldn't cause significant forgetting
	 * - Project switches (work on project B for a month) are common
	 * - Well-known files (high familiarity) have sticky floors anyway
	 * - Mirrors human spatial memory: familiar places stay known for weeks
	 *
	 * Design note: Uses SQL-based decay rather than Rust's locationBatchDecay
	 * because SQL UPDATE is more efficient for large datasets (100k+ locations)
	 * and avoids loading all data into memory. Rust decay is available for
	 * individual computations when needed.
	 */
	applyFamiliarityDecay(
		maxDecayRate = 0.1,
		dampening = 0.8,
		baseFloor = 0.1,
		stickyBonus = 0.4,
		staleThresholdDays = 30
	): number {
		const result = this.db
			.prepare(`
      UPDATE location_intuitions
      SET familiarity = MAX(
              ? + (CASE WHEN familiarity > 0.5 THEN ? * (familiarity - 0.5) ELSE 0 END),
              familiarity * (1.0 - ? * (1.0 - familiarity * ?))
          ),
          updated_at = datetime('now')
      WHERE last_accessed < datetime('now', '-' || ? || ' days')
    `)
			.run(baseFloor, stickyBonus, maxDecayRate, dampening, staleThresholdDays)

		return result.changes
	}

	/**
	 * Pin/unpin a location to exempt it from orphan detection.
	 */
	pinLocation(path: string, isPinned: boolean, projectId?: string): boolean {
		const result = this.db
			.prepare(`
      UPDATE location_intuitions
      SET pinned = ?, updated_at = datetime('now')
      WHERE path = ? AND project_id = ?
    `)
			.run(isPinned ? 1 : 0, path, this.normalizeProjectId(projectId))

		return result.changes > 0
	}

	/**
	 * Detect orphaned locations (high familiarity but not accessed recently).
	 */
	detectOrphanedLocations(
		projectId?: string,
		staleThresholdDays = 60,
		minFamiliarityForOrphan = 0.4
	): LocationIntuition[] {
		const rows = this.db
			.prepare(`
      SELECT * FROM location_intuitions
      WHERE project_id = ?
      AND pinned = 0
      AND familiarity >= ?
      AND last_accessed < datetime('now', '-' || ? || ' days')
      ORDER BY familiarity DESC
    `)
			.all(
				this.normalizeProjectId(projectId),
				minFamiliarityForOrphan,
				staleThresholdDays
			) as LocationIntuitionRow[]

		return rows.map((row) => this.rowToLocationIntuition(row))
	}

	/**
	 * Get locations associated with a given location (co-accessed files).
	 *
	 * Biological analogy: Spreading activation through hippocampal networks.
	 * When you think of one place, related places come to mind.
	 */
	getAssociatedLocations(
		locationId: string,
		limit = 10
	): (LocationIntuition & { associationStrength: number })[] {
		const rows = this.db
			.prepare(`
      SELECT li.*, la.strength as association_strength
      FROM location_associations la
      JOIN location_intuitions li ON la.target_id = li.id
      WHERE la.source_id = ?
      ORDER BY la.strength DESC
      LIMIT ?
    `)
			.all(locationId, limit) as (LocationIntuitionRow & {
			association_strength: number
		})[]

		return rows.map((row) => ({
			...this.rowToLocationIntuition(row),
			associationStrength: row.association_strength,
		}))
	}

	/**
	 * Get locations associated with a path (convenience wrapper).
	 */
	getAssociatedLocationsByPath(
		path: string,
		projectId?: string,
		limit = 10
	): (LocationIntuition & { associationStrength: number })[] {
		const location = this.getLocationByPath(path, projectId)
		if (!location) return []
		return this.getAssociatedLocations(location.id, limit)
	}

	/**
	 * Get association statistics for a location.
	 */
	getLocationAssociationStats(locationId: string): {
		associationCount: number
		strongAssociations: number
		averageStrength: number
	} {
		const stats = this.db
			.prepare(`
      SELECT
        COUNT(*) as count,
        SUM(CASE WHEN strength >= 0.5 THEN 1 ELSE 0 END) as strong,
        AVG(strength) as avg_strength
      FROM location_associations
      WHERE source_id = ?
    `)
			.get(locationId) as {
			count: number
			strong: number
			avg_strength: number
		}

		return {
			associationCount: stats.count || 0,
			strongAssociations: stats.strong || 0,
			averageStrength: stats.avg_strength || 0,
		}
	}

	/**
	 * Merge knowledge from an old path into a new path (for renames/moves).
	 */
	mergeLocations(
		oldPath: string,
		newPath: string,
		projectId?: string
	): LocationIntuition | null {
		const oldLocation = this.getLocationByPath(oldPath, projectId)
		const newLocation = this.getLocationByPath(newPath, projectId)

		if (!oldLocation) return newLocation

		this.db.exec("BEGIN TRANSACTION")

		try {
			if (newLocation) {
				// Merge into existing new location
				this.db
					.prepare(`
          UPDATE location_intuitions
          SET access_count = access_count + ?,
              searches_saved = searches_saved + ?,
              familiarity = MAX(familiarity, ?),
              updated_at = datetime('now')
          WHERE id = ?
        `)
					.run(
						oldLocation.accessCount,
						oldLocation.searchesSaved,
						oldLocation.familiarity,
						newLocation.id
					)

				// Move contexts to new location
				this.db
					.prepare(`
          UPDATE location_access_contexts
          SET location_id = ?
          WHERE location_id = ?
        `)
					.run(newLocation.id, oldLocation.id)

				// Delete old location
				this.db
					.prepare(`DELETE FROM location_intuitions WHERE id = ?`)
					.run(oldLocation.id)

				this.db.exec("COMMIT")
				return this.getLocation(newLocation.id)
			} else {
				// Rename old location to new path
				this.db
					.prepare(`
          UPDATE location_intuitions
          SET path = ?, updated_at = datetime('now')
          WHERE id = ?
        `)
					.run(newPath, oldLocation.id)

				this.db.exec("COMMIT")
				return this.getLocation(oldLocation.id)
			}
		} catch (error) {
			this.db.exec("ROLLBACK")
			console.error(
				`[lucid] Failed to merge locations '${oldPath}' -> '${newPath}':`,
				error
			)
			throw error
		}
	}

	/**
	 * Consolidate old contexts into summaries with representative preservation.
	 */
	consolidateOldContexts(locationId: string, olderThanDays = 30): void {
		this.db.exec("BEGIN TRANSACTION")

		try {
			const oldContexts = this.db
				.prepare(`
        SELECT activity_type, COUNT(*) as count,
               MIN(accessed_at) as first_access,
               MAX(accessed_at) as last_access
        FROM location_access_contexts
        WHERE location_id = ?
        AND accessed_at < datetime('now', '-' || ? || ' days')
        AND is_summary = 0
        GROUP BY activity_type
      `)
				.all(locationId, olderThanDays) as {
				activity_type: string
				count: number
				first_access: string
				last_access: string
			}[]

			for (const group of oldContexts) {
				if (group.count <= 2) continue

				const representative = this.db
					.prepare(`
          SELECT * FROM location_access_contexts
          WHERE location_id = ? AND activity_type = ?
          AND is_summary = 0
          ORDER BY accessed_at DESC LIMIT 1
        `)
					.get(locationId, group.activity_type) as
					| LocationAccessContextRow
					| undefined

				// Skip if no representative found (shouldn't happen, but defensive)
				if (!representative) continue

				// Create summary record
				this.db
					.prepare(`
          INSERT INTO location_access_contexts
          (id, location_id, context_description, activity_type, accessed_at, is_summary, was_direct_access, activity_source)
          VALUES (?, ?, ?, ?, ?, 1, 0, 'default')
        `)
					.run(
						randomUUID(),
						locationId,
						`[Summary: ${group.count} ${group.activity_type} sessions from ${group.first_access} to ${group.last_access}. Example: "${representative.context_description}"]`,
						group.activity_type,
						group.last_access
					)

				// Delete old records except representative
				this.db
					.prepare(`
          DELETE FROM location_access_contexts
          WHERE location_id = ? AND activity_type = ?
          AND accessed_at < datetime('now', '-' || ? || ' days')
          AND is_summary = 0
          AND id != ?
        `)
					.run(
						locationId,
						group.activity_type,
						olderThanDays,
						representative.id
					)
			}

			this.db.exec("COMMIT")
		} catch (error) {
			this.db.exec("ROLLBACK")
			throw error
		}
	}

	/**
	 * Convert row to LocationIntuition object.
	 */
	private rowToLocationIntuition(row: LocationIntuitionRow): LocationIntuition {
		return {
			id: row.id,
			projectId: row.project_id,
			path: row.path,
			description: row.description,
			purpose: row.purpose,
			familiarity: row.familiarity,
			accessCount: row.access_count,
			searchesSaved: row.searches_saved,
			lastAccessed: row.last_accessed,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			contextLimit: row.context_limit,
			isPinned: row.pinned === 1,
		}
	}

	/**
	 * Convert row to LocationAccessContext object.
	 */
	private rowToLocationAccessContext(
		row: LocationAccessContextRow
	): LocationAccessContext {
		return {
			id: row.id,
			locationId: row.location_id,
			contextDescription: row.context_description,
			wasDirectAccess: row.was_direct_access === 1,
			taskContext: row.task_context,
			activityType: isActivityType(row.activity_type)
				? row.activity_type
				: "unknown",
			activitySource: isInferenceSource(row.activity_source)
				? row.activity_source
				: "default",
			isSummary: row.is_summary === 1,
			accessedAt: row.accessed_at,
		}
	}

	// ============================================================================
	// Visual Memories
	// ============================================================================

	/**
	 * Store a new visual memory.
	 */
	storeVisualMemory(input: VisualMemoryInput): VisualMemory {
		const id = randomUUID()
		const now = Date.now()
		const objects = JSON.stringify(input.objects ?? [])

		this.db
			.prepare(`
      INSERT INTO visual_memories
      (id, description, original_path, media_type, objects, emotional_valence, emotional_arousal,
       significance, shared_by, source, received_at, created_at, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
			.run(
				id,
				input.description,
				input.originalPath ?? null,
				input.mediaType,
				objects,
				input.emotionalValence ?? 0,
				input.emotionalArousal ?? 0.5,
				input.significance ?? 0.5,
				input.sharedBy ?? null,
				input.source,
				now,
				now,
				input.projectId ?? null
			)

		// Record initial access
		this.recordVisualAccess(id)

		// biome-ignore lint/style/noNonNullAssertion: just inserted with this id
		return this.getVisualMemory(id)!
	}

	/**
	 * Get a visual memory by ID.
	 */
	getVisualMemory(id: string): VisualMemory | null {
		const row = this.db
			.prepare(`SELECT * FROM visual_memories WHERE id = ?`)
			.get(id) as VisualMemoryRow | null

		return row ? this.rowToVisualMemory(row) : null
	}

	/**
	 * Record an access event for a visual memory.
	 */
	recordVisualAccess(visualMemoryId: string): void {
		const now = Date.now()

		this.db
			.prepare(`
      UPDATE visual_memories
      SET last_accessed = ?, access_count = access_count + 1
      WHERE id = ?
    `)
			.run(now, visualMemoryId)

		this.db
			.prepare(`
      INSERT INTO visual_access_history (visual_memory_id, accessed_at)
      VALUES (?, ?)
    `)
			.run(visualMemoryId, now)
	}

	/**
	 * Get access history for a visual memory (for base-level activation).
	 */
	getVisualAccessHistory(visualMemoryId: string): number[] {
		const rows = this.db
			.prepare(`
      SELECT accessed_at FROM visual_access_history
      WHERE visual_memory_id = ?
      ORDER BY accessed_at DESC
    `)
			.all(visualMemoryId) as { accessed_at: number }[]

		return rows.map((r) => r.accessed_at)
	}

	/**
	 * Store an embedding for a visual memory.
	 */
	storeVisualEmbedding(
		visualMemoryId: string,
		vector: number[],
		model: string
	): void {
		const blob = new Uint8Array(new Float32Array(vector).buffer)

		this.db
			.prepare(`
      INSERT OR REPLACE INTO visual_embeddings (visual_memory_id, vector, model)
      VALUES (?, ?, ?)
    `)
			.run(visualMemoryId, blob, model)
	}

	/**
	 * Get embedding for a visual memory.
	 */
	getVisualEmbedding(visualMemoryId: string): number[] | null {
		const row = this.db
			.prepare(
				`SELECT vector FROM visual_embeddings WHERE visual_memory_id = ?`
			)
			.get(visualMemoryId) as { vector: Uint8Array } | null

		if (!row) return null

		// LOW-4: Use spread operator instead of Array.from() for better performance
		return [
			...new Float32Array(
				row.vector.buffer,
				row.vector.byteOffset,
				row.vector.byteLength / 4
			),
		]
	}

	/**
	 * Get all visual embeddings (for batch similarity operations).
	 */
	getAllVisualEmbeddings(): Map<string, number[]> {
		const rows = this.db
			.prepare(`SELECT visual_memory_id, vector FROM visual_embeddings`)
			.all() as { visual_memory_id: string; vector: Uint8Array }[]

		const map = new Map<string, number[]>()
		for (const row of rows) {
			// LOW-4: Use spread operator instead of Array.from() for better performance
			const vector = [
				...new Float32Array(
					row.vector.buffer,
					row.vector.byteOffset,
					row.vector.byteLength / 4
				),
			]
			map.set(row.visual_memory_id, vector)
		}
		return map
	}

	/**
	 * Check if visual memory has an embedding.
	 */
	hasVisualEmbedding(visualMemoryId: string): boolean {
		const row = this.db
			.prepare(`SELECT 1 FROM visual_embeddings WHERE visual_memory_id = ?`)
			.get(visualMemoryId)
		return !!row
	}

	/**
	 * Get visual memories missing embeddings.
	 */
	getVisualMemoriesWithoutEmbeddings(limit = 100): VisualMemory[] {
		const rows = this.db
			.prepare(`
      SELECT vm.* FROM visual_memories vm
      LEFT JOIN visual_embeddings ve ON vm.id = ve.visual_memory_id
      WHERE ve.visual_memory_id IS NULL
      LIMIT ?
    `)
			.all(limit) as VisualMemoryRow[]

		return rows.map((r) => this.rowToVisualMemory(r))
	}

	/**
	 * Get all visual memories for retrieval (includes metadata for ranking).
	 */
	getAllVisualsForRetrieval(): {
		visuals: VisualMemory[]
		accessHistories: number[][]
		emotionalWeights: number[]
		significanceScores: number[]
	} {
		const rows = this.db
			.prepare(`SELECT * FROM visual_memories ORDER BY created_at DESC`)
			.all() as VisualMemoryRow[]

		const visuals = rows.map((r) => this.rowToVisualMemory(r))
		const accessHistories = visuals.map((v) =>
			this.getVisualAccessHistory(v.id)
		)

		// Compute emotional weights: base 0.5 + arousal (0 to 1)
		const emotionalWeights = visuals.map((v) => 0.5 + v.emotionalArousal)
		const significanceScores = visuals.map((v) => v.significance)

		return { visuals, accessHistories, emotionalWeights, significanceScores }
	}

	/**
	 * Query visual memories with filters.
	 */
	queryVisualMemories(
		options: {
			mediaType?: VisualMediaType
			sharedBy?: string
			limit?: number
			minSignificance?: number
		} = {}
	): VisualMemory[] {
		const conditions: string[] = []
		const values: (string | number)[] = []

		if (options.mediaType) {
			conditions.push("media_type = ?")
			values.push(options.mediaType)
		}
		if (options.sharedBy) {
			conditions.push("shared_by = ?")
			values.push(options.sharedBy)
		}
		if (options.minSignificance !== undefined) {
			conditions.push("significance >= ?")
			values.push(options.minSignificance)
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
		const limit = options.limit ?? 100

		const rows = this.db
			.prepare(`
      SELECT * FROM visual_memories ${where}
      ORDER BY received_at DESC
      LIMIT ?
    `)
			.all(...values, limit) as VisualMemoryRow[]

		return rows.map((r) => this.rowToVisualMemory(r))
	}

	/**
	 * Delete a visual memory.
	 */
	deleteVisualMemory(id: string): boolean {
		const result = this.db
			.prepare(`DELETE FROM visual_memories WHERE id = ?`)
			.run(id)
		return result.changes > 0
	}

	/**
	 * Convert row to VisualMemory object.
	 */
	private rowToVisualMemory(row: VisualMemoryRow): VisualMemory {
		return {
			id: row.id,
			description: row.description,
			originalPath: row.original_path,
			mediaType: row.media_type as VisualMediaType,
			objects: safeJsonParse<string[]>(row.objects, []),
			emotionalValence: row.emotional_valence,
			emotionalArousal: row.emotional_arousal,
			significance: row.significance,
			sharedBy: row.shared_by,
			source: row.source as VisualSource,
			receivedAt: row.received_at,
			lastAccessed: row.last_accessed,
			accessCount: row.access_count,
			createdAt: row.created_at,
			projectId: row.project_id,
		}
	}

	// ============================================================================
	// Maintenance
	// ============================================================================

	/**
	 * Prune old memories beyond the limit.
	 */
	pruneOldMemories(maxCount: number): number {
		const countResult = this.db
			.prepare(`SELECT COUNT(*) as count FROM memories`)
			.get() as { count: number }

		if (countResult.count <= maxCount) return 0

		const toDelete = countResult.count - maxCount

		// First, get the IDs to delete (bun:sqlite handles this better in two steps)
		const idsToDelete = this.db
			.prepare(`
      SELECT id FROM memories
      ORDER BY
        COALESCE(last_accessed, created_at) ASC,
        access_count ASC
      LIMIT ?
    `)
			.all(toDelete) as { id: string }[]

		if (idsToDelete.length === 0) return 0

		// Delete using placeholders for each ID
		const placeholders = idsToDelete.map(() => "?").join(",")
		const ids = idsToDelete.map((r) => r.id)

		this.db
			.prepare(`
      DELETE FROM memories WHERE id IN (${placeholders})
    `)
			.run(...ids)

		// Return the number of memories we deleted (not cascade changes)
		return idsToDelete.length
	}

	/**
	 * Get storage statistics.
	 */
	getStats(): {
		memoryCount: number
		embeddingCount: number
		associationCount: number
		projectCount: number
		locationCount: number
		visualMemoryCount: number
		dbSizeBytes: number
	} {
		const memoryCount = (
			this.db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as {
				c: number
			}
		).c
		const embeddingCount = (
			this.db.prepare(`SELECT COUNT(*) as c FROM embeddings`).get() as {
				c: number
			}
		).c
		const associationCount = (
			this.db.prepare(`SELECT COUNT(*) as c FROM associations`).get() as {
				c: number
			}
		).c
		const projectCount = (
			this.db.prepare(`SELECT COUNT(*) as c FROM projects`).get() as {
				c: number
			}
		).c
		const locationCount = (
			this.db
				.prepare(`SELECT COUNT(*) as c FROM location_intuitions`)
				.get() as { c: number }
		).c
		const visualMemoryCount = (
			this.db.prepare(`SELECT COUNT(*) as c FROM visual_memories`).get() as {
				c: number
			}
		).c
		const dbSizeBytes = (
			this.db
				.prepare(
					`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`
				)
				.get() as { size: number }
		).size

		return {
			memoryCount,
			embeddingCount,
			associationCount,
			projectCount,
			locationCount,
			visualMemoryCount,
			dbSizeBytes,
		}
	}

	// ============================================================================
	// Sessions (Phase 4: Temporal Retrieval)
	// ============================================================================

	/** Inactivity threshold for session expiration (30 minutes) */
	private readonly SESSION_INACTIVITY_MS = 30 * 60 * 1000

	/**
	 * Get or create a session for the current context.
	 * Sessions auto-expire after 30 minutes of inactivity.
	 *
	 * @param projectId - Optional project ID for project-scoped sessions
	 * @returns Session ID (existing or newly created)
	 */
	getOrCreateSession(projectId?: string): string {
		const now = Date.now()
		const projectKey = projectId ?? ""

		// Find recent active session for this project
		const row = this.db
			.prepare(
				`
			SELECT id, last_active_at FROM sessions
			WHERE project_id = ? AND ended_at IS NULL
			ORDER BY last_active_at DESC LIMIT 1
		`
			)
			.get(projectKey) as { id: string; last_active_at: number } | undefined

		if (row && now - row.last_active_at < this.SESSION_INACTIVITY_MS) {
			// Update activity and return existing session
			this.db
				.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`)
				.run(now, row.id)
			return row.id
		}

		// Close old session if exists
		if (row) {
			this.db
				.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`)
				.run(now, row.id)
		}

		// Create new session
		const sessionId = randomUUID()
		this.db
			.prepare(
				`
			INSERT INTO sessions (id, started_at, project_id, last_active_at)
			VALUES (?, ?, ?, ?)
		`
			)
			.run(sessionId, now, projectKey, now)

		return sessionId
	}

	/**
	 * Update session activity timestamp (touch).
	 *
	 * @param sessionId - Session ID to update
	 */
	touchSession(sessionId: string): void {
		const now = Date.now()
		this.db
			.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`)
			.run(now, sessionId)
	}

	/**
	 * Get the current active session for a project (if any).
	 *
	 * @param projectId - Optional project ID
	 * @returns Session ID if active, undefined otherwise
	 */
	getCurrentSession(projectId?: string): string | undefined {
		const now = Date.now()
		const projectKey = projectId ?? ""

		const row = this.db
			.prepare(
				`
			SELECT id, last_active_at FROM sessions
			WHERE project_id = ? AND ended_at IS NULL
			ORDER BY last_active_at DESC LIMIT 1
		`
			)
			.get(projectKey) as { id: string; last_active_at: number } | undefined

		if (row && now - row.last_active_at < this.SESSION_INACTIVITY_MS) {
			return row.id
		}

		return undefined
	}

	/**
	 * End a session explicitly.
	 *
	 * @param sessionId - Session ID to end
	 */
	endSession(sessionId: string): void {
		const now = Date.now()
		this.db
			.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`)
			.run(now, sessionId)
	}

	/**
	 * Prune expired sessions older than the specified time.
	 * QW-4: Prevents DB bloat from accumulated expired sessions.
	 *
	 * @param beforeMs - Delete sessions ended before this timestamp (default: 7 days ago)
	 * @returns Number of sessions deleted
	 */
	pruneExpiredSessions(
		beforeMs: number = Date.now() - 7 * 24 * 60 * 60 * 1000
	): number {
		try {
			const result = this.db
				.prepare(
					`DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?`
				)
				.run(beforeMs)
			return result.changes
		} catch (error) {
			console.error("[lucid] Failed to prune expired sessions:", error)
			return 0
		}
	}

	/**
	 * Close the database connection.
	 */
	close(): void {
		this.db.close()
	}

	// ============================================================================
	// Helpers
	// ============================================================================

	private rowToMemory(row: MemoryRow): Memory {
		return {
			id: row.id,
			type: row.type as MemoryType,
			content: row.content,
			gist: row.gist,
			createdAt: row.created_at,
			lastAccessed: row.last_accessed,
			accessCount: row.access_count,
			emotionalWeight: row.emotional_weight,
			projectId: row.project_id,
			tags: safeJsonParse<string[]>(row.tags, []),
		}
	}

	private rowToProject(row: ProjectRow): Project {
		return {
			id: row.id,
			path: row.path,
			name: row.name,
			lastActive: row.last_active,
			context: safeJsonParse<Record<string, unknown>>(row.context, {}),
		}
	}
}

// Internal row types
interface MemoryRow {
	id: string
	type: string
	content: string
	gist: string | null
	created_at: number
	last_accessed: number | null
	access_count: number
	emotional_weight: number
	project_id: string | null
	tags: string
}

interface AssociationRow {
	source_id: string
	target_id: string
	strength: number
	type: string
}

interface ProjectRow {
	id: string
	path: string
	name: string | null
	last_active: number
	context: string
}

interface LocationIntuitionRow {
	id: string
	project_id: string
	path: string
	description: string | null
	purpose: string | null
	familiarity: number
	access_count: number
	searches_saved: number
	last_accessed: string | null
	created_at: string
	updated_at: string
	context_limit: number
	pinned: number
}

interface LocationAccessContextRow {
	id: string
	location_id: string
	context_description: string
	was_direct_access: number
	task_context: string | null
	activity_type: string
	activity_source: string
	is_summary: number
	accessed_at: string
}

interface VisualMemoryRow {
	id: string
	description: string
	original_path: string | null
	media_type: string
	objects: string
	emotional_valence: number
	emotional_arousal: number
	significance: number
	shared_by: string | null
	source: string
	received_at: number
	last_accessed: number | null
	access_count: number
	created_at: number
	project_id: string | null
}
