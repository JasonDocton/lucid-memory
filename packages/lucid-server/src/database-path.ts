import { homedir } from "node:os"
import { join } from "node:path"

export const LUCID_DIR = join(homedir(), ".lucid")

const databaseModes = {
	shared: "shared",
	perClient: "per-client",
	profiles: "profiles",
} as const

export type DatabaseMode = (typeof databaseModes)[keyof typeof databaseModes]

interface ClientConfig {
	enabled: boolean
	profile: string
}

interface ProfileConfig {
	dbPath: string
}

export interface LucidConfig {
	autoUpdate?: boolean
	databaseMode?: DatabaseMode
	clients?: Record<string, ClientConfig>
	profiles?: Record<string, ProfileConfig>
	installedAt?: string
}

export function resolveDbPath(config: LucidConfig, client: string): string {
	const mode = config.databaseMode || "shared"

	if (mode === "per-client") {
		return `${LUCID_DIR}/memory-${client}.db`
	}

	if (mode === "profiles") {
		const clientConfig = config.clients?.[client]
		const profileName = clientConfig?.profile || "default"
		const profile = config.profiles?.[profileName]
		const rawPath = profile?.dbPath || `${LUCID_DIR}/memory.db`
		const home = homedir()
		return rawPath.startsWith("~") ? rawPath.replace("~", home) : rawPath
	}

	return `${LUCID_DIR}/memory.db`
}
