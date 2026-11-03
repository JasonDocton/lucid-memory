import { afterEach, beforeEach, expect, test } from "bun:test"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { LucidStorage } from "./storage.ts"

const src = resolve(import.meta.dir, "..")
let home: string
let env: Record<string, string>
let path: string
let directory: string
function run(action: "install" | "uninstall") {
	return Bun.spawnSync(
		[process.execPath, join(src, "src", "client-setup.ts"), "codex", action],
		{ env, cwd: directory }
	)
}
function config() {
	return Bun.TOML.parse(readFileSync(path, "utf8")) as {
		notify: string[]
		mcp_servers: Record<
			string,
			{ command: string; args?: string[]; env?: Record<string, string> }
		>
	}
}
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "lucid codex-"))
	directory = join(home, "project = one")
	const root = join(home, ".lucid")
	const codex = join(home, "codex config")
	mkdirSync(directory)
	mkdirSync(root)
	mkdirSync(codex)
	symlinkSync(src, join(root, "server"), "junction")
	path = join(codex, "config.toml")
	env = {
		HOME: home,
		USERPROFILE: home,
		CODEX_HOME: codex,
		LUCID_CLIENT: "claude",
	}
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

test("installs one root notifier, retains an existing notifier and isolates the Codex profile", () => {
	const receipt = join(home, "receipt")
	const previous = [
		process.execPath,
		"-e",
		`await Bun.write(${JSON.stringify(receipt)},JSON.stringify([process.cwd(),process.argv.at(-1)]))`,
	]
	const unrelated = '# other MCP\n[mcp_servers.team]\ncommand = "something"\n'
	writeFileSync(path, `notify = ${JSON.stringify(previous)}\n${unrelated}`)
	expect(run("install").exitCode).toBe(0)
	const once = readFileSync(path, "utf8")
	expect(run("install").exitCode).toBe(0)
	expect(readFileSync(path, "utf8")).toBe(once)
	expect(once).toContain(unrelated.trimEnd())
	const { notify, mcp_servers } = config()
	expect(mcp_servers["lucid-memory"]?.env).toEqual({ LUCID_CLIENT: "codex" })
	expect(notify.slice(-previous.length)).toEqual(previous)
	writeFileSync(
		join(home, ".lucid", "config.json"),
		JSON.stringify({
			databaseMode: "per-client",
			clients: { codex: { enabled: true } },
		})
	)
	const input = JSON.stringify({
		type: "agent-turn-complete",
		"thread-id": "session",
		"turn-id": "turn",
		cwd: directory,
		"input-messages": ["first question", "second line"],
		"last-assistant-message": "A short answer.",
	})
	for (let i = 0; i < 2; i++) {
		const child = Bun.spawnSync([process.execPath, ...notify.slice(1), input], {
			env,
			cwd: directory,
		})
		expect(child.exitCode).toBe(0)
	}
	expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual([
		realpathSync(directory),
		input,
	])
	const storage = new LucidStorage({
		dbPath: join(home, ".lucid", "memory-codex.db"),
	})
	try {
		const rows = storage.getAllForRetrieval(
			storage.getOrCreateProject(directory).id
		).memories
		expect(rows).toHaveLength(2)
		expect(rows.map((m) => m.content).sort()).toEqual([
			"A short answer.",
			"first question\nsecond line",
		])
		expect(rows.every((m) => m.tags.includes("codex"))).toBe(true)
	} finally {
		storage.close()
	}
	expect(existsSync(join(home, ".lucid", "memory-claude.db"))).toBe(false)
	expect(run("uninstall").exitCode).toBe(0)
	expect(config().notify).toEqual(previous)
	expect(config().mcp_servers).toEqual({ team: { command: "something" } })
})

test("repairs misplaced legacy notify and duplicated env tables without dropping other tables", () => {
	const legacy = join(home, ".lucid", "hooks", "codex-notify.sh")
	writeFileSync(
		path,
		`[mcp_servers.lucid-memory.env]\nLUCID_CLIENT = "codex"\nnotify = ${JSON.stringify([legacy])}\n[mcp_servers.other]\ncommand = "one"\n[mcp_servers.lucid-memory]\ncommand = "old"\nstartup_timeout_sec = 10\n[mcp_servers.lucid-memory.env]\nLUCID_CLIENT = "codex"\nCUSTOM = "kept"\n`
	)
	expect(run("install").exitCode).toBe(0)
	expect(config().notify).not.toContain(legacy)
	expect(config().mcp_servers["lucid-memory"]?.env).toEqual({
		CUSTOM: "kept",
		LUCID_CLIENT: "codex",
	})
	expect(config().mcp_servers["lucid-memory"]).toHaveProperty(
		"startup_timeout_sec",
		10
	)
	expect(run("uninstall").exitCode).toBe(0)
	expect(config().notify).toBeUndefined()
	expect(config().mcp_servers).toEqual({ other: { command: "one" } })
})

test("malformed settings are not overwritten", () => {
	const bad = "model = [broken\n"
	writeFileSync(path, bad)
	expect(run("install").exitCode).not.toBe(0)
	expect(readFileSync(path, "utf8")).toBe(bad)
})

test("installer choices register only selected clients and preserve an existing named database", () => {
	const claudeHome = join(home, "custom Claude")
	mkdirSync(claudeHome)
	const settings = join(claudeHome, "settings.json"),
		mcp = join(claudeHome, ".claude.json")
	env.CLAUDE_CONFIG_DIR = claudeHome
	const installed = join(home, ".lucid")
	mkdirSync(join(installed, "hooks"))
	writeFileSync(
		join(
			installed,
			"hooks",
			process.platform === "win32"
				? "user-prompt-submit.ps1"
				: "user-prompt-submit.sh"
		),
		""
	)
	const configPath = join(installed, "config.json")
	const profile = { dbPath: join(home, "a private database.db") }
	writeFileSync(
		configPath,
		JSON.stringify({
			databaseMode: "profiles",
			clients: { codex: { enabled: true, profile: "work" } },
			profiles: { work: profile },
			customKey: "keep",
		})
	)
	const select = (...clients: string[]) =>
		Bun.spawnSync(
			[
				process.execPath,
				join(src, "src", "client-setup.ts"),
				"select",
				"profiles",
				"false",
				...clients,
			],
			{ env, cwd: directory }
		)
	writeFileSync(settings, "invalid unrelated settings")
	expect(select("codex=default").exitCode).toBe(0)
	expect(existsSync(mcp)).toBe(false)
	expect(readFileSync(settings, "utf8")).toBe("invalid unrelated settings")
	expect(
		JSON.parse(readFileSync(configPath, "utf8")).clients.codex.profile
	).toBe("work")

	writeFileSync(
		settings,
		JSON.stringify({
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "/team/stop.sh" }] }],
			},
		})
	)
	expect(select("claude=home", "codex=work").exitCode).toBe(0)
	const both = JSON.parse(readFileSync(settings, "utf8"))
	expect(both.hooks.UserPromptSubmit).toHaveLength(1)
	expect(both.hooks.Stop).toHaveLength(2)
	expect(
		JSON.parse(readFileSync(mcp, "utf8")).mcpServers["lucid-memory"].env
			.LUCID_CLIENT
	).toBe("claude")
	expect(config().mcp_servers["lucid-memory"]?.env).toEqual({
		LUCID_CLIENT: "codex",
	})

	expect(select("claude=default").exitCode).toBe(0)
	expect(config().notify).toBeUndefined()
	expect(config().mcp_servers?.["lucid-memory"]).toBeUndefined()
	expect(select("codex=work").exitCode).toBe(0)
	expect(JSON.parse(readFileSync(settings, "utf8")).hooks).toEqual({
		Stop: [{ hooks: [{ type: "command", command: "/team/stop.sh" }] }],
	})
	expect(
		JSON.parse(readFileSync(mcp, "utf8")).mcpServers["lucid-memory"]
	).toBeUndefined()
	const saved = JSON.parse(readFileSync(configPath, "utf8"))
	expect(saved.profiles.work).toEqual(profile)
	expect(saved.customKey).toBe("keep")
})

test("the notifier ignores project Bun preloads while preserving the caller's working directory", () => {
	writeFileSync(path, "")
	expect(run("install").exitCode).toBe(0)
	writeFileSync(join(directory, "bunfig.toml"), 'preload = ["./untrusted.ts"]')
	const marker = join(directory, "private-receipt")
	writeFileSync(
		join(directory, "untrusted.ts"),
		`await Bun.write(${JSON.stringify(marker)},"ran")`
	)
	const input = JSON.stringify({ type: "other" })
	const child = Bun.spawnSync(
		[process.execPath, ...config().notify.slice(1), input],
		{ cwd: directory, env }
	)
	expect(child.exitCode).toBe(0)
	expect(existsSync(marker)).toBe(false)
})

test("failure in a selected client leaves the other client’s settings alone", () => {
	const area = join(home, ".claude")
	mkdirSync(area)
	const settings = join(area, "settings.json")
	const before =
		'{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"other"}]}]}}'
	writeFileSync(settings, before)
	mkdirSync(join(home, ".lucid", "hooks"))
	writeFileSync(
		join(
			home,
			".lucid",
			"hooks",
			process.platform === "win32"
				? "user-prompt-submit.ps1"
				: "user-prompt-submit.sh"
		),
		""
	)
	writeFileSync(path, "notify = [invalid")
	const child = Bun.spawnSync(
		[
			process.execPath,
			join(src, "src", "client-setup.ts"),
			"select",
			"shared",
			"false",
			"claude=default",
			"codex=default",
		],
		{ env, cwd: directory }
	)
	expect(child.exitCode).toBe(1)
	expect(readFileSync(settings, "utf8")).toBe(before)
	expect(existsSync(join(home, ".claude.json"))).toBe(false)
	expect(existsSync(join(home, ".lucid", "config.json"))).toBe(false)
})

test("accepts older object-shaped notifications without inventing a project", () => {
	expect(run("install").exitCode).toBe(0)
	writeFileSync(join(home, ".lucid", "config.json"), "{}")
	const input = JSON.stringify({
		type: "agent-turn-complete",
		"input-messages": [
			{ role: "assistant", content: "skip" },
			{ role: "user", content: "legacy question" },
		],
		"last-assistant-message": { content: "legacy reply" },
	})
	const child = Bun.spawnSync(
		[process.execPath, ...config().notify.slice(1), input],
		{ cwd: directory, env }
	)
	expect(child.exitCode).toBe(0)
	const db = new LucidStorage({ dbPath: join(home, ".lucid", "memory.db") })
	try {
		const rows = db.getAllForRetrieval().memories
		expect(rows.map((m) => m.content).sort()).toEqual([
			"legacy question",
			"legacy reply",
		])
		expect(rows.every((m) => !m.projectId)).toBe(true)
	} finally {
		db.close()
	}
})
