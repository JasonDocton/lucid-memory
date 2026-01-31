#!/usr/bin/env bun

/**
 * Lucid Memory CLI
 *
 * Simple CLI for hook integration and manual operations.
 *
 * Usage:
 *   lucid context "what I'm working on"      - Get relevant context
 *   lucid store "content" --type learning    - Store a memory
 *   lucid stats                              - Show memory stats
 *   lucid status                             - Check system status
 */

import { detectProvider } from "./embeddings.ts"
import { LucidRetrieval } from "./retrieval.ts"

const args = process.argv.slice(2)
const command = args[0]

async function main() {
	const retrieval = new LucidRetrieval()

	// Try to set up embeddings
	const embeddingConfig = await detectProvider()
	if (embeddingConfig) {
		retrieval.setEmbeddingConfig(embeddingConfig)
	}

	switch (command) {
		case "context": {
			const task = args[1] || ""
			const projectPath = args
				.find((a) => a.startsWith("--project="))
				?.split("=")[1]
			const budgetArg = args
				.find((a) => a.startsWith("--budget="))
				?.split("=")[1]
			// Default: 200 tokens (~800 chars) - conservative to protect user's context
			const tokenBudget = budgetArg ? parseInt(budgetArg, 10) : 200

			if (!task) {
				console.error(
					"Usage: lucid context 'what you're working on' [--project=/path] [--budget=200]"
				)
				process.exit(1)
			}

			let projectId: string | undefined
			if (projectPath) {
				const project = retrieval.storage.getOrCreateProject(projectPath)
				projectId = project.id
			}

			// getContext now handles:
			// 1. Similarity threshold (only strong matches)
			// 2. Token budgeting (respects user's context window)
			// 3. Gist preference (uses compressed semantic essence)
			const context = await retrieval.getContext(task, projectId, {
				tokenBudget,
			})

			if (context.memories.length === 0) {
				// Output nothing - no relevant context (preserves user's tokens)
				process.exit(0)
			}

			// Output context using gists - compressed semantic essence
			console.log("<lucid-context>")
			console.log(context.summary)
			for (const candidate of context.memories) {
				// getContext already filtered by budget, use gist
				const text =
					candidate.memory.gist ?? candidate.memory.content.slice(0, 150)
				console.log(`- [${candidate.memory.type}] ${text}`)
			}
			console.log("</lucid-context>")
			break
		}

		case "store": {
			const content = args[1]
			if (!content) {
				console.error(
					"Usage: lucid store 'content to remember' [--type=learning] [--project=/path]"
				)
				process.exit(1)
			}

			const typeArg = args.find((a) => a.startsWith("--type="))?.split("=")[1]
			const type = (typeArg as any) || "learning"
			const projectPath = args
				.find((a) => a.startsWith("--project="))
				?.split("=")[1]

			let projectId: string | undefined
			if (projectPath) {
				const project = retrieval.storage.getOrCreateProject(projectPath)
				projectId = project.id
			}

			const memory = await retrieval.store(content, { type, projectId })
			console.log(JSON.stringify({ success: true, id: memory.id }))
			break
		}

		case "stats": {
			const stats = retrieval.storage.getStats()
			console.log(`Memories: ${stats.memoryCount}`)
			console.log(`With embeddings: ${stats.embeddingCount}`)
			console.log(`Associations: ${stats.associationCount}`)
			console.log(`Projects: ${stats.projectCount}`)
			console.log(`Database size: ${Math.round(stats.dbSizeBytes / 1024)} KB`)
			break
		}

		case "status": {
			const stats = retrieval.storage.getStats()
			const hasEmbeddings = embeddingConfig !== null
			let ollamaStatus = "not configured"
			let isOllamaHealthy = false
			let embeddingTestResult = "skipped"

			console.log("🧠 Lucid Memory Status")
			console.log("━━━━━━━━━━━━━━━━━━━━━━")
			console.log("")

			// Check Ollama health if configured
			if (embeddingConfig?.provider === "ollama") {
				const ollamaHost =
					embeddingConfig.ollamaHost || "http://localhost:11434"
				try {
					const response = await fetch(`${ollamaHost}/api/tags`, {
						signal: AbortSignal.timeout(3000),
					})
					if (response.ok) {
						ollamaStatus = "running"
						isOllamaHealthy = true

						// Test actual embedding generation
						try {
							const testResponse = await fetch(`${ollamaHost}/api/embeddings`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									model: embeddingConfig.model || "nomic-embed-text",
									prompt: "test",
								}),
								signal: AbortSignal.timeout(10000),
							})
							if (testResponse.ok) {
								embeddingTestResult = "✓ working"
							} else {
								embeddingTestResult = `✗ error: ${testResponse.status}`
							}
						} catch (e: any) {
							embeddingTestResult = `✗ failed: ${e.message}`
						}
					} else {
						ollamaStatus = `error (HTTP ${response.status})`
					}
				} catch (e: any) {
					if (e.name === "TimeoutError") {
						ollamaStatus = "✗ timeout (not responding)"
					} else if (e.cause?.code === "ECONNREFUSED") {
						ollamaStatus = "✗ not running"
					} else {
						ollamaStatus = `✗ error: ${e.message}`
					}
				}
			} else if (embeddingConfig?.provider === "openai") {
				// For OpenAI, just check if key is set
				ollamaStatus = "n/a (using OpenAI)"
				embeddingTestResult = embeddingConfig.openaiApiKey
					? "✓ API key configured"
					: "✗ no API key"
			}

			// Database status
			console.log("Database:")
			console.log(`  Location: ~/.lucid/memory.db`)
			console.log(`  Size: ${Math.round(stats.dbSizeBytes / 1024)} KB`)
			console.log(`  Memories: ${stats.memoryCount}`)
			console.log(`  Associations: ${stats.associationCount}`)
			console.log("")

			// Embedding status
			console.log("Embeddings:")
			if (hasEmbeddings && embeddingConfig) {
				console.log(`  Provider: ${embeddingConfig.provider}`)
				console.log(`  Model: ${embeddingConfig.model || "default"}`)
				if (embeddingConfig.provider === "ollama") {
					console.log(`  Ollama: ${ollamaStatus}`)
				}
				console.log(`  Status: ${embeddingTestResult}`)
			} else {
				console.log("  ✗ No embedding provider configured")
			}
			console.log("")

			// Overall health
			const healthy =
				hasEmbeddings &&
				(isOllamaHealthy || embeddingConfig?.provider === "openai")
			if (healthy) {
				console.log("Overall: ✓ Healthy")
			} else {
				console.log("Overall: ✗ Issues detected")
				console.log("")
				console.log("Troubleshooting:")
				if (!hasEmbeddings) {
					console.log("  - No embedding provider found. Re-run the installer.")
				} else if (embeddingConfig?.provider === "ollama" && !isOllamaHealthy) {
					console.log("  - Ollama is not running. Start it with: ollama serve")
					console.log(
						"  - Or check if the model is installed: ollama pull nomic-embed-text"
					)
				}
			}
			break
		}

		case "help":
		case "--help":
		case "-h":
		default: {
			console.log(`
Lucid Memory CLI

Commands:
  context <task> [--project=/path]   Get relevant context for a task
  store <content> [--type=TYPE]      Store a memory (types: learning, decision, context, bug, solution)
  stats                              Show memory statistics
  status                             Check system status

Examples:
  lucid context "implementing auth" --project=/my/project
  lucid store "Auth uses JWT tokens stored in httpOnly cookies" --type=decision
  lucid status
      `)
			break
		}
	}
}

main().catch((error) => {
	console.error("Error:", error.message)
	process.exit(1)
})
