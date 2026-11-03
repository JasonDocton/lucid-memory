import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const handler = join(homedir(), ".lucid", "server", "src", "claude-stop.ts")
const installed = Bun.file(join(homedir(), ".lucid", "server", "package.json"))
if ((await installed.exists()) && !(await Bun.file(handler).exists())) {
	console.error(
		"Lucid response capture requires an updated Lucid Memory installation."
	)
	process.exitCode = 1
} else if (await installed.exists()) {
	try {
		const { captureStop } = await import(pathToFileURL(handler).href)
		await captureStop(await Bun.stdin.text())
	} catch {
		console.error(
			"Lucid could not store the response. Check the Claude profile and database."
		)
		process.exitCode = 1
	}
}
