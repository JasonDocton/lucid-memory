#!/usr/bin/env bun

/**
 * Lucid Memory MCP Server
 *
 * Minimal, fast MCP server for Claude Code persistent memory.
 * Uses stdio transport for direct integration.
 *
 * Tools:
 * - memory_store: Save something important
 * - memory_query: Search memories
 * - memory_context: Get relevant context for current task
 * - memory_forget: Remove sensitive data
 *
 * Run with: bun run src/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { detectProvider } from "./embeddings.ts"
import { LucidRetrieval } from "./retrieval.ts"

// === Initialize ===
const retrieval = new LucidRetrieval()
let hasSemanticSearch = false

/**
 * Initialize embedding provider BEFORE accepting any requests.
 * This fixes the race condition where queries could run before embeddings are ready.
 */
async function initializeEmbeddings(): Promise<void> {
	try {
		const config = await detectProvider()
		if (config) {
			retrieval.setEmbeddingConfig(config)
			hasSemanticSearch = true
			console.error(
				`[lucid] Embedding provider: ${config.provider} (${config.model || "default"})`
			)
		} else {
			console.error(
				"[lucid] ⚠️  No embedding provider found - using recency-only retrieval"
			)
			console.error("[lucid]    Run 'lucid status' to troubleshoot")
		}
	} catch (error) {
		console.error("[lucid] ⚠️  Failed to initialize embeddings:", error)
		console.error("[lucid]    Falling back to recency-only retrieval")
	}
}

/**
 * Process pending embeddings in the background.
 */
function startBackgroundEmbeddingProcessor(): void {
	setInterval(async () => {
		if (!hasSemanticSearch) return
		try {
			const processed = await retrieval.processPendingEmbeddings(10)
			if (processed > 0) {
				console.error(`[lucid] Processed ${processed} pending embeddings`)
			}
		} catch (error) {
			console.error("[lucid] Error processing embeddings:", error)
		}
	}, 5000)
}

/**
 * Apply familiarity decay to stale locations in the background.
 *
 * Biological analogy: Forgetting happens passively over time, not on-demand.
 * This mirrors the natural decay of hippocampal traces that aren't reinforced.
 *
 * Runs every hour - frequent enough to be responsive, rare enough to not waste cycles.
 */
function startBackgroundDecayProcessor(): void {
	const oneHourMs = 60 * 60 * 1000

	setInterval(() => {
		try {
			const decayed = retrieval.storage.applyFamiliarityDecay()
			if (decayed > 0) {
				console.error(
					`[lucid] Applied familiarity decay to ${decayed} stale locations`
				)
			}
		} catch (error) {
			console.error("[lucid] Error applying familiarity decay:", error)
		}
	}, oneHourMs)
}

// === Create MCP Server ===
const server = new McpServer({
	name: "lucid-memory",
	version: "0.1.0",
	// @ts-expect-error - MCP SDK types don't include capabilities but runtime accepts it
	capabilities: {
		tools: {},
	},
})

// === Register Tools ===

/**
 * memory_store - Save something important to remember
 */
// @ts-expect-error - Zod schema causes excessive type depth
server.tool(
	"memory_store",
	"Store something important to remember. Use this proactively when you learn something useful about the project, solve a bug, make a decision, or encounter context that might be valuable later.",
	{
		content: z
			.string()
			.describe("What to remember - be specific and include context"),
		type: z
			.enum([
				"learning",
				"decision",
				"context",
				"bug",
				"solution",
				"conversation",
			])
			.optional()
			.default("learning")
			.describe("Type of memory"),
		gist: z
			.string()
			.optional()
			.describe("Short summary (generated automatically if not provided)"),
		tags: z.array(z.string()).optional().describe("Tags for categorization"),
		emotionalWeight: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.describe("How important is this? 0-1, higher = more important"),
		projectPath: z
			.string()
			.optional()
			.describe("Project path for project-specific memories"),
	},
	async ({ content, type, gist, tags, emotionalWeight, projectPath }) => {
		try {
			// Get or create project if path provided
			let projectId: string | undefined
			if (projectPath) {
				const project = retrieval.storage.getOrCreateProject(projectPath)
				projectId = project.id
			}

			const memory = await retrieval.store(content, {
				type,
				gist,
				tags,
				emotionalWeight,
				projectId,
			})

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								success: true,
								id: memory.id,
								message: `Stored: "${content.slice(0, 50)}${content.length > 50 ? "..." : ""}"`,
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * memory_query - Search for relevant memories
 */
// @ts-expect-error - Zod schema causes excessive type depth
server.tool(
	"memory_query",
	"Search for relevant memories. Use when you need to recall past learnings, decisions, bugs, or context.",
	{
		query: z.string().describe("What to search for - natural language"),
		limit: z
			.number()
			.min(1)
			.max(20)
			.optional()
			.default(5)
			.describe("Max results"),
		type: z
			.enum([
				"learning",
				"decision",
				"context",
				"bug",
				"solution",
				"conversation",
			])
			.optional()
			.describe("Filter by memory type"),
		projectPath: z.string().optional().describe("Filter by project path"),
	},
	async ({ query, limit, type, projectPath }) => {
		try {
			// Get project ID if path provided
			let projectId: string | undefined
			if (projectPath) {
				const project = retrieval.storage.getOrCreateProject(projectPath)
				projectId = project.id
			}

			const results = await retrieval.retrieve(
				query,
				{
					maxResults: limit,
					filterType: type,
				},
				projectId
			)

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									message: "No memories found matching your query.",
									suggestions: [
										"Try broader search terms",
										"Check if memories exist for this project",
										"Store relevant context first with memory_store",
									],
								},
								null,
								2
							),
						},
					],
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								count: results.length,
								memories: results.map((r) => ({
									id: r.memory.id,
									content: r.memory.content,
									type: r.memory.type,
									relevance: Math.round(r.score * 100) / 100,
									tags: r.memory.tags,
									createdAt: new Date(r.memory.createdAt).toISOString(),
								})),
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * memory_context - Get relevant context for current task
 */
server.tool(
	"memory_context",
	"Get memories relevant to your current task. Call this at the start of conversations or when context would help.",
	{
		currentTask: z.string().describe("What you're currently working on"),
		projectPath: z.string().optional().describe("Current project path"),
	},
	async ({ currentTask, projectPath }) => {
		try {
			// Get project ID if path provided
			let projectId: string | undefined
			if (projectPath) {
				const project = retrieval.storage.getOrCreateProject(projectPath)
				projectId = project.id
			}

			const context = await retrieval.getContext(currentTask, projectId)

			if (context.memories.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									message: "No relevant context found.",
									hint: "As you learn things about this project, use memory_store to build up context.",
								},
								null,
								2
							),
						},
					],
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								summary: context.summary,
								relevantMemories: context.memories.map((r) => ({
									content: r.memory.content,
									type: r.memory.type,
									relevance: Math.round(r.score * 100) / 100,
								})),
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * memory_forget - Remove a memory (for sensitive data)
 */
server.tool(
	"memory_forget",
	"Remove a memory. Use this to delete sensitive information that shouldn't be retained.",
	{
		memoryId: z.string().describe("ID of the memory to remove"),
	},
	async ({ memoryId }) => {
		try {
			const deleted = retrieval.storage.deleteMemory(memoryId)

			if (!deleted) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: false,
									message: "Memory not found",
								},
								null,
								2
							),
						},
					],
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								success: true,
								message: "Memory removed",
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * memory_stats - Get memory system statistics
 */
server.tool(
	"memory_stats",
	"Get statistics about the memory system.",
	{},
	async () => {
		try {
			const stats = retrieval.storage.getStats()

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								memories: stats.memoryCount,
								withEmbeddings: stats.embeddingCount,
								associations: stats.associationCount,
								projects: stats.projectCount,
								locations: stats.locationCount,
								dbSizeKB: Math.round(stats.dbSizeBytes / 1024),
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

// ============================================================================
// Location Intuition Tools
// ============================================================================

/**
 * location_record - Record that you accessed a file
 */
// @ts-expect-error - Zod schema causes excessive type depth
server.tool(
	"location_record",
	"Record that you accessed a file - builds familiarity over time. Use this proactively when reading or editing files to build spatial memory.",
	{
		path: z.string().describe("Absolute path to the file"),
		context: z
			.string()
			.describe("What you were doing when accessing this file"),
		wasDirectAccess: z
			.boolean()
			.describe(
				"True if you went directly to this file, false if you searched for it"
			),
		projectPath: z
			.string()
			.optional()
			.describe("Optional project path to scope this location to"),
		taskContext: z
			.string()
			.optional()
			.describe("Optional description of the current task"),
		activityType: z
			.enum([
				"reading",
				"writing",
				"debugging",
				"refactoring",
				"reviewing",
				"unknown",
			])
			.optional()
			.describe(
				"Type of activity (auto-inferred from context if not provided)"
			),
	},
	async ({
		path,
		context,
		wasDirectAccess,
		projectPath,
		taskContext,
		activityType,
	}) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined

			const location = retrieval.storage.recordFileAccess({
				path,
				context,
				wasDirectAccess,
				projectId,
				taskContext,
				activityType,
			})

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								path: location.path,
								familiarity: Math.round(location.familiarity * 100) / 100,
								accessCount: location.accessCount,
								searchesSaved: location.searchesSaved,
								isWellKnown: location.familiarity >= 0.7,
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_get - Check if you 'know' a location
 */
server.tool(
	"location_get",
	"Check if you 'know' a location and get its familiarity.",
	{
		path: z.string().describe("Path to check"),
		projectPath: z.string().optional().describe("Optional project scope"),
	},
	async ({ path, projectPath }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const location = retrieval.storage.getLocationByPath(path, projectId)

			if (!location) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ known: false, path }),
						},
					],
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								known: true,
								path: location.path,
								familiarity: Math.round(location.familiarity * 100) / 100,
								accessCount: location.accessCount,
								isWellKnown: location.familiarity >= 0.7,
								lastAccessed: location.lastAccessed,
								description: location.description,
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_find - Find known locations matching a pattern
 */
server.tool(
	"location_find",
	"Find known locations matching a pattern.",
	{
		pattern: z
			.string()
			.describe("Pattern to search for in paths and descriptions"),
		projectPath: z.string().optional().describe("Optional project scope"),
		limit: z
			.number()
			.min(1)
			.max(50)
			.optional()
			.default(10)
			.describe("Maximum results to return"),
	},
	async ({ pattern, projectPath, limit }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const locations = retrieval.storage.findLocations(
				pattern,
				projectId,
				limit
			)

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							locations.map((loc) => ({
								path: loc.path,
								familiarity: Math.round(loc.familiarity * 100) / 100,
								accessCount: loc.accessCount,
								description: loc.description,
							})),
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_all - Get all known locations sorted by familiarity
 */
server.tool(
	"location_all",
	"Get all known locations sorted by familiarity.",
	{
		projectPath: z.string().optional().describe("Optional project scope"),
		limit: z
			.number()
			.min(1)
			.max(100)
			.optional()
			.default(20)
			.describe("Maximum results"),
	},
	async ({ projectPath, limit }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const locations = retrieval.storage.getAllLocations(projectId, limit)

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							locations.map((loc) => ({
								path: loc.path,
								familiarity: Math.round(loc.familiarity * 100) / 100,
								accessCount: loc.accessCount,
								isWellKnown: loc.familiarity >= 0.7,
							})),
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_recent - Get recently accessed locations
 */
server.tool(
	"location_recent",
	"Get recently accessed locations.",
	{
		projectPath: z.string().optional().describe("Optional project scope"),
		limit: z
			.number()
			.min(1)
			.max(50)
			.optional()
			.default(20)
			.describe("Maximum results"),
	},
	async ({ projectPath, limit }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const locations = retrieval.storage.getRecentLocations(projectId, limit)

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							locations.map((loc) => ({
								path: loc.path,
								familiarity: Math.round(loc.familiarity * 100) / 100,
								lastAccessed: loc.lastAccessed,
								accessCount: loc.accessCount,
							})),
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_contexts - Get access history for a location
 */
server.tool(
	"location_contexts",
	"Get the access history for a location - what were you doing when you touched this file?",
	{
		path: z.string().describe("Path to get contexts for"),
		projectPath: z.string().optional(),
		limit: z.number().min(1).max(50).optional().default(10),
	},
	async ({ path, projectPath, limit }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const locationWithContexts = retrieval.storage.getLocationWithContexts(
				path,
				projectId
			)

			if (!locationWithContexts) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ known: false, path }),
						},
					],
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								path: locationWithContexts.path,
								familiarity:
									Math.round(locationWithContexts.familiarity * 100) / 100,
								contexts: locationWithContexts.accessContexts
									.slice(0, limit)
									.map((ctx) => ({
										context: ctx.contextDescription,
										activityType: ctx.activityType,
										wasDirectAccess: ctx.wasDirectAccess,
										taskContext: ctx.taskContext,
										accessedAt: ctx.accessedAt,
									})),
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_stats - Get statistics about location knowledge
 */
server.tool(
	"location_stats",
	"Get statistics about location knowledge.",
	{
		projectPath: z.string().optional(),
	},
	async ({ projectPath }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const stats = retrieval.storage.getLocationStats(projectId)

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								totalLocations: stats.totalLocations,
								highFamiliarity: stats.highFamiliarity,
								totalSearchesSaved: stats.totalSearchesSaved,
								averageFamiliarity:
									Math.round(stats.averageFamiliarity * 100) / 100,
								mostFamiliarPaths: stats.mostFamiliarPaths,
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_decay - Manually trigger familiarity decay
 */
server.tool(
	"location_decay",
	"Manually trigger familiarity decay (for testing/maintenance).",
	{
		staleThresholdDays: z
			.number()
			.min(1)
			.optional()
			.default(30)
			.describe("Days of inactivity before decay"),
	},
	async ({ staleThresholdDays }) => {
		try {
			const changed = retrieval.storage.applyFamiliarityDecay(
				0.1,
				0.8,
				0.1,
				0.4,
				staleThresholdDays
			)

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ locationsDecayed: changed }),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_pin - Pin a location to exempt it from orphan detection
 */
server.tool(
	"location_pin",
	"Pin a location to exempt it from orphan detection (for stable reference files).",
	{
		path: z.string().describe("Path to pin/unpin"),
		pinned: z
			.boolean()
			.optional()
			.default(true)
			.describe("Whether to pin (true) or unpin (false)"),
		projectPath: z.string().optional(),
	},
	async ({ path, pinned, projectPath }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const success = retrieval.storage.pinLocation(path, pinned, projectId)

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								success,
								path,
								pinned,
								message: success
									? `Location ${pinned ? "pinned" : "unpinned"}`
									: "Location not found",
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_orphaned - Find stale locations
 */
server.tool(
	"location_orphaned",
	"Find orphaned locations (high familiarity but not accessed recently).",
	{
		projectPath: z.string().optional(),
		staleThresholdDays: z.number().min(1).optional().default(60),
		minFamiliarity: z.number().min(0).max(1).optional().default(0.4),
	},
	async ({ projectPath, staleThresholdDays, minFamiliarity }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const orphaned = retrieval.storage.detectOrphanedLocations(
				projectId,
				staleThresholdDays,
				minFamiliarity
			)

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								count: orphaned.length,
								locations: orphaned.map((loc) => ({
									path: loc.path,
									familiarity: Math.round(loc.familiarity * 100) / 100,
									lastAccessed: loc.lastAccessed,
								})),
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_merge - Merge knowledge from old path to new path
 */
server.tool(
	"location_merge",
	"Merge knowledge from an old path into a new path (for renames/moves).",
	{
		oldPath: z.string().describe("Original path"),
		newPath: z.string().describe("New path after rename/move"),
		projectPath: z.string().optional(),
	},
	async ({ oldPath, newPath, projectPath }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const merged = retrieval.storage.mergeLocations(
				oldPath,
				newPath,
				projectId
			)

			if (!merged) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								message: "Neither path found",
							}),
						},
					],
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								success: true,
								path: merged.path,
								familiarity: Math.round(merged.familiarity * 100) / 100,
								accessCount: merged.accessCount,
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_associated - Find files that are commonly accessed together with a given file
 *
 * Biological analogy: Spreading activation through hippocampal networks.
 * When you think of one place, related places naturally come to mind.
 */
server.tool(
	"location_associated",
	"Find files commonly accessed together with a given file - reveals your working patterns and related files.",
	{
		path: z.string().describe("Path to find associations for"),
		projectPath: z.string().optional(),
		limit: z.number().min(1).max(20).optional().default(10),
	},
	async ({ path, projectPath, limit }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const associated = retrieval.storage.getAssociatedLocationsByPath(
				path,
				projectId,
				limit
			)

			if (associated.length === 0) {
				const location = retrieval.storage.getLocationByPath(path, projectId)
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									path,
									known: !!location,
									associations: [],
									message: location
										? "No associations yet - access other files in the same session to build associations"
										: "Path not known",
								},
								null,
								2
							),
						},
					],
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								path,
								associations: associated.map((loc) => ({
									path: loc.path,
									strength: Math.round(loc.associationStrength * 100) / 100,
									familiarity: Math.round(loc.familiarity * 100) / 100,
								})),
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * location_by_activity - Find files where you've done specific types of work
 *
 * Biological analogy: Entorhinal context-based retrieval.
 * "Where have I been debugging?" activates spatial memories bound to that context.
 */
server.tool(
	"location_by_activity",
	"Find files where you've done specific types of work - 'what files have I debugged recently?'",
	{
		activityType: z
			.enum([
				"reading",
				"writing",
				"debugging",
				"refactoring",
				"reviewing",
				"unknown",
			])
			.describe("Type of activity to search for"),
		projectPath: z.string().optional(),
		limit: z.number().min(1).max(50).optional().default(20),
	},
	async ({ activityType, projectPath, limit }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined
			const locations = retrieval.storage.getLocationsByActivity(
				activityType,
				projectId,
				limit
			)

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								activityType,
								count: locations.length,
								locations: locations.map((loc) => ({
									path: loc.path,
									familiarity: Math.round(loc.familiarity * 100) / 100,
									activityCount: loc.activityCount,
									lastActivity: loc.lastActivity,
								})),
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ error: String(error) }),
					},
				],
				isError: true,
			}
		}
	}
)

// === Start Server ===
async function main(): Promise<void> {
	console.error("[lucid] Starting Lucid Memory MCP server...")

	// Initialize embeddings BEFORE accepting connections (fixes race condition)
	await initializeEmbeddings()

	// Start background processors
	startBackgroundEmbeddingProcessor()
	startBackgroundDecayProcessor()

	// Now connect to transport
	const transport = new StdioServerTransport()
	await server.connect(transport)

	console.error("[lucid] Server connected. Ready for Claude Code.")
}

main().catch((error) => {
	console.error("[lucid] Fatal error:", error)
	process.exit(1)
})
