import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { openCaptureStorage } from "./capture-storage.ts"

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
	const storage = await openCaptureStorage("claude")
	if (!storage) return

	try {
		storage.storeCapturedMessage(
			"claude",
			"assistant",
			key,
			event.cwd,
			Array.from(reply).slice(0, 2000).join("")
		)
	} finally {
		storage.close()
	}
}
