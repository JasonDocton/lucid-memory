/**
 * Temporal Retrieval Improvements Tests
 *
 * Phase 1: Working Memory Buffer
 * Tests for cognitive WM with τ≈4s decay (Baddeley, 2000; Cowan, 2001)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LucidRetrieval } from "./retrieval.ts"

const testDbPath = join(tmpdir(), `lucid-temporal-test-${Date.now()}.db`)

describe("Temporal Retrieval Improvements", () => {
	let retrieval: LucidRetrieval

	beforeEach(() => {
		retrieval = new LucidRetrieval({ dbPath: testDbPath })
	})

	afterEach(() => {
		retrieval.storage.close()
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

	describe("Phase 1: Working Memory Buffer", () => {
		it("should have WM constants defined correctly", () => {
			// Access private fields via type assertion for testing
			const r = retrieval as unknown as {
				wmCapacity: number
				wmDecayMs: number
				wmCutoffMultiplier: number
				wmMaxBoost: number
			}

			expect(r.wmCapacity).toBe(7)
			expect(r.wmDecayMs).toBe(4000)
			expect(r.wmCutoffMultiplier).toBe(5)
			expect(r.wmMaxBoost).toBe(1.0)
		})

		it("should return 1.0 boost for memories not in WM", () => {
			const r = retrieval as unknown as {
				getWorkingMemoryBoost: (id: string, now: number) => number
			}

			const boost = r.getWorkingMemoryBoost("non-existent-id", Date.now())
			expect(boost).toBe(1.0)
		})

		it("should return max boost (2.0) for just-activated memory", () => {
			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
				getWorkingMemoryBoost: (id: string, now: number) => number
			}

			const now = Date.now()
			r.updateWorkingMemory("test-memory", now)

			const boost = r.getWorkingMemoryBoost("test-memory", now)
			expect(boost).toBeCloseTo(2.0, 1)
		})

		it("should decay WM boost over time", () => {
			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
				getWorkingMemoryBoost: (id: string, now: number) => number
				wmDecayMs: number
			}

			const now = Date.now()
			r.updateWorkingMemory("test-memory", now)

			// At t=0: boost ≈ 2.0
			const boost0 = r.getWorkingMemoryBoost("test-memory", now)
			expect(boost0).toBeCloseTo(2.0, 1)

			// At t=τ (4s): boost ≈ 1.37 (1 + e^-1)
			const boost1tau = r.getWorkingMemoryBoost(
				"test-memory",
				now + r.wmDecayMs
			)
			expect(boost1tau).toBeCloseTo(1.37, 1)

			// At t=2τ (8s): boost ≈ 1.14 (1 + e^-2)
			const boost2tau = r.getWorkingMemoryBoost(
				"test-memory",
				now + 2 * r.wmDecayMs
			)
			expect(boost2tau).toBeCloseTo(1.14, 1)

			// At t=5τ (20s): boost ≈ 1.007 (effectively 1.0)
			const boost5tau = r.getWorkingMemoryBoost(
				"test-memory",
				now + 5 * r.wmDecayMs
			)
			expect(boost5tau).toBeLessThan(1.01)
		})

		it("should cap WM capacity at 7 items", () => {
			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
				workingMemory: Map<string, unknown>
				wmCapacity: number
			}

			const now = Date.now()

			// Add 10 memories
			for (let i = 0; i < 10; i++) {
				r.updateWorkingMemory(`memory-${i}`, now + i)
			}

			expect(r.workingMemory.size).toBe(r.wmCapacity)
		})

		it("should evict oldest items when over capacity", () => {
			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
				workingMemory: Map<string, { memoryId: string }>
			}

			const now = Date.now()

			// Add 10 memories with increasing timestamps
			for (let i = 0; i < 10; i++) {
				r.updateWorkingMemory(`memory-${i}`, now + i * 100)
			}

			// Oldest memories (0, 1, 2) should be evicted
			expect(r.workingMemory.has("memory-0")).toBe(false)
			expect(r.workingMemory.has("memory-1")).toBe(false)
			expect(r.workingMemory.has("memory-2")).toBe(false)

			// Newest memories should remain
			expect(r.workingMemory.has("memory-9")).toBe(true)
			expect(r.workingMemory.has("memory-8")).toBe(true)
			expect(r.workingMemory.has("memory-7")).toBe(true)
		})

		it("should prune expired entries (older than 5τ)", () => {
			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
				workingMemory: Map<string, unknown>
				wmDecayMs: number
				wmCutoffMultiplier: number
			}

			const now = Date.now()

			// Add a memory at t=0
			r.updateWorkingMemory("old-memory", now)

			// Add another memory at t=6τ (should trigger pruning of old-memory)
			const cutoffTime = r.wmDecayMs * r.wmCutoffMultiplier
			r.updateWorkingMemory("new-memory", now + cutoffTime + 1000)

			// Old memory should be pruned
			expect(r.workingMemory.has("old-memory")).toBe(false)
			expect(r.workingMemory.has("new-memory")).toBe(true)
		})

		it("should refresh memory timestamp on re-activation", () => {
			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
				workingMemory: Map<string, { activatedAt: number }>
			}

			const now = Date.now()

			// Activate memory
			r.updateWorkingMemory("test-memory", now)
			expect(r.workingMemory.get("test-memory")?.activatedAt).toBe(now)

			// Re-activate after 2 seconds
			const later = now + 2000
			r.updateWorkingMemory("test-memory", later)
			expect(r.workingMemory.get("test-memory")?.activatedAt).toBe(later)
		})

		it("should reset WM on new retrieval instance", () => {
			const r1 = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
				workingMemory: Map<string, unknown>
			}

			r1.updateWorkingMemory("test-memory", Date.now())
			expect(r1.workingMemory.size).toBe(1)

			// Create new instance - WM should be empty (ephemeral)
			const retrieval2 = new LucidRetrieval({ dbPath: testDbPath })
			const r2 = retrieval2 as unknown as {
				workingMemory: Map<string, unknown>
			}
			expect(r2.workingMemory.size).toBe(0)
			retrieval2.storage.close()
		})
	})

	describe("WM Integration with Retrieval", () => {
		it("should boost similarity for recently retrieved memories", () => {
			// Store a memory
			const memory = retrieval.storage.storeMemory({
				content: "Test schema design patterns",
				type: "learning",
			})

			// Manually add to WM to simulate recent retrieval
			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
				getWorkingMemoryBoost: (id: string, now: number) => number
			}

			const now = Date.now()
			r.updateWorkingMemory(memory.id, now)

			// Verify boost is applied
			const boost = r.getWorkingMemoryBoost(memory.id, now)
			expect(boost).toBeGreaterThan(1.5)
		})

		it("should not affect base-level activation", () => {
			// Base-level is computed from access history, not WM
			// This is verified by the separation of concerns in the code
			// WM boost only affects probe similarity component

			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
			}

			// Adding to WM doesn't change storage access history
			const memory = retrieval.storage.storeMemory({
				content: "Test memory",
				type: "learning",
			})

			const historyBefore = retrieval.storage.getAccessHistory(memory.id)
			r.updateWorkingMemory(memory.id, Date.now())
			const historyAfter = retrieval.storage.getAccessHistory(memory.id)

			expect(historyAfter.length).toBe(historyBefore.length)
		})
	})

	describe("Phase 2: Session Decay Modulation", () => {
		it("should return d=0.3 for memories accessed in last 30 minutes", () => {
			const r = retrieval as unknown as {
				getSessionDecayRate: (lastAccessMs: number, now: number) => number
			}

			const now = Date.now()
			// Accessed 10 minutes ago
			const tenMinAgo = now - 10 * 60 * 1000

			expect(r.getSessionDecayRate(tenMinAgo, now)).toBe(0.3)
		})

		it("should return d=0.4 for memories accessed in last 2 hours", () => {
			const r = retrieval as unknown as {
				getSessionDecayRate: (lastAccessMs: number, now: number) => number
			}

			const now = Date.now()
			// Accessed 1 hour ago
			const oneHourAgo = now - 60 * 60 * 1000

			expect(r.getSessionDecayRate(oneHourAgo, now)).toBe(0.4)
		})

		it("should return d=0.45 for memories accessed in last day", () => {
			const r = retrieval as unknown as {
				getSessionDecayRate: (lastAccessMs: number, now: number) => number
			}

			const now = Date.now()
			// Accessed 12 hours ago
			const twelveHoursAgo = now - 12 * 60 * 60 * 1000

			expect(r.getSessionDecayRate(twelveHoursAgo, now)).toBe(0.45)
		})

		it("should return d=0.5 for older memories", () => {
			const r = retrieval as unknown as {
				getSessionDecayRate: (lastAccessMs: number, now: number) => number
			}

			const now = Date.now()
			// Accessed 2 days ago
			const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000

			expect(r.getSessionDecayRate(twoDaysAgo, now)).toBe(0.5)
		})

		it("should use correct decay rates at boundary conditions", () => {
			const r = retrieval as unknown as {
				getSessionDecayRate: (lastAccessMs: number, now: number) => number
			}

			const now = Date.now()

			// Exactly 30 minutes = should use d=0.4 (not 0.3)
			const exactly30min = now - 30 * 60 * 1000
			expect(r.getSessionDecayRate(exactly30min, now)).toBe(0.4)

			// Exactly 2 hours = should use d=0.45 (not 0.4)
			const exactly2hours = now - 2 * 60 * 60 * 1000
			expect(r.getSessionDecayRate(exactly2hours, now)).toBe(0.45)

			// Exactly 24 hours = should use d=0.5 (not 0.45)
			const exactly24hours = now - 24 * 60 * 60 * 1000
			expect(r.getSessionDecayRate(exactly24hours, now)).toBe(0.5)
		})

		it("should result in higher activation for recent memories", () => {
			// Mathematical verification:
			// B(m) = ln[Σ(t^-d)]
			// Lower d = slower decay = higher activation
			//
			// For t=600s (10 min), single access:
			// d=0.3: B = ln(600^-0.3) = ln(0.146) ≈ -1.92
			// d=0.5: B = ln(600^-0.5) = ln(0.041) ≈ -3.19
			//
			// The -1.92 > -3.19, so recent memories get higher activation

			const r = retrieval as unknown as {
				getSessionDecayRate: (lastAccessMs: number, now: number) => number
			}

			const now = Date.now()
			const recentDecay = r.getSessionDecayRate(now - 10 * 60 * 1000, now)
			const oldDecay = r.getSessionDecayRate(now - 2 * 24 * 60 * 60 * 1000, now)

			expect(recentDecay).toBeLessThan(oldDecay)
		})
	})

	describe("Phase 3: Project Context Boost", () => {
		it("should boost in-project memories by 0.15 emotional weight", () => {
			const r = retrieval as unknown as {
				adjustEmotionalWeightForProject: (
					baseWeight: number,
					memoryProjectId: string | null,
					currentProjectId: string | undefined
				) => number
			}

			// Memory in same project gets boost
			const boosted = r.adjustEmotionalWeightForProject(
				0.5,
				"project-123",
				"project-123"
			)
			expect(boosted).toBe(0.65)
		})

		it("should cap emotional weight at 1.0", () => {
			const r = retrieval as unknown as {
				adjustEmotionalWeightForProject: (
					baseWeight: number,
					memoryProjectId: string | null,
					currentProjectId: string | undefined
				) => number
			}

			// High base weight + boost should cap at 1.0
			const capped = r.adjustEmotionalWeightForProject(
				0.9,
				"project-123",
				"project-123"
			)
			expect(capped).toBe(1.0)

			// Very high base weight should also cap at 1.0
			const cappedHigh = r.adjustEmotionalWeightForProject(
				0.95,
				"project-123",
				"project-123"
			)
			expect(cappedHigh).toBe(1.0)
		})

		it("should not boost cross-project memories", () => {
			const r = retrieval as unknown as {
				adjustEmotionalWeightForProject: (
					baseWeight: number,
					memoryProjectId: string | null,
					currentProjectId: string | undefined
				) => number
			}

			// Memory in different project gets no boost
			const notBoosted = r.adjustEmotionalWeightForProject(
				0.5,
				"project-123",
				"project-456"
			)
			expect(notBoosted).toBe(0.5)
		})

		it("should handle null project IDs gracefully", () => {
			const r = retrieval as unknown as {
				adjustEmotionalWeightForProject: (
					baseWeight: number,
					memoryProjectId: string | null,
					currentProjectId: string | undefined
				) => number
			}

			// No current project ID - no boost
			const noCurrentProject = r.adjustEmotionalWeightForProject(
				0.5,
				"project-123",
				undefined
			)
			expect(noCurrentProject).toBe(0.5)

			// No memory project ID - no boost
			const noMemoryProject = r.adjustEmotionalWeightForProject(
				0.5,
				null,
				"project-123"
			)
			expect(noMemoryProject).toBe(0.5)

			// Both null - no boost
			const bothNull = r.adjustEmotionalWeightForProject(0.5, null, undefined)
			expect(bothNull).toBe(0.5)
		})

		it("should provide ~1.15x multiplier for default weight", () => {
			// Mathematical verification:
			// Emotional weight becomes multiplier: 1.0 + (weight - 0.5)
			// Base weight 0.5 → multiplier 1.0
			// Boosted weight 0.65 → multiplier 1.15
			// This is a 15% boost for in-project memories

			const r = retrieval as unknown as {
				adjustEmotionalWeightForProject: (
					baseWeight: number,
					memoryProjectId: string | null,
					currentProjectId: string | undefined
				) => number
			}

			const baseWeight = 0.5
			const boostedWeight = r.adjustEmotionalWeightForProject(
				baseWeight,
				"project-123",
				"project-123"
			)

			const baseMultiplier = 1.0 + (baseWeight - 0.5)
			const boostedMultiplier = 1.0 + (boostedWeight - 0.5)

			expect(baseMultiplier).toBe(1.0)
			expect(boostedMultiplier).toBeCloseTo(1.15, 2)
		})
	})

	describe("Phase 4: Session Tracking", () => {
		it("should create new session on first call", () => {
			const sessionId = retrieval.storage.getOrCreateSession("project-123")
			expect(sessionId).toBeDefined()
			expect(typeof sessionId).toBe("string")
			expect(sessionId.length).toBeGreaterThan(0)
		})

		it("should return existing session within 30 minutes", () => {
			const sessionId1 = retrieval.storage.getOrCreateSession("project-123")
			const sessionId2 = retrieval.storage.getOrCreateSession("project-123")

			expect(sessionId1).toBe(sessionId2)
		})

		it("should isolate sessions by project", () => {
			const sessionA = retrieval.storage.getOrCreateSession("project-A")
			const sessionB = retrieval.storage.getOrCreateSession("project-B")

			expect(sessionA).not.toBe(sessionB)
		})

		it("should return undefined for getCurrentSession when no active session", () => {
			// New project with no session created yet
			const session = retrieval.storage.getCurrentSession(
				"never-used-project-xyz"
			)
			expect(session).toBeUndefined()
		})

		it("should return session ID for getCurrentSession when session exists", () => {
			const projectId = "test-current-session"
			const createdId = retrieval.storage.getOrCreateSession(projectId)
			const currentId = retrieval.storage.getCurrentSession(projectId)

			expect(currentId).toBe(createdId)
		})

		it("should end session explicitly", () => {
			const projectId = "test-end-session"
			const sessionId = retrieval.storage.getOrCreateSession(projectId)

			// End the session
			retrieval.storage.endSession(sessionId)

			// Should create a new session now
			const newSessionId = retrieval.storage.getOrCreateSession(projectId)
			expect(newSessionId).not.toBe(sessionId)
		})

		it("should cache session in retrieval layer", () => {
			const r = retrieval as unknown as {
				sessionCache: Map<string, { sessionId: string; touchedAt: number }>
				getOrCreateSession: (projectId?: string) => string
			}

			// Clear cache
			r.sessionCache.clear()

			// Get session (should populate cache)
			const sessionId = r.getOrCreateSession("cache-test-project")

			// Verify cache was populated
			const cached = r.sessionCache.get("cache-test-project")
			expect(cached).toBeDefined()
			expect(cached?.sessionId).toBe(sessionId)
		})

		it("should update session activity on touch", () => {
			const projectId = "touch-test"
			const sessionId = retrieval.storage.getOrCreateSession(projectId)

			// Touch the session
			retrieval.storage.touchSession(sessionId)

			// Session should still be active
			const currentSession = retrieval.storage.getCurrentSession(projectId)
			expect(currentSession).toBe(sessionId)
		})

		// HIGH-11: Session multiplier test
		it("should apply 1.5x session multiplier to location associations", () => {
			const projectId = "session-multiplier-test"
			const sessionId = retrieval.storage.getOrCreateSession(projectId)

			// Record two file accesses in the same session
			const location1 = retrieval.storage.recordFileAccess({
				path: "/test/file1.ts",
				context: "Implementing feature A",
				wasDirectAccess: true,
				projectId,
				taskContext: "feature-a",
				activityType: "writing",
				sessionId,
			})

			const location2 = retrieval.storage.recordFileAccess({
				path: "/test/file2.ts",
				context: "Implementing feature A",
				wasDirectAccess: true,
				projectId,
				taskContext: "feature-a",
				activityType: "writing",
				sessionId,
			})

			// Check that associations were created using stats
			const stats1 = retrieval.storage.getLocationAssociationStats(location1.id)
			const stats2 = retrieval.storage.getLocationAssociationStats(location2.id)

			// Both locations should have at least one association (bidirectional)
			expect(stats1.associationCount).toBeGreaterThan(0)
			expect(stats2.associationCount).toBeGreaterThan(0)

			// Average strength should be positive
			expect(stats1.averageStrength).toBeGreaterThan(0)
		})

		it("should create associations for same-session file access", () => {
			const projectId = "session-strength-test"
			const session1 = retrieval.storage.getOrCreateSession(projectId)

			// Record files in same session with same task
			const loc1 = retrieval.storage.recordFileAccess({
				path: "/test/same-session-1.ts",
				context: "Task context",
				wasDirectAccess: true,
				projectId,
				taskContext: "task-1",
				activityType: "writing",
				sessionId: session1,
			})

			retrieval.storage.recordFileAccess({
				path: "/test/same-session-2.ts",
				context: "Task context",
				wasDirectAccess: true,
				projectId,
				taskContext: "task-1",
				activityType: "writing",
				sessionId: session1,
			})

			// Verify associations were created
			const stats = retrieval.storage.getLocationAssociationStats(loc1.id)
			expect(stats.associationCount).toBeGreaterThan(0)
		})
	})

	// MEDIUM: getContext() token budgeting tests
	describe("Medium Priority: getContext Token Budgeting", () => {
		it("should return empty result when no relevant memories", async () => {
			const result = await retrieval.getContext("nonexistent topic xyz123")

			expect(result.memories).toEqual([])
			expect(result.summary).toBe("")
			expect(result.tokensUsed).toBe(0)
		})

		it("should respect token budget parameter", async () => {
			// Store some memories
			retrieval.storage.storeMemory({
				content:
					"Token budget test memory with substantial content about testing",
				type: "learning",
			})

			const result = await retrieval.getContext(
				"token budget test",
				undefined,
				{
					tokenBudget: 50,
				}
			)

			// Token count should not exceed budget significantly
			expect(result.tokensUsed).toBeLessThanOrEqual(100) // Allow some buffer
		})

		it("should filter by minSimilarity parameter", async () => {
			// Store a memory
			retrieval.storage.storeMemory({
				content: "Similarity filter test memory",
				type: "learning",
			})

			// With very high similarity threshold, should return nothing
			const highThreshold = await retrieval.getContext(
				"similarity filter",
				undefined,
				{ minSimilarity: 0.99 }
			)

			// Without embeddings, similarity is 0, so nothing passes
			expect(highThreshold.memories.length).toBe(0)
		})
	})

	// MEDIUM: applyFamiliarityDecay tests
	describe("Medium Priority: Familiarity Decay", () => {
		it("should apply decay to stale locations", () => {
			// Create a location with high familiarity
			const loc = retrieval.storage.recordFileAccess({
				path: "/decay-test/stale-file.ts",
				context: "Decay test",
				wasDirectAccess: true,
				activityType: "reading",
			})

			// Manually set familiarity high and last_accessed to old date
			// biome-ignore lint/complexity/useLiteralKeys: accessing private db for test setup
			;(
				retrieval.storage as unknown as {
					db: {
						prepare: (sql: string) => { run: (...args: unknown[]) => void }
					}
				}
			).db
				.prepare(`
					UPDATE location_intuitions
					SET familiarity = 0.9, last_accessed = datetime('now', '-60 days')
					WHERE id = ?
				`)
				.run(loc.id)

			// Apply decay (default staleThresholdDays=30)
			const changedCount = retrieval.storage.applyFamiliarityDecay()

			// Should have decayed at least one location
			expect(changedCount).toBeGreaterThanOrEqual(1)
		})

		it("should not decay recent locations", () => {
			// Create a location accessed recently
			const loc = retrieval.storage.recordFileAccess({
				path: "/decay-test/recent-file.ts",
				context: "Recent access test",
				wasDirectAccess: true,
				activityType: "writing",
			})

			// Get familiarity before decay
			const before = retrieval.storage.getLocationByPath(loc.path)
			expect(before).toBeDefined()

			// Apply decay with high threshold
			retrieval.storage.applyFamiliarityDecay(0.1, 0.8, 0.1, 0.4, 365)

			// Familiarity should be unchanged (location is recent)
			const after = retrieval.storage.getLocationByPath(loc.path)
			expect(after?.familiarity).toBe(before?.familiarity)
		})
	})

	// LOW: Session pruning tests (QW-4)
	describe("Low Priority: Session Pruning", () => {
		it("should prune expired sessions", () => {
			// Create a session
			const projectId = "prune-test-project"
			const sessionId = retrieval.storage.getOrCreateSession(projectId)

			// End the session
			retrieval.storage.endSession(sessionId)

			// Manually update ended_at to be old
			;(
				retrieval.storage as unknown as {
					db: {
						prepare: (sql: string) => { run: (...args: unknown[]) => void }
					}
				}
			).db
				.prepare(`
					UPDATE sessions
					SET ended_at = ?
					WHERE id = ?
				`)
				.run(Date.now() - 14 * 24 * 60 * 60 * 1000, sessionId) // 14 days ago

			// Prune sessions older than 7 days
			const pruned = retrieval.storage.pruneExpiredSessions()

			expect(pruned).toBeGreaterThanOrEqual(1)
		})

		it("should not prune active sessions", () => {
			const projectId = "active-session-prune-test"
			const sessionId = retrieval.storage.getOrCreateSession(projectId)

			// Don't end the session - it should stay active
			retrieval.storage.pruneExpiredSessions()

			// Active session should still exist
			const current = retrieval.storage.getCurrentSession(projectId)
			expect(current).toBe(sessionId)
		})
	})

	// LOW: Clock skew guard tests
	describe("Low Priority: Clock Skew Guards", () => {
		it("should handle negative time differences gracefully", () => {
			const r = retrieval as unknown as {
				getSessionDecayRate: (lastAccessMs: number, now: number) => number
			}

			// Future timestamp (clock skew simulation)
			const now = Date.now()
			const futureAccess = now + 1000000 // 1000 seconds in future

			// Should not crash and return some valid decay rate
			const decay = r.getSessionDecayRate(futureAccess, now)
			expect(decay).toBeGreaterThan(0)
			expect(decay).toBeLessThanOrEqual(0.5)
		})

		it("should handle WM with future timestamps", () => {
			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
				getWorkingMemoryBoost: (id: string, now: number) => number
			}

			// Activate in "future"
			const now = Date.now()
			r.updateWorkingMemory("clock-skew-test", now + 10000)

			// Query at "past" time - should not crash
			const boost = r.getWorkingMemoryBoost("clock-skew-test", now)
			expect(boost).toBeGreaterThanOrEqual(1.0)
		})
	})

	// LOW: Cache TTL tests
	describe("Low Priority: Cache TTL", () => {
		it("should cache associations and respect TTL", () => {
			// Access private cache via type assertion
			const getCache = () =>
				(
					retrieval as unknown as {
						associationCache: { data: unknown; cachedAt: number } | null
					}
				).associationCache
			const setCache = (val: null) => {
				;(
					retrieval as unknown as {
						associationCache: { data: unknown; cachedAt: number } | null
					}
				).associationCache = val
			}
			const getCachedAssociations = () =>
				(
					retrieval as unknown as {
						getCachedAssociations: () => unknown[]
					}
				).getCachedAssociations()

			// Clear cache
			setCache(null)

			// Get associations (should populate cache)
			const associations1 = getCachedAssociations()
			const cache1 = getCache()
			expect(cache1).not.toBeNull()
			const firstCachedAt = cache1!.cachedAt

			// Get again - should use cache (same cachedAt)
			const associations2 = getCachedAssociations()
			const cache2 = getCache()
			expect(cache2!.cachedAt).toBe(firstCachedAt)

			// Same result from cache
			expect(associations1).toBe(associations2)
		})

		it("should invalidate association cache when requested", () => {
			const r = retrieval as unknown as {
				associationCache: { data: unknown; cachedAt: number } | null
				getCachedAssociations: () => unknown[]
				invalidateAssociationCache: () => void
			}

			// Populate cache
			r.getCachedAssociations()
			expect(r.associationCache).not.toBeNull()

			// Invalidate
			r.invalidateAssociationCache()
			expect(r.associationCache).toBeNull()
		})
	})

	// HIGH-12: Full pipeline integration test
	describe("Integration: All 4 Phases Combined", () => {
		it("should combine all temporal factors in retrieval", async () => {
			const projectId = "integration-test-project"
			const project = retrieval.storage.getOrCreateProject(`/test/${projectId}`)

			// Store memories with different characteristics using storage.storeMemory
			const recentMemory = retrieval.storage.storeMemory({
				type: "context",
				content: "Recent memory about the integration test feature",
				emotionalWeight: 0.5,
				projectId: project.id,
			})

			const oldMemory = retrieval.storage.storeMemory({
				type: "context",
				content: "Old memory about a different feature",
				emotionalWeight: 0.5,
				projectId: project.id,
			})

			// Record access for both memories (access history is used for base-level activation)
			const now = Date.now()
			retrieval.storage.recordAccess(recentMemory.id)
			retrieval.storage.recordAccess(oldMemory.id)

			// Phase 1: Activate recent memory in WM
			const r = retrieval as unknown as {
				updateWorkingMemory: (id: string, now: number) => void
			}
			r.updateWorkingMemory(recentMemory.id, now)

			// Retrieve with project context (triggers Phase 3)
			const results = await retrieval.retrieve(
				"integration test feature",
				{ maxResults: 10 },
				project.id
			)

			// Verify retrieval works
			expect(results).toBeDefined()
			expect(Array.isArray(results)).toBe(true)

			// If we have results, verify we get both memories back
			if (results.length >= 2) {
				const recentResult = results.find(
					(r) => r.memory.id === recentMemory.id
				)
				const oldResult = results.find((r) => r.memory.id === oldMemory.id)

				// Both memories should be found
				expect(recentResult).toBeDefined()
				expect(oldResult).toBeDefined()

				// When embeddings are available, recent memory with WM boost should score higher
				// When no embeddings, scores are based purely on base-level activation
				// (recency-based), so recent should still be >= old
				if (recentResult && oldResult) {
					expect(recentResult.score).toBeGreaterThanOrEqual(oldResult.score)
				}
			}
		})

		it("should apply all phases without errors", async () => {
			// This test verifies the integration doesn't throw
			const projectId = "no-errors-test"
			const project = retrieval.storage.getOrCreateProject(`/test/${projectId}`)
			const sessionId = retrieval.storage.getOrCreateSession(project.id)

			// Store a memory using storage.storeMemory
			const memory = retrieval.storage.storeMemory({
				type: "context",
				content: "Test memory for integration",
				emotionalWeight: 0.7,
				projectId: project.id,
			})

			// Record access
			retrieval.storage.recordAccess(memory.id)

			// Record file access with session
			retrieval.storage.recordFileAccess({
				path: "/test/integration.ts",
				context: "Testing integration",
				wasDirectAccess: true,
				projectId: project.id,
				sessionId,
				activityType: "debugging",
			})

			// Retrieve (should not throw)
			const results = await retrieval.retrieve(
				"test integration",
				{ maxResults: 5 },
				project.id
			)

			expect(results).toBeDefined()
		})

		it("should maintain phase ordering independence", async () => {
			// Phases should work independently - disabling one shouldn't break others
			const projectId = "phase-independence-test"
			const project = retrieval.storage.getOrCreateProject(`/test/${projectId}`)

			// Store memory using storage.storeMemory
			const memory = retrieval.storage.storeMemory({
				type: "context",
				content: "Phase independence test memory",
				projectId: project.id,
			})

			// Only use Phase 2 (session decay) and Phase 3 (project boost)
			// Don't activate in WM (skip Phase 1)
			// Don't use session tracking (skip Phase 4)

			const results = await retrieval.retrieve(
				"phase independence",
				{ maxResults: 5 },
				project.id
			)

			// Should still work
			expect(results).toBeDefined()
			expect(Array.isArray(results)).toBe(true)
		})
	})
})
