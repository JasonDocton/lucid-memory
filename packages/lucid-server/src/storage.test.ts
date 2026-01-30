/**
 * Storage Layer Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LucidStorage } from "./storage";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DB = join(tmpdir(), `lucid-test-${Date.now()}.db`);

describe("LucidStorage", () => {
  let storage: LucidStorage;

  beforeEach(() => {
    storage = new LucidStorage({ dbPath: TEST_DB });
  });

  afterEach(() => {
    storage.close();
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
    if (existsSync(`${TEST_DB}-wal`)) {
      unlinkSync(`${TEST_DB}-wal`);
    }
    if (existsSync(`${TEST_DB}-shm`)) {
      unlinkSync(`${TEST_DB}-shm`);
    }
  });

  describe("memories", () => {
    it("stores and retrieves a memory", () => {
      const memory = storage.storeMemory({
        content: "Test memory content",
        type: "learning",
        tags: ["test", "example"]
      });

      expect(memory.id).toBeDefined();
      expect(memory.content).toBe("Test memory content");
      expect(memory.type).toBe("learning");
      expect(memory.tags).toEqual(["test", "example"]);
      expect(memory.accessCount).toBe(1); // Initial access

      const retrieved = storage.getMemory(memory.id);
      expect(retrieved).toEqual(memory);
    });

    it("updates a memory", () => {
      const memory = storage.storeMemory({ content: "Original content" });

      const updated = storage.updateMemory(memory.id, {
        content: "Updated content",
        emotionalWeight: 0.9
      });

      expect(updated?.content).toBe("Updated content");
      expect(updated?.emotionalWeight).toBe(0.9);
    });

    it("deletes a memory", () => {
      const memory = storage.storeMemory({ content: "To be deleted" });
      expect(storage.getMemory(memory.id)).not.toBeNull();

      const deleted = storage.deleteMemory(memory.id);
      expect(deleted).toBe(true);
      expect(storage.getMemory(memory.id)).toBeNull();
    });

    it("tracks access history", () => {
      const memory = storage.storeMemory({ content: "Track me" });

      // Initial access was recorded
      let history = storage.getAccessHistory(memory.id);
      expect(history.length).toBe(1);

      // Record more accesses
      storage.recordAccess(memory.id);
      storage.recordAccess(memory.id);

      history = storage.getAccessHistory(memory.id);
      expect(history.length).toBe(3);

      // Check memory access count
      const retrieved = storage.getMemory(memory.id);
      expect(retrieved?.accessCount).toBe(3);
    });

    it("queries memories with filters", () => {
      storage.storeMemory({ content: "Bug 1", type: "bug" });
      storage.storeMemory({ content: "Bug 2", type: "bug" });
      storage.storeMemory({ content: "Solution 1", type: "solution" });

      const bugs = storage.queryMemories({ type: "bug" });
      expect(bugs.length).toBe(2);
      expect(bugs.every(m => m.type === "bug")).toBe(true);

      const solutions = storage.queryMemories({ type: "solution" });
      expect(solutions.length).toBe(1);
    });

    it("limits query results", () => {
      for (let i = 0; i < 20; i++) {
        storage.storeMemory({ content: `Memory ${i}` });
      }

      const limited = storage.queryMemories({ limit: 5 });
      expect(limited.length).toBe(5);
    });
  });

  describe("embeddings", () => {
    it("stores and retrieves an embedding", () => {
      const memory = storage.storeMemory({ content: "Has embedding" });
      const vector = [0.1, 0.2, 0.3, 0.4, 0.5];

      storage.storeEmbedding(memory.id, vector, "test-model");

      const retrieved = storage.getEmbedding(memory.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.length).toBe(5);

      // Check values are close (floating point)
      for (let i = 0; i < vector.length; i++) {
        expect(Math.abs(retrieved![i] - vector[i])).toBeLessThan(0.0001);
      }
    });

    it("finds memories without embeddings", () => {
      const m1 = storage.storeMemory({ content: "With embedding" });
      const m2 = storage.storeMemory({ content: "Without embedding" });

      storage.storeEmbedding(m1.id, [0.1, 0.2, 0.3], "test");

      const pending = storage.getMemoriesWithoutEmbeddings();
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(m2.id);
    });

    it("gets all embeddings as a map", () => {
      const m1 = storage.storeMemory({ content: "Memory 1" });
      const m2 = storage.storeMemory({ content: "Memory 2" });

      storage.storeEmbedding(m1.id, [0.1, 0.2], "test");
      storage.storeEmbedding(m2.id, [0.3, 0.4], "test");

      const embeddings = storage.getAllEmbeddings();
      expect(embeddings.size).toBe(2);
      expect(embeddings.has(m1.id)).toBe(true);
      expect(embeddings.has(m2.id)).toBe(true);
    });
  });

  describe("associations", () => {
    it("creates and retrieves associations", () => {
      const m1 = storage.storeMemory({ content: "Memory 1" });
      const m2 = storage.storeMemory({ content: "Memory 2" });

      storage.associate(m1.id, m2.id, 0.8, "semantic");

      const assocs1 = storage.getAssociations(m1.id);
      expect(assocs1.length).toBe(1);
      expect(assocs1[0].targetId).toBe(m2.id);
      expect(assocs1[0].strength).toBe(0.8);

      // Association is bidirectional in retrieval
      const assocs2 = storage.getAssociations(m2.id);
      expect(assocs2.length).toBe(1);
    });

    it("updates association strength", () => {
      const m1 = storage.storeMemory({ content: "Memory 1" });
      const m2 = storage.storeMemory({ content: "Memory 2" });

      storage.associate(m1.id, m2.id, 0.5);
      storage.associate(m1.id, m2.id, 0.9); // Update

      const assocs = storage.getAssociations(m1.id);
      expect(assocs[0].strength).toBe(0.9);
    });

    it("removes associations", () => {
      const m1 = storage.storeMemory({ content: "Memory 1" });
      const m2 = storage.storeMemory({ content: "Memory 2" });

      storage.associate(m1.id, m2.id, 0.5);
      expect(storage.getAssociations(m1.id).length).toBe(1);

      storage.dissociate(m1.id, m2.id);
      expect(storage.getAssociations(m1.id).length).toBe(0);
    });

    it("cascades deletion to associations", () => {
      const m1 = storage.storeMemory({ content: "Memory 1" });
      const m2 = storage.storeMemory({ content: "Memory 2" });

      storage.associate(m1.id, m2.id, 0.5);

      // Delete memory should cascade to associations
      storage.deleteMemory(m1.id);
      expect(storage.getAssociations(m2.id).length).toBe(0);
    });
  });

  describe("projects", () => {
    it("creates and retrieves projects", () => {
      const project = storage.getOrCreateProject("/path/to/project", "My Project");

      expect(project.id).toBeDefined();
      expect(project.path).toBe("/path/to/project");
      expect(project.name).toBe("My Project");

      // Getting same path returns same project
      const same = storage.getOrCreateProject("/path/to/project");
      expect(same.id).toBe(project.id);
    });

    it("filters memories by project", () => {
      const project = storage.getOrCreateProject("/project");

      storage.storeMemory({ content: "In project", projectId: project.id });
      storage.storeMemory({ content: "Not in project" });

      const inProject = storage.queryMemories({ projectId: project.id });
      expect(inProject.length).toBe(1);
      expect(inProject[0].content).toBe("In project");
    });
  });

  describe("maintenance", () => {
    it("prunes old memories", () => {
      for (let i = 0; i < 10; i++) {
        storage.storeMemory({ content: `Memory ${i}` });
      }

      const pruned = storage.pruneOldMemories(5);
      expect(pruned).toBe(5);

      const remaining = storage.queryMemories({});
      expect(remaining.length).toBe(5);
    });

    it("reports stats", () => {
      storage.storeMemory({ content: "Test" });
      const stats = storage.getStats();

      expect(stats.memoryCount).toBe(1);
      expect(stats.dbSizeBytes).toBeGreaterThan(0);
    });
  });
});
