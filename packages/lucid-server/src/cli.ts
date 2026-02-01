#!/usr/bin/env bun

/**
 * Lucid Memory CLI
 *
 * Simple CLI for hook integration and manual operations.
 *
 * Usage:
 *   lucid context "what I'm working on"      - Get relevant context (includes visual memories)
 *   lucid store "content" --type learning    - Store a memory
 *   lucid stats                              - Show memory stats
 *   lucid status                             - Check system status
 */

import { detectProvider } from "./embeddings.ts"
import { LucidRetrieval } from "./retrieval.ts"
import type { MemoryType } from "./storage.ts"

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
			const visualRatioArg = args
				.find((a) => a.startsWith("--visual-ratio="))
				?.split("=")[1]
			// Default: 200 tokens (~800 chars) - conservative to protect user's context
			const tokenBudget = budgetArg ? Number.parseInt(budgetArg, 10) : 200
			// Default: 30% of budget for visual memories
			const visualRatio = visualRatioArg
				? Number.parseFloat(visualRatioArg)
				: 0.3

			if (!task) {
				console.error(
					"Usage: lucid context 'what you're working on' [--project=/path] [--budget=200] [--visual-ratio=0.3]"
				)
				process.exit(1)
			}

			let projectId: string | undefined
			if (projectPath) {
				const project = retrieval.storage.getOrCreateProject(projectPath)
				projectId = project.id
			}

			// Get unified context with both text and visual memories
			const context = await retrieval.getContextWithVisuals(task, projectId, {
				tokenBudget,
				visualRatio,
			})

			if (
				context.memories.length === 0 &&
				context.visualMemories.length === 0
			) {
				// Output nothing - no relevant context (preserves user's tokens)
				process.exit(0)
			}

			// Output context using gists - compressed semantic essence
			console.log("<lucid-context>")
			console.log(context.summary)

			// Text memories
			for (const candidate of context.memories) {
				const text =
					candidate.memory.gist ?? candidate.memory.content.slice(0, 150)
				console.log(`- [${candidate.memory.type}] ${text}`)
			}

			// Visual memories
			for (const candidate of context.visualMemories) {
				console.log(
					`- [Visual, ${candidate.visual.mediaType}] ${candidate.visual.description}`
				)
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
			const type = (typeArg as MemoryType) || "learning"
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
			console.log(`Visual memories: ${stats.visualMemoryCount}`)
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
						} catch (e: unknown) {
							const message = e instanceof Error ? e.message : String(e)
							embeddingTestResult = `✗ failed: ${message}`
						}
					} else {
						ollamaStatus = `error (HTTP ${response.status})`
					}
				} catch (e: unknown) {
					if (e instanceof Error) {
						if (e.name === "TimeoutError") {
							ollamaStatus = "✗ timeout (not responding)"
						} else if (
							(e.cause as { code?: string })?.code === "ECONNREFUSED"
						) {
							ollamaStatus = "✗ not running"
						} else {
							ollamaStatus = `✗ error: ${e.message}`
						}
					} else {
						ollamaStatus = `✗ error: ${String(e)}`
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

		case "update": {
			const REPO = "JasonDocton/lucid-memory"
			const LUCID_DIR = `${process.env.HOME}/.lucid`

			console.log("🧠 Lucid Memory Update")
			console.log("━━━━━━━━━━━━━━━━━━━━━━")
			console.log("")

			// Get current version
			let currentVersion = "unknown"
			try {
				const pkgPath = `${LUCID_DIR}/server/package.json`
				const pkg = await Bun.file(pkgPath).json()
				currentVersion = pkg.version || "unknown"
			} catch {
				// Can't read current version
			}
			console.log(`Current version: ${currentVersion}`)

			// Check latest version from GitHub
			console.log("Checking for updates...")
			try {
				const response = await fetch(
					`https://api.github.com/repos/${REPO}/releases/latest`,
					{
						headers: { Accept: "application/vnd.github.v3+json" },
						signal: AbortSignal.timeout(10000),
					}
				)

				if (!response.ok) {
					// No releases yet, check package.json in main branch
					const pkgResponse = await fetch(
						`https://raw.githubusercontent.com/${REPO}/main/packages/lucid-server/package.json`,
						{ signal: AbortSignal.timeout(10000) }
					)
					if (pkgResponse.ok) {
						const remotePkg = await pkgResponse.json()
						const latestVersion = remotePkg.version || "unknown"
						console.log(`Latest version:  ${latestVersion}`)

						if (currentVersion === latestVersion) {
							console.log("")
							console.log("✓ You're already on the latest version!")
							break
						}
					}
				} else {
					const release = await response.json()
					const latestVersion = release.tag_name?.replace(/^v/, "") || "unknown"
					console.log(`Latest version:  ${latestVersion}`)

					if (currentVersion === latestVersion) {
						console.log("")
						console.log("✓ You're already on the latest version!")
						break
					}
				}

				// Perform update
				console.log("")
				console.log("Downloading update...")

				const { spawn } = await import("node:child_process")
				const { promisify } = await import("node:util")
				const exec = promisify(
					(await import("node:child_process")).exec
				)

				// Create temp directory and clone
				const tempDir = `${LUCID_DIR}/update-tmp-${Date.now()}`
				await exec(`mkdir -p ${tempDir}`)

				try {
					// Clone latest
					await exec(
						`git clone --depth 1 https://github.com/${REPO}.git ${tempDir}/repo`,
						{ timeout: 60000 }
					)

					// Backup current server (preserve symlinks and configs)
					const backupDir = `${LUCID_DIR}/server-backup-${Date.now()}`
					await exec(`mv ${LUCID_DIR}/server ${backupDir}`)

					// Copy new server
					await exec(
						`cp -r ${tempDir}/repo/packages/lucid-server ${LUCID_DIR}/server`
					)

					// Copy new native package if exists
					if (
						await Bun.file(`${tempDir}/repo/packages/lucid-native`).exists()
					) {
						await exec(`rm -rf ${LUCID_DIR}/native`)
						await exec(
							`cp -r ${tempDir}/repo/packages/lucid-native ${LUCID_DIR}/native`
						)
					}

					// Update package.json to point to local native
					const serverPkgPath = `${LUCID_DIR}/server/package.json`
					const serverPkg = await Bun.file(serverPkgPath).json()
					serverPkg.dependencies = serverPkg.dependencies || {}
					serverPkg.dependencies["@lucid-memory/native"] = "file:../native"
					await Bun.write(serverPkgPath, JSON.stringify(serverPkg, null, 2))

					// Install dependencies
					console.log("Installing dependencies...")
					await exec(`cd ${LUCID_DIR}/server && bun install --production`, {
						timeout: 120000,
					})

					// Clean up
					await exec(`rm -rf ${tempDir}`)
					await exec(`rm -rf ${backupDir}`)

					console.log("")
					console.log("✓ Update complete!")
					console.log("")
					console.log("Please restart Claude Code to use the new version.")
				} catch (updateError) {
					// Restore backup if exists
					const backups = await exec(`ls -d ${LUCID_DIR}/server-backup-* 2>/dev/null || true`)
					if (backups.stdout.trim()) {
						const latestBackup = backups.stdout.trim().split("\n").pop()
						await exec(`rm -rf ${LUCID_DIR}/server`)
						await exec(`mv ${latestBackup} ${LUCID_DIR}/server`)
					}
					await exec(`rm -rf ${tempDir}`)
					throw updateError
				}
			} catch (error) {
				console.error(
					"Update failed:",
					error instanceof Error ? error.message : String(error)
				)
				console.log("")
				console.log("You can update manually by running:")
				console.log("  curl -fsSL lucidmemory.dev/install | bash")
				process.exit(1)
			}
			break
		}

		case "version": {
			const LUCID_DIR = `${process.env.HOME}/.lucid`
			try {
				const pkgPath = `${LUCID_DIR}/server/package.json`
				const pkg = await Bun.file(pkgPath).json()
				console.log(pkg.version || "unknown")
			} catch {
				console.log("unknown")
			}
			break
		}

		default: {
			console.log(`
Lucid Memory CLI

Commands:
  context <task> [options]           Get relevant context (text + visual memories)
    --project=/path                  Filter by project
    --budget=200                     Token budget (default: 200)
    --visual-ratio=0.3               Ratio for visual memories (default: 0.3)

  store <content> [options]          Store a memory
    --type=TYPE                      Type: learning, decision, context, bug, solution
    --project=/path                  Associate with project

  stats                              Show memory statistics
  status                             Check system status
  update                             Check for and install updates
  version                            Show current version

Examples:
  lucid context "implementing auth" --project=/my/project
  lucid store "Auth uses JWT tokens" --type=decision
  lucid update

Visual memories are automatically created when images/videos are shared.
They are automatically retrieved via semantic search on the context command.
      `)
			break
		}
	}
}

main().catch((error) => {
	console.error("Error:", error.message)
	process.exit(1)
})
