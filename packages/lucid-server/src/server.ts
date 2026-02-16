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
import { ConsolidationConfig, ReconsolidationConfig } from "./config.ts"
import { ConsolidationEngine } from "./consolidation.ts"
import { detectProvider, loadNativeEmbeddingModel } from "./embeddings.ts"
import { LucidRetrieval } from "./retrieval.ts"

// === Multi-Client Configuration ===

// biome-ignore lint/style/noProcessEnv: Required for user home directory
const LUCID_DIR = `${process.env.HOME}/.lucid`
// biome-ignore lint/style/noProcessEnv: Required for client detection
const LUCID_CLIENT = process.env.LUCID_CLIENT || "claude"

const databaseModes = {
	shared: "shared",
	perClient: "per-client",
	profiles: "profiles",
} as const

type DatabaseMode = (typeof databaseModes)[keyof typeof databaseModes]

interface ClientConfig {
	enabled: boolean
	profile: string
}

interface ProfileConfig {
	dbPath: string
}

interface LucidConfig {
	autoUpdate?: boolean
	databaseMode?: DatabaseMode
	clients?: Record<string, ClientConfig>
	profiles?: Record<string, ProfileConfig>
}

async function loadConfig(): Promise<LucidConfig> {
	try {
		const configPath = `${LUCID_DIR}/config.json`
		const file = Bun.file(configPath)
		if (await file.exists()) {
			return await file.json()
		}
	} catch (error) {
		console.error("[lucid] Failed to load config:", error)
	}
	return {}
}

function resolveDbPath(config: LucidConfig, client: string): string {
	const mode = config.databaseMode || "shared"

	if (mode === "per-client") {
		return `${LUCID_DIR}/memory-${client}.db`
	}

	if (mode === "profiles") {
		const clientConfig = config.clients?.[client]
		const profileName = clientConfig?.profile || "default"
		const profile = config.profiles?.[profileName]
		const rawPath = profile?.dbPath || `${LUCID_DIR}/memory.db`
		// biome-ignore lint/style/noProcessEnv: Required for tilde expansion
		// biome-ignore lint/style/noNonNullAssertion: HOME always defined on Unix
		const home = process.env.HOME!
		return rawPath.startsWith("~") ? rawPath.replace("~", home) : rawPath
	}

	return `${LUCID_DIR}/memory.db`
}

/**
 * LOW-8: Helper to create error response with tool context.
 * Adds tool name to error messages for easier debugging.
 */
function toolError(toolName: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	console.error(`[lucid] Tool error in ${toolName}:`, message)
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ error: message, tool: toolName }),
			},
		],
		isError: true,
	}
}

// === Initialize ===
// Module-level variable, initialized in main() after config loading
let retrieval: LucidRetrieval
let hasSemanticSearch = false

/**
 * Initialize embedding provider BEFORE accepting any requests.
 * This fixes the race condition where queries could run before embeddings are ready.
 */
async function initializeEmbeddings(): Promise<void> {
	try {
		// Pre-load native embedding model before detection
		loadNativeEmbeddingModel()

		const config = await detectProvider()
		if (config) {
			retrieval.setEmbeddingConfig(config)
			hasSemanticSearch = true
			console.error(
				`[lucid] Embedding provider: ${config.provider} (${config.model || "default"})`
			)

			// Migrate stale embeddings if model changed
			retrieval.migrateEmbeddingsIfNeeded(config)
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
 * Process pending visual embeddings in the background.
 */
function startBackgroundVisualEmbeddingProcessor(): void {
	setInterval(async () => {
		if (!hasSemanticSearch) return
		try {
			const processed = await retrieval.processPendingVisualEmbeddings(10)
			if (processed > 0) {
				console.error(
					`[lucid] Processed ${processed} pending visual embeddings`
				)
			}
		} catch (error) {
			console.error("[lucid] Error processing visual embeddings:", error)
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

function startBackgroundConsolidationProcessor(): void {
	if (!ConsolidationConfig.enabled) return

	const engine = new ConsolidationEngine(retrieval.storage)

	// Micro-consolidation: every 5 minutes
	setInterval(() => {
		try {
			const stats = engine.runMicroConsolidation()
			const total =
				stats.strengthened +
				stats.decayed +
				stats.associationsDecayed +
				stats.associationsPruned
			if (total > 0) {
				console.error(
					`[lucid] Micro-consolidation: ${stats.strengthened} strengthened, ${stats.decayed} decayed, ${stats.associationsPruned} assocs pruned`
				)
			}
		} catch (error) {
			console.error("[lucid] Error in micro-consolidation:", error)
		}
	}, ConsolidationConfig.microIntervalMs)

	// Full consolidation: every hour
	setInterval(() => {
		try {
			const stats = engine.runFullConsolidation()
			const total =
				stats.freshToConsolidating +
				stats.consolidatingToConsolidated +
				stats.reconsolidatingToConsolidated +
				stats.associationsPruned +
				stats.memoriesPruned +
				stats.contextsConsolidated +
				stats.visualsPruned
			if (total > 0) {
				console.error(
					`[lucid] Full consolidation: ${stats.freshToConsolidating} fresh→consolidating, ${stats.consolidatingToConsolidated} consolidating→consolidated, ${stats.associationsPruned} assocs pruned, ${stats.memoriesPruned} memories pruned, ${stats.visualsPruned} visuals pruned, ${stats.contextsConsolidated} contexts consolidated`
				)
			}
		} catch (error) {
			console.error("[lucid] Error in full consolidation:", error)
		}
	}, ConsolidationConfig.fullIntervalMs)
}

function startBackgroundSessionPruneProcessor(): void {
	const oneHourMs = 60 * 60 * 1000

	setInterval(() => {
		try {
			const pruned = retrieval.storage.pruneExpiredSessions()
			if (pruned > 0) {
				console.error(`[lucid] Pruned ${pruned} expired sessions`)
			}
		} catch (error) {
			console.error("[lucid] Error pruning expired sessions:", error)
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
			return toolError("memory_store", error)
		}
	}
)

/**
 * memory_query - Search for relevant memories
 */
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
			return toolError("memory_query", error)
		}
	}
)

/**
 * memory_narrative - Find temporally adjacent memories
 */
server.tool(
	"memory_narrative",
	"Find what happened before or after a specific event. Use for questions like 'What was I working on before X?'",
	{
		anchor: z
			.string()
			.min(1, "Anchor cannot be empty")
			.describe("The event to find context around"),
		direction: z
			.enum(["before", "after", "both"])
			.optional()
			.default("before")
			.describe("Which direction to search"),
		limit: z
			.number()
			.min(1)
			.max(10)
			.optional()
			.default(5)
			.describe("Max results"),
		projectPath: z.string().optional().describe("Filter by project path"),
	},
	async ({ anchor, direction, limit, projectPath }) => {
		try {
			const { EpisodicMemoryConfig } = await import("./config.ts")
			if (!EpisodicMemoryConfig.enabled) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								message:
									"Episodic memory is not yet enabled. Temporal queries require episode data to be collected first.",
							}),
						},
					],
				}
			}

			let projectId: string | undefined
			if (projectPath) {
				const project = retrieval.storage.getOrCreateProject(projectPath)
				projectId = project.id
			}

			const results = await retrieval.retrieveTemporalNeighbors(
				anchor,
				direction,
				{ limit, projectId }
			)

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									message: `No temporal neighbors found ${direction} "${anchor}".`,
									suggestions: [
										"The anchor memory may not be part of an episode yet",
										"Try a different search term",
										"Episodes are built as memories are stored",
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
								anchor,
								direction,
								count: results.length,
								memories: results.map((r) => ({
									id: r.memory.id,
									content: r.memory.content,
									type: r.memory.type,
									temporalStrength: Math.round(r.spreading * 100) / 100,
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
			return toolError("memory_narrative", error)
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
			return toolError("memory_context", error)
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
			return toolError("memory_forget", error)
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
			return toolError("memory_stats", error)
		}
	}
)

// ============================================================================
// Visual Memory Tools
// ============================================================================

/**
 * visual_store - Store a visual memory (image/video description)
 */
server.tool(
	"visual_store",
	"Store a visual memory - describe an image or video you've seen. Called automatically after viewing media shared by the user.",
	{
		description: z
			.string()
			.describe(
				"Your description of the image/video - what you see, objects, people, setting, mood"
			),
		mediaType: z
			.enum(["image", "video"])
			.optional()
			.default("image")
			.describe("Type of media"),
		objects: z
			.array(z.string())
			.optional()
			.describe("List of objects/people detected"),
		significance: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.default(0.5)
			.describe("How memorable is this? 0-1"),
		emotionalValence: z
			.number()
			.min(-1)
			.max(1)
			.optional()
			.default(0)
			.describe("Pleasant (+1) to unpleasant (-1)"),
		emotionalArousal: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.default(0.5)
			.describe("Calm (0) to exciting (1)"),
		sharedBy: z.string().optional().describe("Who shared this media"),
		originalPath: z.string().optional().describe("Path to original file"),
		projectPath: z
			.string()
			.optional()
			.describe("Project path for scoping visual memory"),
	},
	async ({
		description,
		mediaType,
		objects,
		significance,
		emotionalValence,
		emotionalArousal,
		sharedBy,
		originalPath,
		projectPath,
	}) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined

			const visual = await retrieval.storeVisual({
				description,
				mediaType: mediaType as "image" | "video",
				source: "direct",
				objects,
				significance,
				emotionalValence,
				emotionalArousal,
				sharedBy,
				originalPath,
				projectId,
			})

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								success: true,
								id: visual.id,
								message: `Remembered: "${description.slice(0, 50)}${description.length > 50 ? "..." : ""}"`,
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return toolError("visual_store", error)
		}
	}
)

/**
 * visual_search - Search visual memories
 */
server.tool(
	"visual_search",
	"Search visual memories. Use when you need to recall images or videos you've seen.",
	{
		query: z.string().describe("What to search for - natural language"),
		limit: z
			.number()
			.min(1)
			.max(10)
			.optional()
			.default(5)
			.describe("Max results"),
		projectPath: z
			.string()
			.optional()
			.describe("Project path for context-aware ranking"),
	},
	async ({ query, limit, projectPath }) => {
		try {
			const projectId = projectPath
				? retrieval.storage.getOrCreateProject(projectPath).id
				: undefined

			const results = await retrieval.retrieveVisual(
				query,
				{
					maxResults: limit,
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
									message: "No visual memories found matching your query.",
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
								visuals: results.map((r) => ({
									id: r.visual.id,
									description: r.visual.description,
									mediaType: r.visual.mediaType,
									objects: r.visual.objects,
									relevance: Math.round(r.score * 100) / 100,
									sharedBy: r.visual.sharedBy,
									receivedAt: new Date(r.visual.receivedAt).toISOString(),
								})),
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			return toolError("visual_search", error)
		}
	}
)

/**
 * visual_list - List visual memories with optional filters
 */
server.tool(
	"visual_list",
	"List visual memories with optional filters. Use for browsing without semantic search.",
	{
		mediaType: z
			.enum(["image", "video"])
			.optional()
			.describe("Filter by media type"),
		sharedBy: z.string().optional().describe("Filter by who shared it"),
		minSignificance: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.describe("Minimum significance threshold"),
		limit: z
			.number()
			.min(1)
			.max(50)
			.optional()
			.default(20)
			.describe("Max results"),
	},
	async ({ mediaType, sharedBy, minSignificance, limit }) => {
		try {
			const visuals = retrieval.storage.queryVisualMemories({
				mediaType,
				sharedBy,
				minSignificance,
				limit,
			})
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							count: visuals.length,
							visuals: visuals.map((v) => ({
								id: v.id,
								description: v.description,
								mediaType: v.mediaType,
								objects: v.objects,
								significance: v.significance,
								sharedBy: v.sharedBy,
								receivedAt: new Date(v.receivedAt).toISOString(),
							})),
						}),
					},
				],
			}
		} catch (error) {
			return toolError("visual_list", error)
		}
	}
)

/**
 * visual_delete - Delete a visual memory
 */
server.tool(
	"visual_delete",
	"Delete a visual memory by ID. Use when a visual memory is no longer relevant or was stored in error.",
	{
		id: z.string().describe("The visual memory ID to delete"),
	},
	async ({ id }) => {
		try {
			const deleted = retrieval.storage.deleteVisualMemory(id)
			return {
				content: [
					{
						type: "text" as const,
						text: deleted
							? `Visual memory ${id} deleted.`
							: `Visual memory ${id} not found.`,
					},
				],
			}
		} catch (error) {
			return toolError("visual_delete", error)
		}
	}
)

// ============================================================================
// Video Processing Tools
// ============================================================================

/**
 * video_process - Process video with Rust parallel pipeline (frames + audio)
 *
 * Uses tokio::join! for parallel extraction of frames and audio transcription.
 */
server.tool(
	"video_process",
	"Process a video file using Rust parallel pipeline. Extracts frames and transcribes audio simultaneously. Returns frame paths to read and describe, plus transcript.",
	{
		videoPath: z.string().describe("Path to video file"),
		maxFrames: z
			.number()
			.min(1)
			.max(100)
			.optional()
			.default(20)
			.describe("Maximum frames to extract (default: 20)"),
		skipTranscription: z
			.boolean()
			.optional()
			.default(false)
			.describe("Skip audio transcription"),
		sharedBy: z.string().optional().describe("Who shared this video"),
	},
	async ({ videoPath, maxFrames, skipTranscription, sharedBy }) => {
		try {
			// Try to load Rust perception module
			let perception: typeof import("@lucid-memory/perception") | null = null
			try {
				perception = await import("@lucid-memory/perception")
			} catch {
				// Fall back to TypeScript implementation
			}

			if (perception) {
				// Use Rust parallel processing
				const output = await perception.videoProcess(videoPath, {
					video: { maxFrames },
					skipTranscription,
					enableSceneDetection: true,
				})

				// Filter to scene changes for more meaningful frames
				const keyFrames = output.frames
					.filter((f) => f.isSceneChange || f.isKeyframe)
					.slice(0, maxFrames)

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									metadata: {
										duration: Math.round(output.metadata.durationSeconds),
										width: output.metadata.width,
										height: output.metadata.height,
										fps: Math.round(output.metadata.frameRate),
										hasAudio: output.metadata.hasAudio,
									},
									frames: keyFrames.map((f) => ({
										path: f.path,
										timestamp: Math.round(f.timestampSeconds),
										isSceneChange: f.isSceneChange,
									})),
									transcript: output.transcript?.text ?? null,
									transcriptSegments: output.transcript?.segments.map((s) => ({
										start: s.startMs / 1000,
										end: s.endMs / 1000,
										text: s.text,
									})),
									stats: {
										framesExtracted: output.stats.framesExtracted,
										sceneChanges: output.stats.sceneChanges,
										extractionTimeMs: output.stats.extractionTimeMs,
										transcriptionTimeMs: output.stats.transcriptionTimeMs,
									},
									sharedBy,
									instructions:
										"Read each frame image to see the video content. Use the transcript for audio context. Then call visual_store with a synthesized 2-3 sentence description of the entire video (mediaType: 'video').",
								},
								null,
								2
							),
						},
					],
				}
			}

			// Fallback to TypeScript implementation
			const { getVideoMetadata, extractFrames, selectFrames, createWorkDir } =
				await import("./video.ts")

			const workDir = createWorkDir()
			const metadata = await getVideoMetadata(videoPath)
			const allFrames = await extractFrames(videoPath, workDir, { fps: 1 })
			const selectedIndices = selectFrames(allFrames, maxFrames, null)
			const selectedFrames = selectedIndices
				.map((i) => allFrames[i])
				.filter((f): f is NonNullable<typeof f> => f !== undefined)

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								success: true,
								metadata: {
									duration: Math.round(metadata.duration),
									width: metadata.width,
									height: metadata.height,
									fps: Math.round(metadata.fps),
								},
								frames: selectedFrames.map((f) => ({
									path: f.path,
									timestamp: Math.round(f.timestamp),
								})),
								transcript: null,
								sharedBy,
								workDir,
								instructions:
									"Read each frame image, describe what you see, then call visual_store with a synthesized description (mediaType: 'video').",
							},
							null,
							2
						),
					},
				],
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error("[lucid] Tool error in video_process:", message)
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							error: message,
							tool: "video_process",
							hint: "Make sure ffmpeg is installed: brew install ffmpeg",
						}),
					},
				],
				isError: true,
			}
		}
	}
)

/**
 * video_cleanup - Clean up temporary video processing files
 */
server.tool(
	"video_cleanup",
	"Clean up temporary files from video processing. Call this after you've finished describing and storing a video.",
	{
		workDir: z.string().describe("The workDir returned by video_prepare"),
	},
	async ({ workDir }) => {
		try {
			const { cleanupWorkDir } = await import("./video.ts")
			cleanupWorkDir(workDir)
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ success: true, message: "Cleaned up" }),
					},
				],
			}
		} catch (error) {
			return toolError("video_cleanup", error)
		}
	}
)

// ============================================================================
// Consolidation Tools (0.6.0)
// ============================================================================

server.tool(
	"memory_consolidation_status",
	"Get memory consolidation diagnostics — shows consolidation state distribution, association stats, episode info, and embedding health.",
	{},
	async () => {
		try {
			const counts = retrieval.storage.getConsolidationCounts()
			const associations = retrieval.storage.getAllAssociations()
			const weakCount = associations.filter((a) => a.strength < 0.1).length
			const recentEpisodes = retrieval.storage.getRecentEpisodes(undefined, 5)
			const pendingEmbeddings =
				retrieval.storage.getMemoriesWithoutEmbeddings(1000)
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							consolidationStates: counts,
							associations: {
								total: associations.length,
								weak: weakCount,
								avgStrength:
									associations.length > 0
										? associations.reduce((sum, a) => sum + a.strength, 0) /
											associations.length
										: 0,
							},
							episodes: {
								recentCount: recentEpisodes.length,
								recent: recentEpisodes.map((ep) => ({
									id: ep.id,
									boundaryType: ep.boundaryType,
									eventCount:
										retrieval.storage.getEpisodeEvents(ep.id).length,
									startedAt: new Date(ep.startedAt).toISOString(),
									endedAt: ep.endedAt
										? new Date(ep.endedAt).toISOString()
										: "active",
								})),
							},
							embeddings: {
								pending: pendingEmbeddings.length,
							},
							config: {
								consolidationEnabled: ConsolidationConfig.enabled,
								microIntervalMs: ConsolidationConfig.microIntervalMs,
								fullIntervalMs: ConsolidationConfig.fullIntervalMs,
								reconsolidationEnabled: ReconsolidationConfig.enabled,
								reconsolidationZone: {
									thetaLow: ReconsolidationConfig.thetaLow,
									thetaHigh: ReconsolidationConfig.thetaHigh,
								},
							},
						}),
					},
				],
			}
		} catch (error) {
			return toolError("memory_consolidation_status", error)
		}
	}
)

// ============================================================================
// Location Intuition Tools
// ============================================================================

/**
 * location_record - Record that you accessed a file
 */
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

			// Phase 4: Get session for co-access tracking
			const sessionId = retrieval.getOrCreateSession(projectId)

			const location = retrieval.storage.recordFileAccess({
				path,
				context,
				wasDirectAccess,
				projectId,
				taskContext,
				activityType,
				sessionId,
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
			return toolError("location_record", error)
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
			return toolError("location_get", error)
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
			return toolError("location_find", error)
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
			return toolError("location_all", error)
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
			return toolError("location_recent", error)
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
			return toolError("location_contexts", error)
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
			return toolError("location_stats", error)
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
			return toolError("location_decay", error)
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
			return toolError("location_pin", error)
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
			return toolError("location_orphaned", error)
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
			return toolError("location_merge", error)
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
			return toolError("location_associated", error)
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
			return toolError("location_by_activity", error)
		}
	}
)

/**
 * Check for updates in the background (non-blocking).
 * If auto-update is enabled, installs the update automatically.
 * Otherwise, logs a message if a newer version is available.
 */
async function checkForUpdates(): Promise<void> {
	const REPO = "JasonDocton/lucid-memory"
	// biome-ignore lint/style/noProcessEnv: Server requires environment access for user home directory
	const LUCID_DIR = `${process.env.HOME}/.lucid`

	try {
		// Check if auto-update is enabled
		let autoUpdateEnabled = false
		try {
			const configPath = `${LUCID_DIR}/config.json`
			const config = await Bun.file(configPath).json()
			autoUpdateEnabled = config.autoUpdate === true
		} catch {
			// No config file, default to manual updates
		}

		// Get current version
		let currentVersion = "0.0.0"
		try {
			const pkgPath = `${LUCID_DIR}/server/package.json`
			const pkg = await Bun.file(pkgPath).json()
			currentVersion = pkg.version || "0.0.0"
		} catch {
			return // Can't determine current version
		}

		// Check latest version from GitHub (with short timeout)
		const pkgResponse = await fetch(
			`https://raw.githubusercontent.com/${REPO}/main/packages/lucid-server/package.json`,
			{ signal: AbortSignal.timeout(5000) }
		)

		if (pkgResponse.ok) {
			const remotePkg = await pkgResponse.json()
			const latestVersion = remotePkg.version || "0.0.0"

			// Simple version comparison (works for semver)
			if (latestVersion !== currentVersion && latestVersion > currentVersion) {
				if (autoUpdateEnabled) {
					console.error(
						`[lucid] ⬆️  Auto-updating: ${currentVersion} → ${latestVersion}`
					)
					await performAutoUpdate(REPO, LUCID_DIR)
				} else {
					console.error(
						`[lucid] ⬆️  Update available: ${currentVersion} → ${latestVersion}`
					)
					console.error("[lucid]    Run 'lucid update' to install")
				}
			}
		}
	} catch {
		// Silently ignore update check failures - not critical
	}
}

/**
 * Perform automatic update in the background.
 */
async function performAutoUpdate(
	repo: string,
	lucidDir: string
): Promise<void> {
	try {
		const { promisify } = await import("node:util")
		const exec = promisify((await import("node:child_process")).exec)

		const tempDir = `${lucidDir}/update-tmp-${Date.now()}`
		await exec(`mkdir -p ${tempDir}`)

		try {
			// Clone latest
			await exec(
				`git clone --depth 1 https://github.com/${repo}.git ${tempDir}/repo`,
				{ timeout: 60000 }
			)

			// Backup current server
			const backupDir = `${lucidDir}/server-backup-${Date.now()}`
			await exec(`mv ${lucidDir}/server ${backupDir}`)

			// Copy new server
			await exec(
				`cp -r ${tempDir}/repo/packages/lucid-server ${lucidDir}/server`
			)

			// Copy new native package if exists
			const nativeExists = await Bun.file(
				`${tempDir}/repo/packages/lucid-native/package.json`
			).exists()
			if (nativeExists) {
				await exec(`rm -rf ${lucidDir}/native`)
				await exec(
					`cp -r ${tempDir}/repo/packages/lucid-native ${lucidDir}/native`
				)
			}

			// Update package.json to point to local native
			const serverPkgPath = `${lucidDir}/server/package.json`
			const serverPkg = await Bun.file(serverPkgPath).json()
			serverPkg.dependencies = serverPkg.dependencies || {}
			serverPkg.dependencies["@lucid-memory/native"] = "file:../native"
			await Bun.write(serverPkgPath, JSON.stringify(serverPkg, null, 2))

			// Install dependencies
			await exec(`cd ${lucidDir}/server && bun install --production`, {
				timeout: 120000,
			})

			// Clean up
			await exec(`rm -rf ${tempDir}`)
			await exec(`rm -rf ${backupDir}`)

			console.error("[lucid] ✓ Auto-update complete!")
			console.error("[lucid]   Restart Claude Code to use the new version")
		} catch (updateError) {
			// Restore backup if exists
			try {
				const { stdout } = await exec(
					`ls -d ${lucidDir}/server-backup-* 2>/dev/null || true`
				)
				if (stdout.trim()) {
					const latestBackup = stdout.trim().split("\n").pop()
					await exec(`rm -rf ${lucidDir}/server`)
					await exec(`mv ${latestBackup} ${lucidDir}/server`)
				}
			} catch {
				// Ignore restore errors
			}
			await exec(`rm -rf ${tempDir}`)
			throw updateError
		}
	} catch (error) {
		console.error(
			"[lucid] ⚠️  Auto-update failed:",
			error instanceof Error ? error.message : String(error)
		)
		console.error("[lucid]    Run 'lucid update' manually to retry")
	}
}

// === Start Server ===
async function main(): Promise<void> {
	console.error("[lucid] Starting Lucid Memory MCP server...")

	// Load config and initialize retrieval with correct database
	const config = await loadConfig()
	const dbPath = resolveDbPath(config, LUCID_CLIENT)
	console.error(`[lucid] Client: ${LUCID_CLIENT}, Database: ${dbPath}`)

	retrieval = new LucidRetrieval({ dbPath })

	// Initialize embeddings BEFORE accepting connections (fixes race condition)
	await initializeEmbeddings()

	// Start background processors
	startBackgroundEmbeddingProcessor()
	startBackgroundVisualEmbeddingProcessor()
	startBackgroundDecayProcessor()
	startBackgroundConsolidationProcessor()
	startBackgroundSessionPruneProcessor()

	// Check for updates in background (non-blocking)
	void checkForUpdates()

	// Now connect to transport
	const transport = new StdioServerTransport()
	await server.connect(transport)

	// Log native core version if available
	try {
		const native = await import("@lucid-memory/native")
		console.error(`[lucid] Native core: v${native.version()}`)
	} catch {
		console.error("[lucid] Native core: not available (using TS fallback)")
	}

	console.error("[lucid] Server connected. Ready for Claude Code.")
}

let isShuttingDown = false
function shutdown(code = 0): void {
	if (isShuttingDown) return
	isShuttingDown = true
	try {
		if (retrieval) {
			retrieval.close()
		}
	} catch (error) {
		console.error("[lucid] Error during shutdown:", error)
	}
	process.exit(code)
}

process.once("SIGINT", () => shutdown(0))
process.once("SIGTERM", () => shutdown(0))

main().catch((error) => {
	console.error("[lucid] Fatal error:", error)
	shutdown(1)
})
