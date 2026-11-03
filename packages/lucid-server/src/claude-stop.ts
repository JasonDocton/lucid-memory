import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { LUCID_DIR, type LucidConfig, resolveDbPath } from "./database-path.ts"
import { LucidStorage } from "./storage.ts"

/** Persist an observed final reply without reconsolidating an existing memory. */
export async function captureStop(input: string): Promise<void> {
	const event = JSON.parse(input)
	if (
		event?.hook_event_name !== "Stop" ||
		typeof event.last_assistant_message !== "string"
	)
		return
	const promptId = event.prompt_id ?? event.turn_id
	if (
		typeof promptId !== "string" ||
		!promptId ||
		typeof event.session_id !== "string" ||
		!event.session_id
	)
		return
	if (typeof event.cwd !== "string" || !isAbsolute(event.cwd)) return

	const reply = event.last_assistant_message.trim()
	if (!reply) return
	// Hash the full reply before truncation so distinct continuations stay distinct.
	const key = createHash("sha256")
		.update(JSON.stringify([event.session_id, promptId, reply]))
		.digest("hex")
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
		const client = config.clients.claude
		if (client === undefined || client?.enabled === false) return
		if (
			client?.enabled !== true ||
			(client.profile !== undefined &&
				(typeof client.profile !== "string" || !client.profile))
		)
			throw new Error("Invalid Claude client configuration")
	}
	if (
		config.databaseMode !== undefined &&
		!["shared", "per-client", "profiles"].includes(config.databaseMode)
	)
		throw new Error("Unknown Lucid database mode")
	if (config.databaseMode === "profiles") {
		const profile =
			config.profiles?.[config.clients?.claude?.profile ?? "default"]
		if (typeof profile?.dbPath !== "string" || !profile.dbPath)
			throw new Error("Missing Claude profile database path")
	}
	const dbPath = resolveDbPath(config, "claude")
	if (!isAbsolute(dbPath)) throw new Error("Expected an absolute database path")

	const storage = new LucidStorage({ dbPath })
	try {
		storage.storeAssistantReply(
			key,
			event.cwd,
			Array.from(reply).slice(0, 2000).join("")
		)
	} finally {
		storage.close()
	}
}
