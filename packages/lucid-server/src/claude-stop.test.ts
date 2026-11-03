import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { LucidStorage } from "./storage.ts"

const server = resolve(import.meta.dir, "..")
const setup = join(server, "src", "claude-hook.ts")
let handler: { command: string; args: string[] }
let home: string
let dir: string
let project: string
function event() {
	return {
		hook_event_name: "Stop",
		session_id: "session",
		prompt_id: "one",
		cwd: project,
		last_assistant_message: "Done.",
	}
}
function configure(config: unknown) {
	writeFileSync(join(dir, "config.json"), JSON.stringify(config))
}
async function run(input: string) {
	const child = Bun.spawn([process.execPath, ...handler.args], {
		cwd: project,
		env: { HOME: home, USERPROFILE: home, LUCID_CLIENT: "codex" },
		stdin: new Blob([input]),
		stdout: "pipe",
		stderr: "pipe",
	})
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	])
	return { exit, stdout, stderr }
}
function configureHook(mode: "on" | "off" | "keep" | "install" | "uninstall") {
	return Bun.spawnSync(
		[
			process.execPath,
			"run",
			"--cwd",
			server,
			"--no-env-file",
			"--no-install",
			setup,
			mode,
		],
		{
			env: { HOME: home, USERPROFILE: home },
			cwd: project,
		}
	)
}
function readSettings() {
	return JSON.parse(
		readFileSync(join(home, ".claude", "settings.json"), "utf8")
	)
}
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "lucid-claude-"))
	dir = join(home, ".lucid")
	project = join(home, "work=a")
	mkdirSync(dir)
	mkdirSync(project)
	symlinkSync(server, join(dir, "server"), "junction")
	configure({ databaseMode: "per-client" })
	expect(configureHook("on").exitCode).toBe(0)
	handler = readSettings().hooks.Stop[0].hooks[0]
})
afterEach(() => {
	rmSync(home, { recursive: true, force: true })
})

test("stores a distinct assistant conversation and collapses concurrent replays", async () => {
	const db = new LucidStorage({ dbPath: join(dir, "memory-claude.db") })
	try {
		const projectId = db.getOrCreateProject(project).id
		const prompt = db.storeMemory({
			content: "Original prompt",
			projectId,
			type: "conversation",
		})
		db.storeEmbedding(prompt.id, [1, 0], "test")
		const reply = "🚀".repeat(2001)
		const payload = { ...event(), last_assistant_message: reply }
		const runs = await Promise.all([
			run(JSON.stringify(payload)),
			run(JSON.stringify(payload)),
		])
		for (const result of runs)
			expect(result).toEqual({ exit: 0, stdout: "", stderr: "" })
		await run(JSON.stringify({ ...payload, prompt_id: "two" }))
		await run(
			JSON.stringify({
				...payload,
				stop_hook_active: true,
				last_assistant_message: `${reply}!`,
			})
		)
		const memories = db.getAllForRetrieval(projectId).memories
		expect(memories).toHaveLength(4)
		expect(db.getMemory(prompt.id)?.content).toBe("Original prompt")
		const replies = memories.filter((m) => m.tags.includes("assistant"))
		expect(replies).toHaveLength(3)
		for (const m of replies) {
			expect(m.content).toBe("🚀".repeat(2000))
			expect(m.type).toBe("conversation")
			expect(m.gist?.startsWith("Claude replied: ")).toBe(true)
			db.storeEmbedding(m.id, [0, 1], "test")
		}
		expect(db.findMostSimilarMemory([0, 1], projectId, 0.9)).toBeNull()
		// A perfect match can be ineligible by role or by embedding model.
		db.storeEmbedding(prompt.id, [0, 1], "previous-model")
		expect(
			db.findMostSimilarMemory([0, 1], projectId, 0.9, {
				model: "test",
				dimensions: 2,
			})
		).toBeNull()
		expect(
			db.findMostSimilarMemory([0, 1], projectId, 0.9, {
				model: "previous-model",
				dimensions: 2,
			})?.memoryId
		).toBe(prompt.id)
		expect(existsSync(join(dir, "memory-codex.db"))).toBe(false)
	} finally {
		db.close()
	}
})

test("concurrent distinct turns can initialize a new database together", async () => {
	const runs = await Promise.all(
		Array.from({ length: 6 }, (_, i) =>
			run(JSON.stringify({ ...event(), prompt_id: String(i) }))
		)
	)
	for (const result of runs)
		expect(result).toEqual({ exit: 0, stdout: "", stderr: "" })
	const db = new LucidStorage({ dbPath: join(dir, "memory-claude.db") })
	try {
		expect(db.getAllForRetrieval().memories).toHaveLength(6)
	} finally {
		db.close()
	}
})

test("uses the configured profile and preserves short replies", async () => {
	configure({
		databaseMode: "profiles",
		clients: { claude: { enabled: true, profile: "team" } },
		profiles: { team: { dbPath: "~/.lucid/team.db" } },
	})
	expect(await run(JSON.stringify(event()))).toEqual({
		exit: 0,
		stdout: "",
		stderr: "",
	})
	const db = new LucidStorage({ dbPath: join(dir, "team.db") })
	try {
		expect(
			db
				.getAllForRetrieval(db.getOrCreateProject(project).id)
				.memories.map((m) => m.content)
		).toEqual(["Done."])
		expect(existsSync(join(dir, "memory.db"))).toBe(false)
	} finally {
		db.close()
	}
})

test("skips unrelated, incomplete, empty and ill-typed events", async () => {
	for (const overrides of [
		{ hook_event_name: "SubagentStop" },
		{ prompt_id: null },
		{ session_id: "" },
		{ cwd: "." },
		{ last_assistant_message: ["text"] },
		{ last_assistant_message: " \n " },
	]) {
		expect(await run(JSON.stringify({ ...event(), ...overrides }))).toEqual({
			exit: 0,
			stdout: "",
			stderr: "",
		})
	}
	expect(existsSync(join(dir, "memory-claude.db"))).toBe(false)
})

test("disabled or broken configuration never falls back to the shared database", async () => {
	configure({ clients: { claude: { enabled: false } } })
	expect((await run(JSON.stringify(event()))).exit).toBe(0)
	for (const config of [
		null,
		{ databaseMode: "profiles", profiles: {} },
		{ databaseMode: "unknown" },
	]) {
		configure(config)
		const result = await run(JSON.stringify(event()))
		expect(result.exit).toBe(1)
		expect(result.stdout).toBe("")
		expect(result.stderr).not.toContain("Done.")
	}
	expect((await run("broken JSON")).exit).toBe(1)
	expect(existsSync(join(dir, "memory.db"))).toBe(false)
})

test("the registered hook does not load project preloads before reading private Stop input", async () => {
	expect(handler.command).toBe("bun")
	writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]')
	// Record any execution, even if the hook exits before trying to store.
	writeFileSync(
		join(project, "preload.ts"),
		`await Bun.write(${JSON.stringify(join(project, "receipt"))}, await Bun.stdin.text())`
	)
	configure({ clients: { claude: { enabled: false } } })
	expect(await run(JSON.stringify(event()))).toEqual({
		exit: 0,
		stdout: "",
		stderr: "",
	})
	expect(existsSync(join(project, "receipt"))).toBe(false)
})

test("a reader can open an initialized WAL database while another process is writing", () => {
	const path = join(dir, "test.db")
	new LucidStorage({ dbPath: path }).close()
	const writer = new Database(path)
	writer.exec("BEGIN IMMEDIATE")
	try {
		const reader = new LucidStorage({ dbPath: path })
		try {
			expect(reader.getAllForRetrieval().memories).toHaveLength(0)
		} finally {
			reader.close()
		}
	} finally {
		writer.exec("ROLLBACK")
		writer.close()
	}
})

test("malformed settings cannot enable capture or select an unintended shared database", async () => {
	for (const config of [
		{ clients: { claude: { enabled: "false" } } },
		{ databaseMode: false },
		{ databaseMode: "" },
		{ clients: null },
		{ clients: { claude: { enabled: true, profile: 42 } } },
	]) {
		configure(config)
		expect((await run(JSON.stringify(event()))).exit).toBe(1)
	}
	expect(existsSync(join(dir, "memory.db"))).toBe(false)
})

test("a configless install uses the shared default, and a removed installation is quiet", async () => {
	rmSync(join(dir, "config.json"))
	expect(await run(JSON.stringify(event()))).toEqual({
		exit: 0,
		stdout: "",
		stderr: "",
	})
	const db = new LucidStorage({ dbPath: join(dir, "memory.db") })
	try {
		expect(db.getAllForRetrieval().memories).toHaveLength(1)
	} finally {
		db.close()
	}
	rmSync(join(dir, "server"))
	expect(await run(JSON.stringify(event()))).toEqual({
		exit: 0,
		stdout: "",
		stderr: "",
	})
})

test("a dangling config symlink cannot redirect a private reply into the shared database", async () => {
	rmSync(join(dir, "config.json"))
	symlinkSync(join(home, "missing-config.json"), join(dir, "config.json"))
	const result = await run(JSON.stringify(event()))
	expect(result.exit).toBe(1)
	expect(existsSync(join(dir, "memory.db"))).toBe(false)
})

test("enable, reinstall and disable preserve unrelated handlers and settings", () => {
	const settingsPath = join(home, ".claude", "settings.json")
	const sibling = { type: "command", command: "/team/stop.sh" }
	const other = { type: "prompt", prompt: "Review the results" }
	const fromUser = {
		theme: "dark",
		hooks: {
			Stop: [{ matcher: "", hooks: [sibling, handler, other] }],
			SessionStart: [{ hooks: [sibling] }],
		},
	}
	writeFileSync(settingsPath, JSON.stringify(fromUser))
	expect(configureHook("keep").exitCode).toBe(0)
	expect(configureHook("on").exitCode).toBe(0)
	expect(readFileSync(settingsPath, "utf8")).toBe(JSON.stringify(fromUser))
	expect(configureHook("off").exitCode).toBe(0)
	expect(readSettings()).toEqual({
		...fromUser,
		hooks: {
			...fromUser.hooks,
			Stop: [{ matcher: "", hooks: [sibling, other] }],
		},
	})
})

test("migrates the former opt-in exactly once; malformed settings remain untouched", () => {
	const path = join(home, ".claude", "settings.json")
	const other = { type: "command", command: "/other/stop.sh" }
	writeFileSync(
		path,
		JSON.stringify({
			enabledPlugins: {
				"claude-response-capture@lucid-memory": true,
				"other@team": true,
			},
			hooks: { Stop: [{ hooks: [other] }] },
		})
	)
	expect(configureHook("keep").exitCode).toBe(0)
	expect(configureHook("keep").exitCode).toBe(0)
	expect(readSettings()).toEqual({
		enabledPlugins: {
			"claude-response-capture@lucid-memory": false,
			"other@team": true,
		},
		hooks: { Stop: [{ hooks: [other] }, { hooks: [handler] }] },
	})
	writeFileSync(path, "{bad")
	expect(configureHook("on").exitCode).toBe(1)
	expect(readFileSync(path, "utf8")).toBe("{bad")
})

test("selecting Claude installs prompt and response capture with no extra step", () => {
	rmSync(join(home, ".claude", "settings.json"))
	const prompt = join(
		dir,
		"hooks",
		process.platform === "win32"
			? "user-prompt-submit.ps1"
			: "user-prompt-submit.sh"
	)
	writeFileSync(prompt, "")
	expect(configureHook("install").exitCode).toBe(0)
	const settings = readSettings()
	expect(settings.hooks.Stop).toHaveLength(1)
	expect(settings.hooks.UserPromptSubmit).toHaveLength(1)
	expect(configureHook("install").exitCode).toBe(0)
	expect(readSettings()).toEqual(settings)
	expect(configureHook("uninstall").exitCode).toBe(0)
	expect(readSettings().hooks).toEqual({})
})
