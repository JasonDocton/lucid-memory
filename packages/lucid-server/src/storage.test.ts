/**
 * Storage Layer Tests
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LucidStorage } from "./storage.ts"

const testDbPath = join(tmpdir(), `lucid-test-${Date.now()}.db`)

describe("LucidStorage", () => {
	let storage: LucidStorage

	beforeEach(() => {
		storage = new LucidStorage({ dbPath: testDbPath })
	})

	afterEach(() => {
		storage.close()
		if (existsSync(testDbPath)) {
			unlinkSync(testDbPath)
		}
		if (existsSync(`${testDbPath}-wal`)) {
			unlinkSync(`${testDbPath}-wal`)
		}
		if (existsSync(`${testDbPath}-shm`)) {
			unlinkSync(`${testDbPath}-shm`)
		}
	})

	describe("memories", () => {
		it("stores and retrieves a memory", () => {
			const memory = storage.storeMemory({
				content: "Test memory content",
				type: "learning",
				tags: ["test", "example"],
			})

			expect(memory.id).toBeDefined()
			expect(memory.content).toBe("Test memory content")
			expect(memory.type).toBe("learning")
			expect(memory.tags).toEqual(["test", "example"])
			expect(memory.accessCount).toBe(1) // Initial access

			const retrieved = storage.getMemory(memory.id)
			expect(retrieved).toEqual(memory)
		})

		it("updates a memory", () => {
			const memory = storage.storeMemory({ content: "Original content" })

			const updated = storage.updateMemory(memory.id, {
				content: "Updated content",
				emotionalWeight: 0.9,
			})

			expect(updated?.content).toBe("Updated content")
			expect(updated?.emotionalWeight).toBe(0.9)
		})

		it("deletes a memory", () => {
			const memory = storage.storeMemory({ content: "To be deleted" })
			expect(storage.getMemory(memory.id)).not.toBeNull()

			const deleted = storage.deleteMemory(memory.id)
			expect(deleted).toBe(true)
			expect(storage.getMemory(memory.id)).toBeNull()
		})

		it("tracks access history", () => {
			const memory = storage.storeMemory({ content: "Track me" })

			// Initial access was recorded
			let history = storage.getAccessHistory(memory.id)
			expect(history.length).toBe(1)

			// Record more accesses
			storage.recordAccess(memory.id)
			storage.recordAccess(memory.id)

			history = storage.getAccessHistory(memory.id)
			expect(history.length).toBe(3)

			// Check memory access count
			const retrieved = storage.getMemory(memory.id)
			expect(retrieved?.accessCount).toBe(3)
		})

		it("queries memories with filters", () => {
			storage.storeMemory({ content: "Bug 1", type: "bug" })
			storage.storeMemory({ content: "Bug 2", type: "bug" })
			storage.storeMemory({ content: "Solution 1", type: "solution" })

			const bugs = storage.queryMemories({ type: "bug" })
			expect(bugs.length).toBe(2)
			expect(bugs.every((m) => m.type === "bug")).toBe(true)

			const solutions = storage.queryMemories({ type: "solution" })
			expect(solutions.length).toBe(1)
		})

		it("limits query results", () => {
			for (let i = 0; i < 20; i++) {
				storage.storeMemory({ content: `Memory ${i}` })
			}

			const limited = storage.queryMemories({ limit: 5 })
			expect(limited.length).toBe(5)
		})
	})

	describe("embeddings", () => {
		it("stores and retrieves an embedding", () => {
			const memory = storage.storeMemory({ content: "Has embedding" })
			const vector = [0.1, 0.2, 0.3, 0.4, 0.5]

			storage.storeEmbedding(memory.id, vector, "test-model")

			const retrieved = storage.getEmbedding(memory.id)
			expect(retrieved).toBeDefined()
			expect(retrieved?.length).toBe(5)

			// Check values are close (floating point)
			for (let i = 0; i < vector.length; i++) {
				// biome-ignore lint/style/noNonNullAssertion: validated above with toBeDefined()
				expect(Math.abs(retrieved![i]! - vector[i]!)).toBeLessThan(0.0001)
			}
		})

		it("finds memories without embeddings", () => {
			const m1 = storage.storeMemory({ content: "With embedding" })
			const m2 = storage.storeMemory({ content: "Without embedding" })

			storage.storeEmbedding(m1.id, [0.1, 0.2, 0.3], "test")

			const pending = storage.getMemoriesWithoutEmbeddings()
			expect(pending.length).toBe(1)
			expect(pending[0]?.id).toBe(m2.id)
		})

		it("gets all embeddings as a map", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })

			storage.storeEmbedding(m1.id, [0.1, 0.2], "test")
			storage.storeEmbedding(m2.id, [0.3, 0.4], "test")

			const embeddings = storage.getAllEmbeddings()
			expect(embeddings.size).toBe(2)
			expect(embeddings.has(m1.id)).toBe(true)
			expect(embeddings.has(m2.id)).toBe(true)
		})
	})

	describe("associations", () => {
		it("creates and retrieves associations", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })

			storage.associate(m1.id, m2.id, 0.8, "semantic")

			const assocs1 = storage.getAssociations(m1.id)
			expect(assocs1.length).toBe(1)
			expect(assocs1[0]?.targetId).toBe(m2.id)
			expect(assocs1[0]?.strength).toBe(0.8)

			// Association is bidirectional in retrieval
			const assocs2 = storage.getAssociations(m2.id)
			expect(assocs2.length).toBe(1)
		})

		it("updates association strength", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })

			storage.associate(m1.id, m2.id, 0.5)
			storage.associate(m1.id, m2.id, 0.9) // Update

			const assocs = storage.getAssociations(m1.id)
			expect(assocs[0]?.strength).toBe(0.9)
		})

		it("removes associations", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })

			storage.associate(m1.id, m2.id, 0.5)
			expect(storage.getAssociations(m1.id).length).toBe(1)

			storage.dissociate(m1.id, m2.id)
			expect(storage.getAssociations(m1.id).length).toBe(0)
		})

		it("cascades deletion to associations", () => {
			const m1 = storage.storeMemory({ content: "Memory 1" })
			const m2 = storage.storeMemory({ content: "Memory 2" })

			storage.associate(m1.id, m2.id, 0.5)

			// Delete memory should cascade to associations
			storage.deleteMemory(m1.id)
			expect(storage.getAssociations(m2.id).length).toBe(0)
		})
	})

	describe("projects", () => {
		it("creates and retrieves projects", () => {
			const project = storage.getOrCreateProject(
				"/path/to/project",
				"My Project"
			)

			expect(project.id).toBeDefined()
			expect(project.path).toBe("/path/to/project")
			expect(project.name).toBe("My Project")

			// Getting same path returns same project
			const same = storage.getOrCreateProject("/path/to/project")
			expect(same.id).toBe(project.id)
		})

		it("filters memories by project", () => {
			const project = storage.getOrCreateProject("/project")

			storage.storeMemory({ content: "In project", projectId: project.id })
			storage.storeMemory({ content: "Not in project" })

			const inProject = storage.queryMemories({ projectId: project.id })
			expect(inProject.length).toBe(1)
			expect(inProject[0]?.content).toBe("In project")
		})
	})

	describe("maintenance", () => {
		it("prunes old memories", () => {
			for (let i = 0; i < 10; i++) {
				storage.storeMemory({ content: `Memory ${i}` })
			}

			const pruned = storage.pruneOldMemories(5)
			expect(pruned).toBe(5)

			const remaining = storage.queryMemories({})
			expect(remaining.length).toBe(5)
		})

		it("reports stats", () => {
			storage.storeMemory({ content: "Test" })
			const stats = storage.getStats()

			expect(stats.memoryCount).toBe(1)
			expect(stats.dbSizeBytes).toBeGreaterThan(0)
		})
	})

	describe("location intuitions", () => {
		it("records file access and builds familiarity", () => {
			const loc1 = storage.recordFileAccess({
				path: "/src/index.ts",
				context: "Reading the main entry point",
				wasDirectAccess: true,
			})

			expect(loc1.id).toBeDefined()
			expect(loc1.path).toBe("/src/index.ts")
			expect(loc1.accessCount).toBe(1)
			expect(loc1.familiarity).toBeCloseTo(0.091, 2)
			expect(loc1.searchesSaved).toBe(1) // Direct access

			// Second access increases familiarity
			const loc2 = storage.recordFileAccess({
				path: "/src/index.ts",
				context: "Editing the exports",
				wasDirectAccess: false,
			})

			expect(loc2.id).toBe(loc1.id) // Same location
			expect(loc2.accessCount).toBe(2)
			expect(loc2.familiarity).toBeGreaterThan(loc1.familiarity)
			expect(loc2.searchesSaved).toBe(1) // No increase - searched this time
		})

		it("retrieves location by path", () => {
			storage.recordFileAccess({
				path: "/src/utils.ts",
				context: "Working on utilities",
				wasDirectAccess: true,
			})

			const found = storage.getLocationByPath("/src/utils.ts")
			expect(found).not.toBeNull()
			expect(found?.path).toBe("/src/utils.ts")

			const notFound = storage.getLocationByPath("/nonexistent.ts")
			expect(notFound).toBeNull()
		})

		it("scopes locations by project", () => {
			const project = storage.getOrCreateProject("/project-a")

			storage.recordFileAccess({
				path: "/src/index.ts",
				context: "In project A",
				wasDirectAccess: true,
				projectId: project.id,
			})

			storage.recordFileAccess({
				path: "/src/index.ts",
				context: "Global location",
				wasDirectAccess: true,
			})

			// Same path, different projects = different locations
			const inProject = storage.getLocationByPath("/src/index.ts", project.id)
			const global = storage.getLocationByPath("/src/index.ts")

			expect(inProject?.id).not.toBe(global?.id)
		})

		it("checks if location is well-known", () => {
			// Access multiple times to build familiarity
			// f(n) = 1 - 1/(1 + 0.1n), need n >= 24 for f >= 0.7
			for (let i = 0; i < 30; i++) {
				storage.recordFileAccess({
					path: "/src/frequent.ts",
					context: `Access ${i}`,
					wasDirectAccess: true,
				})
			}

			const loc = storage.getLocationByPath("/src/frequent.ts")
			expect(loc?.familiarity).toBeGreaterThanOrEqual(0.7)
			expect(storage.isLocationWellKnown("/src/frequent.ts")).toBe(true)
			expect(storage.isLocationWellKnown("/src/unknown.ts")).toBe(false)
		})

		it("gets access contexts for a location", () => {
			storage.recordFileAccess({
				path: "/src/file.ts",
				context: "First access - reading",
				wasDirectAccess: true,
				taskContext: "Understanding the codebase",
			})

			storage.recordFileAccess({
				path: "/src/file.ts",
				context: "Second access - debugging an issue",
				wasDirectAccess: false,
			})

			const withContexts = storage.getLocationWithContexts("/src/file.ts")
			expect(withContexts).not.toBeNull()
			expect(withContexts?.accessContexts.length).toBe(2)

			// Check both contexts are present (order may vary due to same-second timestamps)
			const descriptions =
				withContexts?.accessContexts.map((c) => c.contextDescription) || []
			expect(descriptions.some((d) => d.includes("debugging"))).toBe(true)
			expect(descriptions.some((d) => d.includes("reading"))).toBe(true)

			// Check task context was captured
			const withTask = withContexts?.accessContexts.find((c) => c.taskContext)
			expect(withTask?.taskContext).toBe("Understanding the codebase")
		})

		it("infers activity type from context", () => {
			storage.recordFileAccess({
				path: "/src/buggy.ts",
				context: "Debugging the authentication bug",
				wasDirectAccess: true,
			})

			const contexts = storage.getAccessContexts(
				// biome-ignore lint/style/noNonNullAssertion: just recorded above
				storage.getLocationByPath("/src/buggy.ts")!.id
			)

			expect(contexts[0]?.activityType).toBe("debugging")
			expect(contexts[0]?.activitySource).toBe("keyword")
		})

		it("respects explicit activity type", () => {
			storage.recordFileAccess({
				path: "/src/code.ts",
				context: "Some context",
				wasDirectAccess: true,
				activityType: "refactoring",
			})

			const contexts = storage.getAccessContexts(
				// biome-ignore lint/style/noNonNullAssertion: just recorded above
				storage.getLocationByPath("/src/code.ts")!.id
			)

			expect(contexts[0]?.activityType).toBe("refactoring")
			expect(contexts[0]?.activitySource).toBe("explicit")
		})

		it("gets location statistics", () => {
			for (let i = 0; i < 5; i++) {
				storage.recordFileAccess({
					path: `/src/file${i}.ts`,
					context: "Working",
					wasDirectAccess: true,
				})
			}

			// Access one file multiple times
			for (let i = 0; i < 15; i++) {
				storage.recordFileAccess({
					path: "/src/file0.ts",
					context: "Frequent access",
					wasDirectAccess: true,
				})
			}

			const stats = storage.getLocationStats()
			expect(stats.totalLocations).toBe(5)
			expect(stats.totalSearchesSaved).toBeGreaterThan(0)
			expect(stats.mostFamiliarPaths[0]).toBe("/src/file0.ts")
		})

		it("finds locations by pattern", () => {
			storage.recordFileAccess({
				path: "/src/utils/string.ts",
				context: "a",
				wasDirectAccess: true,
			})
			storage.recordFileAccess({
				path: "/src/utils/number.ts",
				context: "b",
				wasDirectAccess: true,
			})
			storage.recordFileAccess({
				path: "/src/index.ts",
				context: "c",
				wasDirectAccess: true,
			})

			const utils = storage.findLocations("utils")
			expect(utils.length).toBe(2)

			const string = storage.findLocations("string")
			expect(string.length).toBe(1)
			expect(string[0]?.path).toBe("/src/utils/string.ts")
		})

		it("pins and unpins locations", () => {
			storage.recordFileAccess({
				path: "/src/config.ts",
				context: "Config file",
				wasDirectAccess: true,
			})

			const success = storage.pinLocation("/src/config.ts", true)
			expect(success).toBe(true)

			const loc = storage.getLocationByPath("/src/config.ts")
			expect(loc?.isPinned).toBe(true)

			storage.pinLocation("/src/config.ts", false)
			const unpinned = storage.getLocationByPath("/src/config.ts")
			expect(unpinned?.isPinned).toBe(false)
		})

		it("merges locations on rename", () => {
			// Create old location with some history
			for (let i = 0; i < 5; i++) {
				storage.recordFileAccess({
					path: "/src/old-name.ts",
					context: `Access ${i}`,
					wasDirectAccess: true,
				})
			}

			// biome-ignore lint/style/noNonNullAssertion: just recorded above in loop
			const oldLoc = storage.getLocationByPath("/src/old-name.ts")!
			const oldFamiliarity = oldLoc.familiarity
			const oldAccessCount = oldLoc.accessCount

			// Merge to new name
			const merged = storage.mergeLocations(
				"/src/old-name.ts",
				"/src/new-name.ts"
			)

			expect(merged).not.toBeNull()
			expect(merged?.path).toBe("/src/new-name.ts")
			expect(merged?.familiarity).toBe(oldFamiliarity)
			expect(merged?.accessCount).toBe(oldAccessCount)

			// Old path should be gone
			expect(storage.getLocationByPath("/src/old-name.ts")).toBeNull()
		})

		it("includes location count in stats", () => {
			storage.recordFileAccess({
				path: "/a.ts",
				context: "a",
				wasDirectAccess: true,
			})
			storage.recordFileAccess({
				path: "/b.ts",
				context: "b",
				wasDirectAccess: true,
			})

			const stats = storage.getStats()
			expect(stats.locationCount).toBe(2)
		})

		it("builds co-access associations when files accessed together", () => {
			// Access files in quick succession (within 5 min window)
			storage.recordFileAccess({
				path: "/src/handler.ts",
				context: "reading",
				wasDirectAccess: true,
			})
			storage.recordFileAccess({
				path: "/src/types.ts",
				context: "reading",
				wasDirectAccess: true,
			})
			storage.recordFileAccess({
				path: "/src/utils.ts",
				context: "reading",
				wasDirectAccess: true,
			})

			// Check associations from handler.ts
			const associated = storage.getAssociatedLocationsByPath("/src/handler.ts")

			// Should have associations with both types.ts and utils.ts
			expect(associated.length).toBeGreaterThanOrEqual(1)
			const paths = associated.map((a) => a.path)
			expect(
				paths.some((p) => p.includes("types.ts") || p.includes("utils.ts"))
			).toBe(true)
		})

		it("strengthens associations with repeated co-access", () => {
			// Access the same pair of files multiple times
			for (let i = 0; i < 5; i++) {
				storage.recordFileAccess({
					path: "/src/api.ts",
					context: `access ${i}`,
					wasDirectAccess: true,
				})
				storage.recordFileAccess({
					path: "/src/routes.ts",
					context: `access ${i}`,
					wasDirectAccess: true,
				})
			}

			const associated = storage.getAssociatedLocationsByPath("/src/api.ts")
			const routesAssoc = associated.find((a) => a.path === "/src/routes.ts")

			expect(routesAssoc).toBeDefined()
			// After 5 co-accesses, strength should be higher than initial 0.091
			expect(routesAssoc?.associationStrength).toBeGreaterThan(0.3)
		})

		it("gets locations by activity type", () => {
			// Create locations with different activity types
			storage.recordFileAccess({
				path: "/src/bug.ts",
				context: "debugging the issue",
				wasDirectAccess: true,
				activityType: "debugging",
			})
			storage.recordFileAccess({
				path: "/src/feature.ts",
				context: "implementing new feature",
				wasDirectAccess: true,
				activityType: "writing",
			})
			storage.recordFileAccess({
				path: "/src/another-bug.ts",
				context: "fixing another bug",
				wasDirectAccess: true,
				activityType: "debugging",
			})

			const debuggingLocations = storage.getLocationsByActivity("debugging")

			expect(debuggingLocations.length).toBe(2)
			const paths = debuggingLocations.map((l) => l.path)
			expect(paths).toContain("/src/bug.ts")
			expect(paths).toContain("/src/another-bug.ts")
		})

		it("builds stronger associations for files with matching task context", () => {
			// Files accessed with same taskContext should have stronger associations
			// than files accessed close in time without task context

			// Task-based: same task, same activity (5x multiplier)
			storage.recordFileAccess({
				path: "/src/auth/login.ts",
				context: "implementing login",
				wasDirectAccess: true,
				taskContext: "implement-user-auth",
				activityType: "writing",
			})
			storage.recordFileAccess({
				path: "/src/auth/session.ts",
				context: "implementing session",
				wasDirectAccess: true,
				taskContext: "implement-user-auth",
				activityType: "writing",
			})

			// Time-based only: no task context (1x multiplier)
			storage.recordFileAccess({
				path: "/src/utils/random.ts",
				context: "reading utils",
				wasDirectAccess: true,
			})
			storage.recordFileAccess({
				path: "/src/utils/format.ts",
				context: "reading utils",
				wasDirectAccess: true,
			})

			const authAssociations =
				storage.getAssociatedLocationsByPath("/src/auth/login.ts")
			const utilsAssociations = storage.getAssociatedLocationsByPath(
				"/src/utils/random.ts"
			)

			const sessionAssoc = authAssociations.find(
				(a) => a.path === "/src/auth/session.ts"
			)
			const formatAssoc = utilsAssociations.find(
				(a) => a.path === "/src/utils/format.ts"
			)

			expect(sessionAssoc).toBeDefined()
			expect(formatAssoc).toBeDefined()

			// Task-based association should be stronger than time-based
			// With 5x multiplier: f(5) = 1 - 1/(1 + 0.5) ≈ 0.33
			// With 1x multiplier: f(1) = 1 - 1/(1 + 0.1) ≈ 0.09
			// biome-ignore lint/style/noNonNullAssertion: validated above with toBeDefined()
			expect(sessionAssoc!.associationStrength).toBeGreaterThan(
				// biome-ignore lint/style/noNonNullAssertion: validated above with toBeDefined()
				formatAssoc!.associationStrength
			)
		})

		it("builds strongest associations for same task + same activity", () => {
			// Same task + same activity type = strongest link (5x)
			storage.recordFileAccess({
				path: "/src/api/handler.ts",
				context: "debugging handler",
				wasDirectAccess: true,
				taskContext: "fix-api-bug",
				activityType: "debugging",
			})
			storage.recordFileAccess({
				path: "/src/api/middleware.ts",
				context: "debugging middleware",
				wasDirectAccess: true,
				taskContext: "fix-api-bug",
				activityType: "debugging",
			})

			// Same task + different activity type = strong but not strongest (3x)
			storage.recordFileAccess({
				path: "/src/api/types.ts",
				context: "reading types",
				wasDirectAccess: true,
				taskContext: "fix-api-bug",
				activityType: "reading",
			})

			const handlerAssocs = storage.getAssociatedLocationsByPath(
				"/src/api/handler.ts"
			)

			const middlewareAssoc = handlerAssocs.find(
				(a) => a.path === "/src/api/middleware.ts"
			)
			const typesAssoc = handlerAssocs.find(
				(a) => a.path === "/src/api/types.ts"
			)

			expect(middlewareAssoc).toBeDefined()
			expect(typesAssoc).toBeDefined()

			// Same activity (debugging+debugging) should be stronger than different (debugging+reading)
			// biome-ignore lint/style/noNonNullAssertion: validated above with toBeDefined()
			expect(middlewareAssoc!.associationStrength).toBeGreaterThan(
				// biome-ignore lint/style/noNonNullAssertion: validated above with toBeDefined()
				typesAssoc!.associationStrength
			)
		})
	})
})
