// This file also runs from ~/.lucid/hooks on v0.6.5 installations.
import { randomUUID } from "node:crypto"
import {
	link,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const lucid = join(homedir(), ".lucid")
const installedHook = join(lucid, "hooks", "claude-stop.ts")
const handler = join(lucid, "server", "src", "claude-stop.ts")
const args = [
	"run",
	"--cwd",
	dirname(installedHook),
	"--no-env-file",
	"--no-install",
	installedHook,
]
const byteOrderMark = /^\uFEFF/
const oldPlugin = "claude-response-capture@lucid-memory"

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function readOptional(path: string) {
	try {
		return await readFile(path, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		return undefined
	}
}

export async function replaceFile(
	path: string,
	contents: string,
	previous: string | undefined,
	mode: number
) {
	const temporary = `${path}.${randomUUID()}.tmp`
	await mkdir(dirname(path), { recursive: true })
	try {
		await writeFile(temporary, contents, { flag: "wx", mode })
		if ((await readOptional(path)) !== previous)
			throw new Error(`File changed during update: ${path}`)
		if (previous === undefined) await link(temporary, path)
		else await rename(temporary, path)
	} finally {
		await rm(temporary, { force: true })
	}
}

type Action = "install" | "uninstall" | "on" | "off" | "keep"

type Command = {
	type: "command"
	command: string
	args: string[]
	timeout?: number
}

// Update only the matching command within each group, preserving its siblings and matcher.
function updateHandlers(
	hooks: Record<string, unknown>,
	event: string,
	wanted: Command,
	enable: boolean,
	legacy?: string
) {
	const groups = hooks[event] ?? []
	if (!Array.isArray(groups)) throw new Error(`Invalid Claude ${event} hooks`)
	let found = false
	const result = groups.flatMap((group: unknown) => {
		if (!object(group) || !Array.isArray(group.hooks))
			throw new Error(`Invalid Claude ${event} handler group`)
		const remaining = group.hooks.filter((hook: unknown) => {
			if (!object(hook) || hook.type !== "command") return true
			if (legacy && hook.command === legacy && hook.args === undefined)
				return false
			if (
				hook.command !== wanted.command ||
				JSON.stringify(hook.args) !== JSON.stringify(wanted.args)
			)
				return true
			const retain = enable && !found
			found = true
			return retain
		})
		if (remaining.length === group.hooks.length) return [group]
		return remaining.length ? [{ ...group, hooks: remaining }] : []
	})
	if (enable && !found) result.push({ hooks: [wanted] })
	if (result.length) hooks[event] = result
	else if (groups.length) delete hooks[event]
}

export async function configureClaudeHook(
	action: Action,
	checkOnly = false,
	write = replaceFile
) {
	const location = join(
		// biome-ignore lint/style/noProcessEnv: Claude honors a custom configuration directory.
		process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
		"settings.json"
	)
	const entry = await lstat(location).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error
		return undefined
	})
	const path = entry ? await realpath(location) : location
	const previous = await readOptional(path)
	const config: unknown =
		previous === undefined
			? {}
			: JSON.parse(previous.replace(byteOrderMark, ""))
	if (!object(config)) throw new Error("Invalid Claude settings")
	const original = JSON.stringify(config)
	const hooks = config.hooks === undefined ? {} : config.hooks
	if (!object(hooks)) throw new Error("Invalid Claude hooks")
	const plugins = config.enabledPlugins
	const priorOptIn = object(plugins) && plugins[oldPlugin] === true
	const stop: Command = { type: "command", command: "bun", args, timeout: 10 }
	const groups = hooks.Stop ?? []
	if (!Array.isArray(groups)) throw new Error("Invalid Claude Stop hooks")
	const hasStop = groups.some(
		(group) =>
			object(group) &&
			Array.isArray(group.hooks) &&
			group.hooks.some(
				(h) =>
					object(h) &&
					h.type === "command" &&
					h.command === stop.command &&
					JSON.stringify(h.args) === JSON.stringify(args)
			)
	)
	const enable =
		action === "install" ||
		action === "on" ||
		(action === "keep" && (priorOptIn || hasStop))
	if (action === "install" || action === "uninstall") {
		const windows = process.platform === "win32"
		const prompt = join(
			lucid,
			"hooks",
			windows ? "user-prompt-submit.ps1" : "user-prompt-submit.sh"
		)
		if (action === "install" && !(await Bun.file(prompt).exists()))
			throw new Error("Lucid prompt hook is missing")
		const command = windows ? "powershell" : prompt
		const promptArgs = windows
			? ["-ExecutionPolicy", "Bypass", "-File", prompt]
			: []
		const legacy = windows
			? `powershell -ExecutionPolicy Bypass -File "${prompt}"`
			: prompt
		updateHandlers(
			hooks,
			"UserPromptSubmit",
			{ type: "command", command, args: promptArgs },
			action === "install",
			legacy
		)
	}
	if (enable) {
		if (!(await Bun.file(handler).exists()))
			throw new Error(
				"Update the Lucid server before enabling response capture"
			)
		const source = await readFile(import.meta.path, "utf8")
		const existing = await readOptional(installedHook)
		if (!checkOnly && source !== existing)
			await write(installedHook, source, existing, 0o600)
	}
	updateHandlers(hooks, "Stop", stop, enable)
	if (Object.keys(hooks).length || config.hooks !== undefined)
		config.hooks = hooks
	if (object(plugins) && priorOptIn) plugins[oldPlugin] = false
	if (checkOnly || JSON.stringify(config) === original) return
	await write(
		path,
		`${JSON.stringify(config, null, 2)}\n`,
		previous,
		entry ? (await stat(path)).mode & 0o777 : 0o600
	)
}

if (import.meta.main) {
	const action = process.argv[2]
	try {
		if (
			action === "on" ||
			action === "off" ||
			action === "keep" ||
			action === "install" ||
			action === "uninstall"
		)
			await configureClaudeHook(action)
		else if (action !== undefined) throw new Error("Expected on, off, or keep")
		else if (await Bun.file(join(lucid, "server", "package.json")).exists()) {
			const { captureStop } = await import(pathToFileURL(handler).href)
			await captureStop(await Bun.stdin.text())
		}
	} catch (error) {
		console.error(
			action
				? `Lucid could not update Claude's Stop hook: ${error instanceof Error ? error.message : String(error)}`
				: "Lucid could not store the response. Check the Claude profile and database."
		)
		process.exitCode = 1
	}
}
