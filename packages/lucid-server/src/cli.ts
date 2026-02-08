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
 *   lucid backup                             - Backup the memory database
 */

import {
	detectProvider,
	isNativeEmbeddingAvailable,
	loadNativeEmbeddingModel,
} from "./embeddings.ts"
import { LucidRetrieval } from "./retrieval.ts"
import type { MemoryType } from "./storage.ts"

const args = process.argv.slice(2)
const command = args[0]

// Top-level regex for version tag stripping
const versionTagRegex = /^v/

// biome-ignore lint/style/noProcessEnv: CLI requires environment access
const LUCID_DIR = `${process.env.HOME}/.lucid`
// biome-ignore lint/style/noProcessEnv: CLI requires client detection
const LUCID_CLIENT = process.env.LUCID_CLIENT || "claude"

// Multi-client config types
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
	installedAt?: string
}

async function loadConfig(): Promise<LucidConfig> {
	try {
		const configPath = `${LUCID_DIR}/config.json`
		const file = Bun.file(configPath)
		if (await file.exists()) {
			return await file.json()
		}
	} catch {
		// Return empty config on error
	}
	return {}
}

async function saveConfig(config: LucidConfig): Promise<void> {
	const configPath = `${LUCID_DIR}/config.json`
	await Bun.write(configPath, JSON.stringify(config, null, 2))
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

async function main() {
	// Load config and resolve database path
	const config = await loadConfig()
	const dbPath = resolveDbPath(config, LUCID_CLIENT)

	const retrieval = new LucidRetrieval({ dbPath })

	// Pre-load native embedding model before detection
	loadNativeEmbeddingModel()

	// Try to set up embeddings
	const embeddingConfig = await detectProvider()
	if (embeddingConfig) {
		retrieval.setEmbeddingConfig(embeddingConfig)
	}

	switch (command) {
		case "config": {
			const subCommand = args[1]

			switch (subCommand) {
				case "show": {
					console.log("Lucid Memory Configuration")
					console.log("==========================")
					console.log("")
					console.log(`Config file: ${LUCID_DIR}/config.json`)
					console.log(`Current client: ${LUCID_CLIENT}`)
					console.log(`Database path: ${dbPath}`)
					console.log("")

					if (Object.keys(config).length === 0) {
						console.log("No configuration found (using defaults)")
						console.log("")
						console.log("Defaults:")
						console.log("  Database mode: shared")
						console.log("  Database: ~/.lucid/memory.db")
					} else {
						console.log(`Database mode: ${config.databaseMode || "shared"}`)
						console.log(`Auto-update: ${config.autoUpdate ?? false}`)
						if (config.installedAt) {
							console.log(`Installed: ${config.installedAt}`)
						}
						console.log("")

						if (config.clients) {
							console.log("Clients:")
							for (const [name, client] of Object.entries(config.clients)) {
								const status = client.enabled ? "enabled" : "disabled"
								console.log(`  ${name}: ${status}, profile: ${client.profile}`)
							}
							console.log("")
						}

						if (config.profiles) {
							console.log("Profiles:")
							for (const [name, profile] of Object.entries(config.profiles)) {
								console.log(`  ${name}: ${profile.dbPath}`)
							}
						}
					}
					break
				}

				case "set-profile": {
					const clientName = args[2]
					const profileName = args[3]

					if (!clientName || !profileName) {
						console.error("Usage: lucid config set-profile <client> <profile>")
						console.error("Example: lucid config set-profile claude work")
						process.exit(1)
					}

					// Ensure clients object exists
					if (!config.clients) {
						config.clients = {}
					}

					// Get or create client config
					const clientConfig = config.clients[clientName] || {
						enabled: true,
						profile: "default",
					}
					clientConfig.profile = profileName
					config.clients[clientName] = clientConfig

					// Ensure profile exists
					if (!config.profiles) {
						config.profiles = {}
					}
					if (!config.profiles[profileName]) {
						config.profiles[profileName] = {
							dbPath: `~/.lucid/memory-${profileName}.db`,
						}
						console.log(`Created profile '${profileName}'`)
					}

					// Ensure database mode is profiles
					if (config.databaseMode !== "profiles") {
						config.databaseMode = "profiles"
						console.log("Switched to 'profiles' database mode")
					}

					await saveConfig(config)
					console.log(`Set ${clientName} to use profile '${profileName}'`)
					console.log(`Database: ${config.profiles[profileName].dbPath}`)
					break
				}

				case "create-profile": {
					const profileName = args[2]
					const customPath = args
						.find((a) => a.startsWith("--path="))
						?.split("=")[1]

					if (!profileName) {
						console.error(
							"Usage: lucid config create-profile <name> [--path=<dbPath>]"
						)
						console.error("Example: lucid config create-profile work")
						console.error(
							"Example: lucid config create-profile work --path=~/.lucid/work.db"
						)
						process.exit(1)
					}

					// Ensure profiles object exists
					if (!config.profiles) {
						config.profiles = {}
					}

					if (config.profiles[profileName]) {
						console.error(`Profile '${profileName}' already exists`)
						console.error(
							`Current path: ${config.profiles[profileName].dbPath}`
						)
						process.exit(1)
					}

					const dbPathForProfile =
						customPath || `~/.lucid/memory-${profileName}.db`
					config.profiles[profileName] = { dbPath: dbPathForProfile }

					await saveConfig(config)
					console.log(`Created profile '${profileName}'`)
					console.log(`Database: ${dbPathForProfile}`)
					console.log("")
					console.log("To use this profile:")
					console.log(`  lucid config set-profile <client> ${profileName}`)
					break
				}

				case "set-mode": {
					const mode = args[2] as DatabaseMode | undefined

					if (!mode || !["shared", "per-client", "profiles"].includes(mode)) {
						console.error("Usage: lucid config set-mode <mode>")
						console.error("Modes:")
						console.error("  shared     - All clients share one database")
						console.error("  per-client - Each client has its own database")
						console.error("  profiles   - Custom profiles with named databases")
						process.exit(1)
					}

					config.databaseMode = mode
					await saveConfig(config)
					console.log(`Database mode set to '${mode}'`)
					break
				}

				default: {
					console.log(`
Lucid Config Commands

  lucid config show                         Show current configuration
  lucid config set-mode <mode>              Set database mode (shared|per-client|profiles)
  lucid config set-profile <client> <name>  Set profile for a client
  lucid config create-profile <name>        Create a new profile

Examples:
  lucid config show
  lucid config set-mode per-client
  lucid config set-profile codex work
  lucid config create-profile work --path=~/.lucid/work.db
          `)
					break
				}
			}
			break
		}

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
			let embeddingStatus = "not configured"
			let isEmbeddingHealthy = false

			console.log("Lucid Memory Status")
			console.log("━━━━━━━━━━━━━━━━━━━━━━")
			console.log("")

			// Multi-client info
			console.log("Client:")
			console.log(`  Current: ${LUCID_CLIENT}`)
			console.log(`  Mode: ${config.databaseMode || "shared"}`)
			console.log("")

			// Check embedding health based on provider
			if (embeddingConfig?.provider === "native") {
				const modelAvailable = isNativeEmbeddingAvailable()
				if (modelAvailable) {
					embeddingStatus = "ready (in-process ONNX)"
					isEmbeddingHealthy = true
				} else {
					embeddingStatus = "model files missing (~/.lucid/models/)"
				}
			} else if (embeddingConfig?.provider === "ollama") {
				const ollamaHost =
					embeddingConfig.ollamaHost || "http://localhost:11434"
				try {
					const response = await fetch(`${ollamaHost}/api/tags`, {
						signal: AbortSignal.timeout(3000),
					})
					if (response.ok) {
						embeddingStatus = "running (Ollama)"
						isEmbeddingHealthy = true
					} else {
						embeddingStatus = `error (HTTP ${response.status})`
					}
				} catch (e: unknown) {
					if (e instanceof Error) {
						if (e.name === "TimeoutError") {
							embeddingStatus = "timeout (not responding)"
						} else if (
							(e.cause as { code?: string })?.code === "ECONNREFUSED"
						) {
							embeddingStatus = "not running"
						} else {
							embeddingStatus = `error: ${e.message}`
						}
					} else {
						embeddingStatus = `error: ${String(e)}`
					}
				}
			} else if (embeddingConfig?.provider === "openai") {
				embeddingStatus = embeddingConfig.openaiApiKey
					? "ready (OpenAI API)"
					: "no API key"
				isEmbeddingHealthy = !!embeddingConfig.openaiApiKey
			}

			// Database status
			console.log("Database:")
			console.log(`  Location: ${dbPath}`)
			console.log(`  Size: ${Math.round(stats.dbSizeBytes / 1024)} KB`)
			console.log(`  Memories: ${stats.memoryCount}`)
			console.log(`  Associations: ${stats.associationCount}`)
			console.log("")

			// Embedding status
			console.log("Embeddings:")
			if (hasEmbeddings && embeddingConfig) {
				console.log(`  Provider: ${embeddingConfig.provider}`)
				console.log(`  Model: ${embeddingConfig.model || "bge-base-en-v1.5"}`)
				console.log(
					`  Status: ${isEmbeddingHealthy ? "✓" : "✗"} ${embeddingStatus}`
				)
				const totalPending =
					stats.pendingEmbeddingCount + stats.pendingVisualEmbeddingCount
				if (totalPending > 0) {
					const parts: string[] = []
					if (stats.pendingEmbeddingCount > 0)
						parts.push(`${stats.pendingEmbeddingCount} text`)
					if (stats.pendingVisualEmbeddingCount > 0)
						parts.push(`${stats.pendingVisualEmbeddingCount} visual`)
					const estimatedSeconds = Math.ceil(totalPending / 10) * 5
					console.log(
						`  Pending: ${parts.join(" + ")} memories awaiting embedding (~${estimatedSeconds}s)`
					)
				} else {
					console.log("  Coverage: all memories embedded")
				}
			} else {
				console.log("  ✗ No embedding provider configured")
			}
			console.log("")

			// Video processing dependencies
			console.log("Video Processing:")
			const { execSync } = await import("node:child_process")
			const fs = await import("node:fs")
			const path = await import("node:path")
			const os = await import("node:os")

			const checkCommand = (cmd: string): boolean => {
				try {
					execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, {
						stdio: "pipe",
					})
					return true
				} catch {
					return false
				}
			}

			// Check for whisper in Python user bin directories (pip --user installs here)
			const checkWhisper = (): boolean => {
				if (checkCommand("whisper")) return true

				// Check common pip user bin locations
				const home = os.homedir()
				const platform = process.platform

				const possiblePaths: string[] = []

				if (platform === "darwin") {
					// macOS: ~/Library/Python/3.X/bin/whisper
					for (const ver of ["3.13", "3.12", "3.11", "3.10", "3.9", "3.8"]) {
						possiblePaths.push(
							path.join(home, "Library", "Python", ver, "bin", "whisper")
						)
					}
				} else if (platform === "linux") {
					// Linux: ~/.local/bin/whisper
					possiblePaths.push(path.join(home, ".local", "bin", "whisper"))
				} else if (platform === "win32") {
					// Windows: %APPDATA%\Python\PythonXX\Scripts\whisper.exe
					const appData =
						// biome-ignore lint/style/noProcessEnv: CLI requires environment access
						process.env.APPDATA || path.join(home, "AppData", "Roaming")
					for (const ver of ["313", "312", "311", "310", "39", "38"]) {
						possiblePaths.push(
							path.join(
								appData,
								"Python",
								`Python${ver}`,
								"Scripts",
								"whisper.exe"
							)
						)
					}
				}

				for (const p of possiblePaths) {
					try {
						if (fs.existsSync(p)) return true
					} catch {
						// ignore
					}
				}

				return false
			}

			const hasFfmpeg = checkCommand("ffmpeg")
			const hasYtdlp = checkCommand("yt-dlp")
			const hasWhisper = checkWhisper()

			console.log(`  ffmpeg: ${hasFfmpeg ? "✓ installed" : "✗ missing"}`)
			console.log(`  yt-dlp: ${hasYtdlp ? "✓ installed" : "✗ missing"}`)
			console.log(`  whisper: ${hasWhisper ? "✓ installed" : "✗ missing"}`)
			console.log("")

			// Overall health
			const videoHealthy = hasFfmpeg && hasYtdlp && hasWhisper
			const healthy = hasEmbeddings && isEmbeddingHealthy && videoHealthy
			if (healthy) {
				console.log("Overall: ✓ Healthy")
			} else {
				console.log("Overall: ✗ Issues detected")
				console.log("")
				console.log("Troubleshooting:")
				if (!hasEmbeddings) {
					console.log("  - No embedding provider found. Re-run the installer.")
				} else if (
					embeddingConfig?.provider === "native" &&
					!isEmbeddingHealthy
				) {
					console.log(
						"  - Native model files missing. Re-run the installer to download BGE model."
					)
				} else if (
					embeddingConfig?.provider === "ollama" &&
					!isEmbeddingHealthy
				) {
					console.log("  - Ollama is not running. Start it with: ollama serve")
				}
				if (!hasFfmpeg) {
					console.log(
						"  - ffmpeg missing. Install with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)"
					)
				}
				if (!hasYtdlp) {
					console.log("  - yt-dlp missing. Install with: pip install yt-dlp")
				}
				if (!hasWhisper) {
					console.log(
						"  - whisper missing. Install with: pip install openai-whisper"
					)
				}
			}
			break
		}

		case "update": {
			const REPO = "JasonDocton/lucid-memory"
			// biome-ignore lint/style/noProcessEnv: CLI requires environment access
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
					const latestVersion =
						release.tag_name?.replace(versionTagRegex, "") || "unknown"
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

				const { promisify } = await import("node:util")
				const exec = promisify((await import("node:child_process")).exec)

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
					const backups = await exec(
						`ls -d ${LUCID_DIR}/server-backup-* 2>/dev/null || true`
					)
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
				console.log("  curl -fsSL https://lucidmemory.dev/install | bash")
				process.exit(1)
			}
			break
		}

		case "version": {
			// biome-ignore lint/style/noProcessEnv: CLI requires environment access
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

		case "backup": {
			const { copyFileSync, statSync } = await import("node:fs")
			const { join } = await import("node:path")
			const { homedir } = await import("node:os")

			const lucidDir = join(homedir(), ".lucid")
			// Use the config-aware dbPath from earlier in main()
			const backupSource = dbPath

			// Check if database exists
			try {
				statSync(backupSource)
			} catch {
				console.error(`No database found at ${backupSource}`)
				process.exit(1)
			}

			// Determine output path
			const outputArg = args
				.find((a) => a.startsWith("--output="))
				?.split("=")[1]
			const timestamp = new Date()
				.toISOString()
				.replace(/[:.]/g, "-")
				.slice(0, 19)
			const defaultBackupPath = join(lucidDir, `memory-backup-${timestamp}.db`)
			const backupDest = outputArg || defaultBackupPath

			try {
				copyFileSync(backupSource, backupDest)
				const backupSize = statSync(backupDest).size
				const sizeKB = Math.round(backupSize / 1024)

				console.log("✓ Backup created")
				console.log(`  Location: ${backupDest}`)
				console.log(`  Size: ${sizeKB} KB`)
				console.log("")
				console.log("To restore, copy the backup over the original:")
				console.log(`  cp "${backupDest}" "${backupSource}"`)
			} catch (error) {
				console.error(
					"Backup failed:",
					error instanceof Error ? error.message : String(error)
				)
				process.exit(1)
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

  config show                        Show current configuration
  config set-mode <mode>             Set database mode (shared|per-client|profiles)
  config set-profile <client> <name> Set profile for a client
  config create-profile <name>       Create a new profile

  stats                              Show memory statistics
  status                             Check system status
  update                             Check for and install updates
  backup [--output=path]             Backup the memory database
  version                            Show current version

Examples:
  lucid context "implementing auth" --project=/my/project
  lucid store "Auth uses JWT tokens" --type=decision
  lucid config show
  lucid config set-profile codex work
  lucid backup
  lucid backup --output=~/my-backup.db

Multi-Client Support:
  Set LUCID_CLIENT env var to switch between clients (claude, codex).
  Use 'lucid config' commands to manage profiles and database isolation.

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
