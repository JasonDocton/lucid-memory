/**
 * Lucid Memory Storage Layer
 *
 * SQLite-based persistent storage for memories, embeddings, and associations.
 * This is the foundation layer - it handles persistence, not retrieval ranking.
 *
 * Uses Bun's built-in SQLite for zero-dependency speed.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// Types
export type MemoryType = "learning" | "decision" | "context" | "bug" | "solution" | "conversation";

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  gist: string | null;
  createdAt: number;
  lastAccessed: number | null;
  accessCount: number;
  emotionalWeight: number;
  projectId: string | null;
  tags: string[];
}

export interface MemoryInput {
  type?: MemoryType;
  content: string;
  gist?: string;
  emotionalWeight?: number;
  projectId?: string;
  tags?: string[];
}

export interface Association {
  sourceId: string;
  targetId: string;
  strength: number;
  type: "semantic" | "temporal" | "causal";
}

export interface Project {
  id: string;
  path: string;
  name: string | null;
  lastActive: number;
  context: Record<string, unknown>;
}

export interface StorageConfig {
  dbPath?: string;
  embeddingDim?: number;
}

/**
 * Storage layer for Lucid Memory.
 * Handles all persistence operations for memories, embeddings, and associations.
 */
export class LucidStorage {
  private db: Database;
  private embeddingDim: number;

  constructor(config: StorageConfig = {}) {
    const defaultPath = join(homedir(), ".lucid", "memory.db");
    const dbPath = config.dbPath ?? defaultPath;
    this.embeddingDim = config.embeddingDim ?? 768; // nomic-embed-text default

    // Ensure directory exists
    const dir = join(dbPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.initSchema();
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
    `);
  }

  // ============================================================================
  // Memories
  // ============================================================================

  /**
   * Store a new memory.
   */
  storeMemory(input: MemoryInput): Memory {
    const id = randomUUID();
    const now = Date.now();
    const tags = JSON.stringify(input.tags ?? []);

    this.db.prepare(`
      INSERT INTO memories (id, type, content, gist, created_at, emotional_weight, project_id, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.type ?? "learning",
      input.content,
      input.gist ?? null,
      now,
      input.emotionalWeight ?? 0.5,
      input.projectId ?? null,
      tags
    );

    // Record initial access
    this.recordAccess(id);

    return this.getMemory(id)!;
  }

  /**
   * Get a memory by ID.
   */
  getMemory(id: string): Memory | null {
    const row = this.db.prepare(`
      SELECT * FROM memories WHERE id = ?
    `).get(id) as MemoryRow | null;

    return row ? this.rowToMemory(row) : null;
  }

  /**
   * Update a memory's content or metadata.
   */
  updateMemory(id: string, updates: Partial<MemoryInput>): Memory | null {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) {
      sets.push("content = ?");
      values.push(updates.content);
    }
    if (updates.gist !== undefined) {
      sets.push("gist = ?");
      values.push(updates.gist);
    }
    if (updates.emotionalWeight !== undefined) {
      sets.push("emotional_weight = ?");
      values.push(updates.emotionalWeight);
    }
    if (updates.tags !== undefined) {
      sets.push("tags = ?");
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.type !== undefined) {
      sets.push("type = ?");
      values.push(updates.type);
    }

    if (sets.length === 0) return this.getMemory(id);

    values.push(id);
    this.db.prepare(`
      UPDATE memories SET ${sets.join(", ")} WHERE id = ?
    `).run(...values);

    return this.getMemory(id);
  }

  /**
   * Delete a memory and all its associations.
   */
  deleteMemory(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /**
   * Record an access event for a memory (updates recency/frequency).
   */
  recordAccess(memoryId: string): void {
    const now = Date.now();

    this.db.prepare(`
      UPDATE memories SET last_accessed = ?, access_count = access_count + 1
      WHERE id = ?
    `).run(now, memoryId);

    this.db.prepare(`
      INSERT INTO access_history (memory_id, accessed_at) VALUES (?, ?)
    `).run(memoryId, now);
  }

  /**
   * Get access history for a memory (for base-level activation).
   */
  getAccessHistory(memoryId: string): number[] {
    const rows = this.db.prepare(`
      SELECT accessed_at FROM access_history WHERE memory_id = ? ORDER BY accessed_at DESC
    `).all(memoryId) as { accessed_at: number }[];

    return rows.map(r => r.accessed_at);
  }

  /**
   * Query memories with filters.
   */
  queryMemories(options: {
    projectId?: string;
    type?: MemoryType;
    limit?: number;
    offset?: number;
    minAccessCount?: number;
  } = {}): Memory[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options.projectId) {
      conditions.push("project_id = ?");
      values.push(options.projectId);
    }
    if (options.type) {
      conditions.push("type = ?");
      values.push(options.type);
    }
    if (options.minAccessCount !== undefined) {
      conditions.push("access_count >= ?");
      values.push(options.minAccessCount);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const rows = this.db.prepare(`
      SELECT * FROM memories ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as MemoryRow[];

    return rows.map(r => this.rowToMemory(r));
  }

  /**
   * Get all memories for retrieval (includes metadata needed for ranking).
   */
  getAllForRetrieval(projectId?: string): {
    memories: Memory[];
    accessHistories: number[][];
    emotionalWeights: number[];
  } {
    const condition = projectId ? "WHERE project_id = ?" : "";
    const values = projectId ? [projectId] : [];

    const rows = this.db.prepare(`
      SELECT * FROM memories ${condition} ORDER BY created_at DESC
    `).all(...values) as MemoryRow[];

    const memories = rows.map(r => this.rowToMemory(r));
    const accessHistories = memories.map(m => this.getAccessHistory(m.id));
    const emotionalWeights = memories.map(m => m.emotionalWeight);

    return { memories, accessHistories, emotionalWeights };
  }

  // ============================================================================
  // Embeddings
  // ============================================================================

  /**
   * Store an embedding for a memory.
   */
  storeEmbedding(memoryId: string, vector: number[], model: string): void {
    const blob = new Uint8Array(new Float32Array(vector).buffer);

    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (memory_id, vector, model) VALUES (?, ?, ?)
    `).run(memoryId, blob, model);
  }

  /**
   * Get embedding for a memory.
   */
  getEmbedding(memoryId: string): number[] | null {
    const row = this.db.prepare(`
      SELECT vector FROM embeddings WHERE memory_id = ?
    `).get(memoryId) as { vector: Uint8Array } | null;

    if (!row) return null;

    return Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4));
  }

  /**
   * Get all embeddings (for batch similarity operations).
   */
  getAllEmbeddings(): Map<string, number[]> {
    const rows = this.db.prepare(`
      SELECT memory_id, vector FROM embeddings
    `).all() as { memory_id: string; vector: Uint8Array }[];

    const map = new Map<string, number[]>();
    for (const row of rows) {
      const vector = Array.from(
        new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4)
      );
      map.set(row.memory_id, vector);
    }
    return map;
  }

  /**
   * Check if memory has an embedding.
   */
  hasEmbedding(memoryId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM embeddings WHERE memory_id = ?
    `).get(memoryId);
    return !!row;
  }

  /**
   * Get memories missing embeddings.
   */
  getMemoriesWithoutEmbeddings(limit = 100): Memory[] {
    const rows = this.db.prepare(`
      SELECT m.* FROM memories m
      LEFT JOIN embeddings e ON m.id = e.memory_id
      WHERE e.memory_id IS NULL
      LIMIT ?
    `).all(limit) as MemoryRow[];

    return rows.map(r => this.rowToMemory(r));
  }

  // ============================================================================
  // Associations
  // ============================================================================

  /**
   * Create or update an association between two memories.
   */
  associate(sourceId: string, targetId: string, strength: number, type: Association["type"] = "semantic"): void {
    this.db.prepare(`
      INSERT INTO associations (source_id, target_id, strength, type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (source_id, target_id) DO UPDATE SET strength = ?, type = ?
    `).run(sourceId, targetId, strength, type, strength, type);
  }

  /**
   * Get associations for a memory.
   */
  getAssociations(memoryId: string): Association[] {
    const rows = this.db.prepare(`
      SELECT * FROM associations WHERE source_id = ? OR target_id = ?
    `).all(memoryId, memoryId) as AssociationRow[];

    return rows.map(r => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      strength: r.strength,
      type: r.type as Association["type"]
    }));
  }

  /**
   * Get all associations (for spreading activation).
   */
  getAllAssociations(): Association[] {
    const rows = this.db.prepare(`SELECT * FROM associations`).all() as AssociationRow[];

    return rows.map(r => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      strength: r.strength,
      type: r.type as Association["type"]
    }));
  }

  /**
   * Remove an association.
   */
  dissociate(sourceId: string, targetId: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM associations WHERE source_id = ? AND target_id = ?
    `).run(sourceId, targetId);
    return result.changes > 0;
  }

  // ============================================================================
  // Projects
  // ============================================================================

  /**
   * Get or create a project by path.
   */
  getOrCreateProject(path: string, name?: string): Project {
    const existing = this.db.prepare(`SELECT * FROM projects WHERE path = ?`).get(path) as ProjectRow | null;

    if (existing) {
      // Update last active
      this.db.prepare(`UPDATE projects SET last_active = ? WHERE id = ?`).run(Date.now(), existing.id);
      return this.rowToProject(existing);
    }

    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO projects (id, path, name, last_active, context) VALUES (?, ?, ?, ?, '{}')
    `).run(id, path, name ?? null, now);

    return { id, path, name: name ?? null, lastActive: now, context: {} };
  }

  /**
   * Update project context.
   */
  updateProjectContext(projectId: string, context: Record<string, unknown>): void {
    this.db.prepare(`
      UPDATE projects SET context = ?, last_active = ? WHERE id = ?
    `).run(JSON.stringify(context), Date.now(), projectId);
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  /**
   * Prune old memories beyond the limit.
   */
  pruneOldMemories(maxCount: number): number {
    const countResult = this.db.prepare(`SELECT COUNT(*) as count FROM memories`).get() as { count: number };

    if (countResult.count <= maxCount) return 0;

    const toDelete = countResult.count - maxCount;

    // First, get the IDs to delete (bun:sqlite handles this better in two steps)
    const idsToDelete = this.db.prepare(`
      SELECT id FROM memories
      ORDER BY
        COALESCE(last_accessed, created_at) ASC,
        access_count ASC
      LIMIT ?
    `).all(toDelete) as { id: string }[];

    if (idsToDelete.length === 0) return 0;

    // Delete using placeholders for each ID
    const placeholders = idsToDelete.map(() => "?").join(",");
    const ids = idsToDelete.map(r => r.id);

    this.db.prepare(`
      DELETE FROM memories WHERE id IN (${placeholders})
    `).run(...ids);

    // Return the number of memories we deleted (not cascade changes)
    return idsToDelete.length;
  }

  /**
   * Get storage statistics.
   */
  getStats(): {
    memoryCount: number;
    embeddingCount: number;
    associationCount: number;
    projectCount: number;
    dbSizeBytes: number;
  } {
    const memoryCount = (this.db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as { c: number }).c;
    const embeddingCount = (this.db.prepare(`SELECT COUNT(*) as c FROM embeddings`).get() as { c: number }).c;
    const associationCount = (this.db.prepare(`SELECT COUNT(*) as c FROM associations`).get() as { c: number }).c;
    const projectCount = (this.db.prepare(`SELECT COUNT(*) as c FROM projects`).get() as { c: number }).c;
    const dbSizeBytes = (this.db.prepare(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`).get() as { size: number }).size;

    return { memoryCount, embeddingCount, associationCount, projectCount, dbSizeBytes };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
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
      tags: JSON.parse(row.tags || "[]")
    };
  }

  private rowToProject(row: ProjectRow): Project {
    return {
      id: row.id,
      path: row.path,
      name: row.name,
      lastActive: row.last_active,
      context: JSON.parse(row.context || "{}")
    };
  }
}

// Internal row types
interface MemoryRow {
  id: string;
  type: string;
  content: string;
  gist: string | null;
  created_at: number;
  last_accessed: number | null;
  access_count: number;
  emotional_weight: number;
  project_id: string | null;
  tags: string;
}

interface AssociationRow {
  source_id: string;
  target_id: string;
  strength: number;
  type: string;
}

interface ProjectRow {
  id: string;
  path: string;
  name: string | null;
  last_active: number;
  context: string;
}
