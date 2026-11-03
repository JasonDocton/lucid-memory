// Installer entry point for registering and removing the selected clients.

import { lstat, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { env } from "node:process"
import { isDeepStrictEqual } from "node:util"
import {
	configureClaudeHook,
	readOptional,
	replaceFile,
} from "./claude-hook.ts"

const lucid = join(homedir(), ".lucid")
const server = join(lucid, "server")
const notifyFile = join(server, "src", "codex-notify.ts")
const prefix = [
	"bun",
	"run",
	`--config=${join(server, "hooks", "notify.bunfig.toml")}`,
	`--tsconfig-override=${join(server, "tsconfig.json")}`,
	"--no-env-file",
	"--no-install",
	notifyFile,
]
const legacyNotify = join(lucid, "hooks", "codex-notify.sh")
const tableName = "mcp_servers.lucid-memory"
const bom = /^\uFEFF/
const lines = /[^\n]*\n|[^\n]+$/g

function tableKeys(header: object) {
	const keys: string[] = []
	let node = header
	for (;;) {
		const next = Object.entries(node)[0]
		if (!next) break
		const [key, child] = next
		keys.push(key)
		node = Array.isArray(child) ? child[0] : child
	}
	return keys
}

function notifyCommand(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every((arg) => typeof arg === "string"))
		throw new Error("Invalid Codex notify command")
	return value
}

function unrelated(config: Record<string, unknown>) {
	const { notify: _notify, mcp_servers, ...rest } = config
	if (mcp_servers && typeof mcp_servers === "object") {
		const servers = { ...mcp_servers } as Record<string, unknown>
		delete servers["lucid-memory"]
		if (Object.keys(servers).length) rest.mcp_servers = servers
	}
	return rest
}

function isLegacyNotifier(command: unknown) {
	if (!Array.isArray(command)) return false
	const path = command.at(-1)
	return (
		(path === legacyNotify || path === "~/.lucid/hooks/codex-notify.sh") &&
		(command.length === 1 ||
			(command.length === 2 && ["bash", "/bin/bash"].includes(command[0])))
	)
}

export function editCodexConfig(input: string, install: boolean) {
	let table: string[] = []
	let remaining = "",
		parentExtras = "",
		envExtras = "",
		current = ""
	let previous: string[] | undefined,
		notifyLine = "",
		managed = false
	const end = input.includes("\r\n") ? "\r\n" : "\n"
	const text = input.replace(bom, "")
	if (
		!install &&
		!text.includes("lucid-memory") &&
		!text.includes("codex-notify")
	)
		return input
	// Parse complete TOML statements. A table-looking line inside a multiline value is data.
	for (const line of text.match(lines) ?? []) {
		current += line
		const raw = current.trimStart()
		let parsed: Record<string, unknown>
		try {
			// Old Windows installers emitted an unescaped drive path in this exact field.
			if (
				table.join(".") === tableName &&
				raw.trim() === `command = "${join(lucid, "bin", "lucid-server.cmd")}"`
			)
				parsed = { command: join(lucid, "bin", "lucid-server.cmd") }
			else parsed = Bun.TOML.parse(current) as Record<string, unknown>
		} catch {
			continue
		}
		const header = raw.startsWith("[")
		if (header) table = tableKeys(parsed)
		const owned = table[0] === "mcp_servers" && table[1] === "lucid-memory"
		if (owned) {
			managed = true
			if (install) {
				const parent = table.length === 2
				const environment = table.length === 3 && table[2] === "env"
				if (!parent && !environment) remaining += current
				else if (!header) {
					if (parent && Object.hasOwn(parsed, "url"))
						throw new Error(
							"An HTTP MCP server already uses the lucid-memory name"
						)
					if (
						parent &&
						!["command", "args", "enabled"].some((key) => key in parsed)
					)
						parentExtras += current
					if (
						environment &&
						!("LUCID_CLIENT" in parsed) &&
						!isLegacyNotifier(parsed.notify)
					)
						envExtras += current
				}
			}
		} else if (table.length === 0 && Object.hasOwn(parsed, "notify")) {
			if (previous !== undefined)
				throw new Error("Duplicate top-level Codex notify")
			previous = notifyCommand(parsed.notify)
			notifyLine = current
		} else remaining += current
		current = ""
	}
	if (current.trim())
		throw new Error("Cannot safely read the existing Codex TOML")
	const wasOurs =
		previous &&
		prefix.every((v, i) => previous?.[i] === v) &&
		(previous.length === prefix.length ||
			previous[prefix.length] === "--forward")
	const legacy = isLegacyNotifier(previous)
	if (!install && !managed && !wasOurs && !legacy) return input
	let restored = previous
	if (wasOurs && previous)
		restored =
			previous.length === prefix.length
				? undefined
				: previous.slice(prefix.length + 1)
	if (legacy) restored = undefined
	const command = install
		? [...prefix, ...(restored ? ["--forward", ...restored] : [])]
		: restored
	const rootNotify =
		!install && !wasOurs && !legacy
			? notifyLine
			: command
				? `notify = ${JSON.stringify(command)}${end}`
				: ""
	let result = rootNotify + remaining.trimEnd()
	if (install) {
		const { command: mcp, args } = serverCommand()
		result += [
			"",
			"",
			`[${tableName}]`,
			"enabled = true",
			`command = ${JSON.stringify(mcp)}`,
			`args = ${JSON.stringify(args)}`,
			parentExtras.trimEnd(),
			`[${tableName}.env]`,
			'LUCID_CLIENT = "codex"',
			envExtras.trimEnd(),
		].join(end)
	}
	result = `${result.trimEnd()}${end}`
	const check = Bun.TOML.parse(result) as {
		notify?: unknown
		mcp_servers?: Record<string, { env?: { LUCID_CLIENT?: string } }>
	}
	if (
		!isDeepStrictEqual(check.notify, command) ||
		(install
			? check.mcp_servers?.["lucid-memory"]?.env?.LUCID_CLIENT !== "codex"
			: check.mcp_servers?.["lucid-memory"] !== undefined)
	)
		throw new Error("Could not safely edit the Codex config")
	// Older installers could emit duplicate Lucid tables. For valid inputs, also
	// verify that every unrelated TOML setting kept the same value.
	let original: object | undefined
	try {
		original = Bun.TOML.parse(text)
	} catch {
		/* Legacy Lucid entries were repaired above. */
	}
	if (
		original &&
		!isDeepStrictEqual(
			unrelated(original as Record<string, unknown>),
			unrelated(check)
		)
	)
		throw new Error("Refusing to change unrelated Codex settings")
	if (input.startsWith("\uFEFF")) result = `\uFEFF${result}`
	return result
}

async function editConfig(
	location: string,
	install: boolean,
	edit: (text: string) => string | Promise<string>,
	checkOnly = false
) {
	const entry = await lstat(location).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error
		return undefined
	})
	const path = entry ? await realpath(location) : location
	const old = await readOptional(path)
	const updated = await edit(old ?? "")
	if (checkOnly || updated === (old ?? "")) return
	const mode = entry ? (await stat(path)).mode & 0o777 : 0o600
	if (install && old !== undefined) {
		const backup = `${path}.backup`
		await replaceFile(backup, old, await readOptional(backup), mode)
	}
	await replaceFile(path, updated, old, mode)
}

function serverCommand() {
	return process.platform === "win32"
		? {
				command: "powershell.exe",
				args: [
					"-NoProfile",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					join(server, "bin", "lucid-server-wrapper.ps1"),
				],
			}
		: { command: join(lucid, "bin", "lucid-server"), args: [] as string[] }
}

function editClaudeMcp(text: string, install: boolean) {
	const config = text ? JSON.parse(text.replace(bom, "")) : {}
	if (!config || typeof config !== "object" || Array.isArray(config))
		throw new Error("Invalid Claude MCP config")
	const servers = config.mcpServers ?? {}
	if (!servers || typeof servers !== "object" || Array.isArray(servers))
		throw new Error("Invalid Claude MCP servers")
	const old = servers["lucid-memory"]
	if (install) {
		if (old && (typeof old !== "object" || Array.isArray(old) || old.url))
			throw new Error(
				"A different MCP server already uses the lucid-memory name"
			)
		const next = {
			...old,
			type: "stdio",
			...serverCommand(),
			env: { ...old?.env, LUCID_CLIENT: "claude" },
		}
		if (isDeepStrictEqual(old, next)) return text
		servers["lucid-memory"] = next
		config.mcpServers = servers
	} else {
		if (old === undefined) return text
		delete servers["lucid-memory"]
	}
	return `${JSON.stringify(config, null, 2)}\n`
}

async function configureClient(
	client: string,
	mode: "install" | "uninstall",
	checkOnly = false
) {
	const install = mode === "install"
	if (client === "claude") {
		await editConfig(
			join(env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json"),
			install,
			(text) => editClaudeMcp(text, install),
			checkOnly
		)
		await configureClaudeHook(mode, checkOnly)
	} else if (client === "codex") {
		await editConfig(
			join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"),
			install,
			(text) => editCodexConfig(text, install),
			checkOnly
		)
	} else throw new Error("Expected claude or codex")
}

async function selectClients(
	mode: string | undefined,
	autoUpdate: string | undefined,
	choices: string[]
) {
	if (
		!mode ||
		!["shared", "per-client", "profiles"].includes(mode) ||
		!["true", "false"].includes(autoUpdate?.toLowerCase() ?? "")
	)
		throw new Error("Invalid installer database or update choice")
	const selected = new Map<string, string>()
	for (const pair of choices) {
		const i = pair.indexOf("=")
		const name = pair.slice(0, i),
			profile = pair.slice(i + 1)
		if (i < 0 || !["claude", "codex", "opencode"].includes(name) || !profile)
			throw new Error("Invalid client selection")
		selected.set(name, profile)
	}
	if (!selected.size) throw new Error("No clients selected")
	await editConfig(join(lucid, "config.json"), false, async (text) => {
		const old = text ? JSON.parse(text.replace(bom, "")) : {}
		if (!old || typeof old !== "object" || Array.isArray(old))
			throw new Error("Invalid Lucid config")
		const clients: Record<string, { enabled: boolean; profile: string }> = {}
		const profiles = Object.assign(Object.create(null), old.profiles)
		profiles.default ??= { dbPath: "~/.lucid/memory.db" }
		// A one-client install did not prompt for database settings. Keep an existing choice.
		const retainMode =
			selected.size === 1 &&
			["shared", "per-client", "profiles"].includes(old.databaseMode)
		for (const [name, choice] of selected) {
			const profile = retainMode
				? old.clients?.[name]?.profile || choice
				: choice
			clients[name] = { ...old.clients?.[name], enabled: true, profile }
			profiles[profile] ??= { dbPath: `~/.lucid/memory-${profile}.db` }
		}
		const actions: [string, "install" | "uninstall"][] = []
		for (const name of ["claude", "codex"]) {
			if (selected.has(name)) actions.unshift([name, "install"])
			else if (old.clients?.[name]?.enabled === true)
				actions.push([name, "uninstall"])
		}
		// Validate both clients before changing either user's settings.
		for (const [client, mode] of actions)
			await configureClient(client, mode, true)
		for (const [client, mode] of actions) await configureClient(client, mode)
		return `${JSON.stringify({ ...old, installedAt: old.installedAt ?? new Date().toISOString(), databaseMode: retainMode ? old.databaseMode : mode, autoUpdate: autoUpdate?.toLowerCase() === "true", clients, profiles }, null, 2)}\n`
	})
}

if (import.meta.main) {
	try {
		const [action, first, second, ...choices] = process.argv.slice(2)
		if (action === "select") await selectClients(first, second, choices)
		else if (first === "install" || first === "uninstall")
			await configureClient(action ?? "", first)
		else throw new Error("Invalid client setup operation")
	} catch (error) {
		console.error(
			"Could not configure the selected Lucid client:",
			error instanceof Error ? error.message : String(error)
		)
		process.exitCode = 1
	}
}
