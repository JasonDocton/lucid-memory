import { lstat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { LUCID_DIR, type LucidConfig, resolveDbPath } from "./database-path.ts"
import { LucidStorage } from "./storage.ts"

export async function openCaptureStorage(clientName: "claude" | "codex") {
	const configPath = join(LUCID_DIR, "config.json")
	const file = Bun.file(configPath)
	let config: LucidConfig = {}
	try {
		config = await file.json()
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		// A broken link to a private profile configuration is not a configless installation.
		const entry = await lstat(configPath).catch(
			(statError: NodeJS.ErrnoException) => {
				if (statError.code !== "ENOENT") throw statError
				return undefined
			}
		)
		if (entry) throw error
	}
	if (config === null || typeof config !== "object" || Array.isArray(config))
		throw new Error("Invalid Lucid configuration")
	if (config.clients !== undefined) {
		if (
			config.clients === null ||
			typeof config.clients !== "object" ||
			Array.isArray(config.clients)
		)
			throw new Error("Invalid Lucid clients")
		const client = config.clients[clientName]
		if (client === undefined || client?.enabled === false) return
		if (
			client?.enabled !== true ||
			(client.profile !== undefined &&
				(typeof client.profile !== "string" || !client.profile))
		)
			throw new Error("Invalid capture client configuration")
	}
	if (
		config.databaseMode !== undefined &&
		!["shared", "per-client", "profiles"].includes(config.databaseMode)
	)
		throw new Error("Unknown Lucid database mode")
	if (config.databaseMode === "profiles") {
		const profile =
			config.profiles?.[config.clients?.[clientName]?.profile ?? "default"]
		if (typeof profile?.dbPath !== "string" || !profile.dbPath)
			throw new Error("Missing capture profile database path")
	}
	const dbPath = resolveDbPath(config, clientName)
	if (!isAbsolute(dbPath)) throw new Error("Expected an absolute database path")

	return new LucidStorage({ dbPath })
}
