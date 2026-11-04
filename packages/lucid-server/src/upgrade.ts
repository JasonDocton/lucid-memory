import { Database } from "bun:sqlite"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { readOptional, replaceFile } from "./claude-hook.ts"
import { configureClient } from "./client-setup.ts"
import { LUCID_DIR, type LucidConfig } from "./database-path.ts"

const run = promisify(execFile)
const repo = "https://github.com/JasonDocton/lucid-memory.git"
const work = join(LUCID_DIR, ".upgrade-work")
const packages = ["native", "perception", "server"] as const
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const legacyBackup = /^server-backup-(\d+)$/
const legacyTemp = /^update-tmp-(\d+)$/

function version(value: unknown): string {
	if (typeof value !== "string" || !stableVersion.test(value))
		throw new Error("Invalid Lucid release version")
	return value
}

async function packageVersion(path: string) {
	const manifest = await Bun.file(join(path, "package.json")).json()
	return version(manifest.lucidRelease ?? manifest.version)
}

export async function latestRelease() {
	const response = await fetch(
		"https://api.github.com/repos/JasonDocton/lucid-memory/releases/latest",
		{
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(10000),
		}
	)
	if (!response.ok)
		throw new Error(`Release lookup failed (HTTP ${response.status})`)
	const info = await response.json()
	if (
		info.draft ||
		info.prerelease ||
		typeof info.tag_name !== "string" ||
		!info.tag_name.startsWith("v")
	)
		throw new Error("Expected a published stable release")
	return version(info.tag_name.slice(1))
}

async function exists(path: string) {
	try {
		await lstat(path)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		return false
	}
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
interface FileUndo {
	path: string
	before?: string
	afterHash: string
	mode: number
}
const undoFile = join(work, "files.json")

async function rollback() {
	if (
		!(await lstat(work)).isDirectory() ||
		(await readOptional(join(work, "owner"))) !== "lucid-update-v1"
	)
		throw new Error(
			`Unrecognized update workspace at ${work}; refusing to remove it`
		)
	const journal: FileUndo[] = JSON.parse((await readOptional(undoFile)) ?? "[]")
	for (const entry of journal.reverse()) {
		const now = await readOptional(entry.path)
		if (now === entry.before) continue
		if (now === undefined || hash(now) !== entry.afterHash)
			throw new Error(
				`File changed during recovery; retained backup at ${work}: ${entry.path}`
			)
		if (entry.before === undefined) await rm(entry.path)
		else await replaceFile(entry.path, entry.before, now, entry.mode)
	}
	for (const name of [...packages].reverse()) {
		const dst = join(LUCID_DIR, name),
			old = join(work, "old", name)
		if (await exists(old)) {
			await rm(dst, { force: true, recursive: true })
			await rename(old, dst)
		} else if (await exists(join(work, "old", `${name}.absent`))) {
			await rm(dst, { force: true, recursive: true })
		}
	}
	await rm(work, { recursive: true, force: true })
}

async function updateTransaction(operation: () => Promise<void>) {
	const lock = new Database(join(LUCID_DIR, ".update-lock.sqlite"))
	try {
		lock.exec("BEGIN EXCLUSIVE")
		if (await exists(work)) await rollback()
		await mkdir(work, { mode: 0o700 })
		await writeFile(join(work, "owner"), "lucid-update-v1", {
			flag: "wx",
			mode: 0o600,
		})
		try {
			await mkdir(join(work, "old"))
			await mkdir(join(work, "new"))
			await operation()
			// Renaming the journal commits all replacements before deleting backups.
			const cleanup = await mkdtemp(join(LUCID_DIR, ".upgrade-done-"))
			await rename(work, join(cleanup, "committed"))
			await rm(cleanup, { recursive: true, force: true }).catch(() =>
				console.error(`Lucid updated; retained backups at ${cleanup}`)
			)
		} catch (error) {
			if (await exists(work)) await rollback()
			throw error
		}
	} finally {
		lock.close()
	}
}

async function activate(name: (typeof packages)[number]) {
	const dst = join(LUCID_DIR, name)
	if (await exists(dst)) await rename(dst, join(work, "old", name))
	else await writeFile(join(work, "old", `${name}.absent`), "")
	await rename(join(work, "new", name), dst)
}

async function writeWithUndo(
	path: string,
	contents: string,
	previous: string | undefined,
	mode: number
) {
	if (contents === previous) return
	const journal = await readOptional(undoFile)
	const records: FileUndo[] = JSON.parse(journal ?? "[]")
	records.push({ path, before: previous, afterHash: hash(contents), mode })
	await replaceFile(undoFile, JSON.stringify(records), journal, 0o600)
	await replaceFile(path, contents, previous, mode)
}

async function refreshClients() {
	const configPath = join(LUCID_DIR, "config.json")
	const text = await readOptional(configPath)
	if (text === undefined && (await exists(configPath)))
		throw new Error("Cannot read linked Lucid config")
	const config: LucidConfig = text === undefined ? {} : JSON.parse(text)
	if (!config || typeof config !== "object" || Array.isArray(config))
		throw new Error("Invalid Lucid configuration")
	if (
		config.clients !== undefined &&
		(!config.clients ||
			typeof config.clients !== "object" ||
			Array.isArray(config.clients))
	)
		throw new Error("Invalid saved Lucid clients")
	const clients: ("claude" | "codex")[] = []
	for (const client of ["claude", "codex"] as const) {
		if (
			config.clients?.[client] !== undefined &&
			typeof config.clients[client]?.enabled !== "boolean"
		)
			throw new Error(`Invalid saved selection for ${client}`)
		const legacyHook =
			client === "codex"
				? "codex-notify.sh"
				: process.platform === "win32"
					? "user-prompt-submit.ps1"
					: "user-prompt-submit.sh"
		if (
			config.clients === undefined
				? await exists(join(LUCID_DIR, "hooks", legacyHook))
				: config.clients?.[client]?.enabled === true
		)
			clients.push(client)
	}
	if (clients.includes("claude")) {
		const name =
			process.platform === "win32"
				? "user-prompt-submit.ps1"
				: "user-prompt-submit.sh"
		const target = join(LUCID_DIR, "hooks", name)
		const source = await readFile(
			join(LUCID_DIR, "server", "hooks", name),
			"utf8"
		)
		await writeWithUndo(target, source, await readOptional(target), 0o755)
		if (process.platform !== "win32") await chmod(target, 0o755)
	}
	for (const client of clients) await configureClient(client, "install", true)
	for (const client of clients)
		await configureClient(client, "install", false, writeWithUndo)
}

async function stampInstalledManifest() {
	const path = join(LUCID_DIR, "server", "package.json")
	const manifest = await Bun.file(path).json()
	const release = version(manifest.lucidRelease)
	if (manifest.version !== release) {
		const temp = `${path}.version-${process.pid}.tmp`
		try {
			await writeFile(
				temp,
				`${JSON.stringify({ ...manifest, version: release }, null, 2)}\n`,
				{ flag: "wx" }
			)
			await rename(temp, path)
		} finally {
			await rm(temp, { force: true })
		}
	}
}

async function applyCheckout(
	checkout: string,
	target: string,
	legacy: boolean
) {
	const staged = join(work, "new")
	for (const name of packages) {
		const source = join(checkout, "packages", `lucid-${name}`)
		if ((await packageVersion(source)) !== target)
			throw new Error(`Version mismatch in ${source}`)
		if (name === "server" && legacy) continue
		await cp(source, join(staged, name), {
			recursive: true,
			filter: (path) => basename(path) !== "node_modules",
		})
	}
	if (!legacy) {
		await run(
			process.execPath,
			["install", "--production", "--frozen-lockfile", "--ignore-scripts"],
			{ cwd: join(staged, "server"), timeout: 120000 }
		)
	}
	for (const name of packages) {
		if (legacy && name === "server") continue
		await activate(name)
	}
	// Stock Bun may have copied the *old* local package into node_modules before postinstall.
	const scope = join(LUCID_DIR, "server", "node_modules", "@lucid-memory")
	await mkdir(scope, { recursive: true })
	for (const name of ["native", "perception"]) {
		const link = join(scope, name)
		await rm(link, { recursive: true, force: true })
		const targetDir = join(LUCID_DIR, name)
		await symlink(
			process.platform === "win32" ? targetDir : relative(scope, targetDir),
			link,
			process.platform === "win32" ? "junction" : "dir"
		)
	}
	await stampInstalledManifest()
	// Use the newly installed release's hook definitions, even when the caller is an older updater.
	await run(
		process.execPath,
		[
			"run",
			"--cwd",
			join(LUCID_DIR, "server"),
			"--no-install",
			"--no-env-file",
			join(LUCID_DIR, "server", "src", "upgrade.ts"),
			"--refresh-clients",
		],
		{ timeout: 30000 }
	)
}

async function verifiedTag(checkout: string, target: string) {
	const { stdout: head } = await run("git", [
		"-C",
		checkout,
		"rev-parse",
		"HEAD",
	])
	const { stdout: tag } = await run("git", [
		"-C",
		checkout,
		"rev-parse",
		`refs/tags/v${target}^{commit}`,
	])
	return head.trim() === tag.trim()
}

async function checkoutRelease(target: string) {
	const checkout = join(work, "checkout")
	await run(
		"git",
		[
			"clone",
			"--quiet",
			"--depth",
			"1",
			"--single-branch",
			"--branch",
			`v${target}`,
			"--",
			repo,
			checkout,
		],
		{ timeout: 180000 }
	)
	if (!(await verifiedTag(checkout, target)))
		throw new Error(`Could not verify v${target} tag`)
	return checkout
}

export async function updateToRelease(target: string) {
	target = version(target)
	if (
		!(await exists(work)) &&
		Bun.semver.order(target, await packageVersion(join(LUCID_DIR, "server"))) <=
			0
	)
		return false
	let changed = false
	await updateTransaction(async () => {
		if (
			Bun.semver.order(
				target,
				await packageVersion(join(LUCID_DIR, "server"))
			) <= 0
		)
			return
		await applyCheckout(await checkoutRelease(target), target, false)
		changed = true
	})
	return changed
}

export async function updateInstalled() {
	const latest = await latestRelease()
	if (await updateToRelease(latest))
		console.log(`Updated to Lucid ${latest}. Restart your clients.`)
	else
		console.log(
			`Lucid ${await packageVersion(join(LUCID_DIR, "server"))} is up to date.`
		)
}

// Bun runs the root postinstall for v0.6.5's unmodified "bun install --production".
// Plain repository installs, fresh installs, and staged future updates have no work here.
export async function finishLegacyUpdate(packageDir: string) {
	const live = join(LUCID_DIR, "server")
	if (
		!(await exists(live)) ||
		(await realpath(packageDir)) !== (await realpath(live))
	)
		return
	const candidates: string[] = []
	const target = await packageVersion(live)
	const entries = await readdir(LUCID_DIR)
	// v0.6.5 calls Date.now() separately for its checkout and subsequent backup.
	const backups: number[] = []
	for (const entry of entries) {
		const match = legacyBackup.exec(entry)
		if (!match) continue
		const manifest = await readOptional(join(LUCID_DIR, entry, "package.json"))
		if (manifest && JSON.parse(manifest).version === "0.6.5")
			backups.push(Number(match[1]))
	}
	for (const entry of entries) {
		const start = legacyTemp.exec(entry)?.[1]
		if (!start || !backups.some((time) => time >= Number(start))) continue
		const checkout = join(LUCID_DIR, entry, "repo")
		const source = join(checkout, "packages", "lucid-server")
		if (
			(await exists(join(source, "package.json"))) &&
			(await packageVersion(source)) === target
		)
			candidates.push(checkout)
	}
	if (!candidates.length) {
		// Never rewrite workspace manifests when an installed server is a symlink to a checkout.
		if (!(await lstat(live)).isSymbolicLink()) await stampInstalledManifest()
		return
	}
	if (candidates.length !== 1)
		throw new Error(
			"Multiple legacy updates detected; close clients and retry from a release checkout"
		)
	const [checkout] = candidates
	if (!checkout) return
	// The legacy updater clones main. If main moved past the release, install the tag instead.
	const published = await latestRelease()
	await updateTransaction(async () => {
		const exact =
			target === published &&
			(await verifiedTag(checkout, published).catch(() => false))
		await applyCheckout(
			exact ? checkout : await checkoutRelease(published),
			published,
			exact
		)
	})
}

async function updateFromCheckout() {
	const checkout = resolve(import.meta.dir, "../../..")
	const target = await packageVersion(
		join(checkout, "packages", "lucid-server")
	)
	const { stdout: changes } = await run("git", [
		"-C",
		checkout,
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--",
		"packages",
	])
	if (!(await verifiedTag(checkout, target)) || changes.trim())
		throw new Error(`Use a clean checkout of the published v${target} tag`)
	await updateTransaction(async () => {
		const current = await packageVersion(join(LUCID_DIR, "server"))
		if (Bun.semver.order(current, target) > 0)
			throw new Error("Refusing to downgrade a newer installation")
		await applyCheckout(checkout, target, false)
	})
	console.log(`Lucid ${target} is installed. Restart your clients.`)
}

if (import.meta.main) {
	try {
		if (process.argv[2] === "--refresh-clients") {
			if (!(await exists(join(work, "old"))))
				throw new Error("No update in progress")
			await refreshClients()
		} else if (process.argv[2] === "--from-checkout") await updateFromCheckout()
		else if (process.argv.length === 2) await updateInstalled()
		else throw new Error("Unknown update option")
	} catch (error) {
		console.error(
			"Lucid update failed:",
			error instanceof Error ? error.message : String(error)
		)
		process.exitCode = 1
	}
}
