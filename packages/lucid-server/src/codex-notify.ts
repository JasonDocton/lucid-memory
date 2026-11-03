import { createHash, randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { openCaptureStorage } from "./capture-storage.ts"

async function capture(input: string) {
	const event = JSON.parse(input)
	if (event?.type !== "agent-turn-complete") return
	const cwd = event.cwd
	if (cwd !== undefined && (typeof cwd !== "string" || !isAbsolute(cwd))) return
	const thread = event["thread-id"],
		turn = event["turn-id"]
	const prompts = event["input-messages"]
	const prompt = Array.isArray(prompts)
		? prompts
				.flatMap((message) => {
					if (typeof message === "string") return [message]
					return message?.role === "user" && typeof message.content === "string"
						? [message.content]
						: []
				})
				.join("\n")
				.trim()
		: ""
	const value = event["last-assistant-message"]
	const content = typeof value === "string" ? value : value?.content
	const reply = typeof content === "string" ? content.trim() : ""
	if (!prompt && !reply) return
	const storage = await openCaptureStorage("codex")
	if (!storage) return
	// Older notifications have no turn ID; repeated text alone cannot identify a turn.
	const key =
		typeof thread === "string" && thread && typeof turn === "string" && turn
			? createHash("sha256")
					.update(JSON.stringify([thread, turn]))
					.digest("hex")
			: randomUUID()

	try {
		if (prompt) storage.storeCapturedMessage("codex", "user", key, cwd, prompt)
		if (reply)
			storage.storeCapturedMessage(
				"codex",
				"assistant",
				key,
				cwd,
				Array.from(reply).slice(0, 2000).join("")
			)
	} finally {
		storage.close()
	}
}

if (import.meta.main) {
	const input = process.argv.at(-1)
	if (input !== undefined) {
		// Codex passes the notification JSON last. Keep an existing notifier independent of capture.
		const previous =
			process.argv[2] === "--forward" ? process.argv.slice(3, -1) : []
		const forward = async () => {
			if (!previous.length) return
			const child = Bun.spawn([...previous, input], {
				stdin: "ignore",
				stdout: "inherit",
				stderr: "inherit",
			})
			if ((await child.exited) !== 0)
				throw new Error("Previous notifier failed")
		}
		const results = await Promise.allSettled([capture(input), forward()])
		if (results.some((result) => result.status === "rejected")) {
			console.error("Codex turn capture or the existing notifier failed.")
			process.exitCode = 1
		}
	}
}
