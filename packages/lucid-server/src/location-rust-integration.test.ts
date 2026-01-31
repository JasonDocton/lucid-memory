/**
 * Integration Tests: Rust vs TypeScript Location Functions
 *
 * These tests verify that the Rust implementation produces identical
 * results to the TypeScript implementation. This ensures:
 * 1. Correctness during migration
 * 2. Fallback safety if native module unavailable
 * 3. Behavioral consistency across platforms
 */

import { beforeAll, describe, expect, it } from "bun:test"

// Load native module
let native: typeof import("@lucid-memory/native") | null = null
let hasNative = false

beforeAll(async () => {
	try {
		native = await import("@lucid-memory/native")
		hasNative = !!native.locationComputeFamiliarity
		console.log(`[test] Native module available: ${hasNative}`)
	} catch {
		console.log(
			"[test] Native module not available, skipping Rust comparison tests"
		)
	}
})

// ============================================================================
// TypeScript Reference Implementations
// ============================================================================

function tsFamiliarity(accessCount: number, k = 0.1): number {
	return 1.0 - 1.0 / (1.0 + k * accessCount)
}

function tsAssociationStrength(
	count: number,
	isSameTask: boolean,
	isSameActivity: boolean
): number {
	const multipliers = {
		taskSame: 5.0,
		taskDiff: 3.0,
		timeSame: 2.0,
		timeDiff: 1.0,
	}
	const multiplier = isSameTask
		? isSameActivity
			? multipliers.taskSame
			: multipliers.taskDiff
		: isSameActivity
			? multipliers.timeSame
			: multipliers.timeDiff
	const effectiveCount = count * multiplier
	return 1.0 - 1.0 / (1.0 + 0.1 * effectiveCount)
}

function tsIsWellKnown(familiarity: number, threshold = 0.7): boolean {
	return familiarity >= threshold
}

type ActivityType =
	| "reading"
	| "writing"
	| "debugging"
	| "refactoring"
	| "reviewing"
	| "unknown"
type InferenceSource = "explicit" | "keyword" | "tool" | "default"

function tsInferActivityType(
	context: string,
	toolName?: string,
	explicit?: string
): { activityType: ActivityType; source: InferenceSource; confidence: number } {
	// 1. Explicit
	if (explicit && explicit !== "unknown") {
		return {
			activityType: explicit as ActivityType,
			source: "explicit",
			confidence: 1.0,
		}
	}

	// 2. Keyword
	const lower = context.toLowerCase()
	const keywordMatches: {
		type: ActivityType
		keywords: string[]
		confidence: number
	}[] = [
		{
			type: "debugging",
			keywords: ["debug", "fix", "bug", "issue", "error", "trace"],
			confidence: 0.9,
		},
		{
			type: "refactoring",
			keywords: ["refactor", "clean", "reorganize", "restructure"],
			confidence: 0.9,
		},
		{
			type: "reviewing",
			keywords: ["review", "understand", "check", "examine", "audit"],
			confidence: 0.8,
		},
		{
			type: "writing",
			keywords: ["implement", "add", "create", "write", "build"],
			confidence: 0.7,
		},
		{
			type: "reading",
			keywords: ["read", "look", "see", "view", "inspect"],
			confidence: 0.6,
		},
	]

	for (const match of keywordMatches) {
		if (match.keywords.some((kw) => lower.includes(kw))) {
			return {
				activityType: match.type,
				source: "keyword",
				confidence: match.confidence,
			}
		}
	}

	// 3. Tool
	if (toolName) {
		const toolActivity: Record<string, ActivityType> = {
			Read: "reading",
			Edit: "writing",
			Write: "writing",
			Grep: "reading",
			Glob: "reading",
		}
		if (toolActivity[toolName]) {
			return {
				activityType: toolActivity[toolName],
				source: "tool",
				confidence: 0.5,
			}
		}
	}

	// 4. Default
	return { activityType: "unknown", source: "default", confidence: 0.0 }
}

// ============================================================================
// Comparison Tests
// ============================================================================

describe("Rust vs TypeScript: Familiarity Computation", () => {
	const testCases = [1, 2, 5, 10, 20, 24, 50, 100, 1000]

	it("produces identical familiarity values", () => {
		if (!hasNative || !native) {
			console.log("  [skipped] Native module not available")
			return
		}

		for (const count of testCases) {
			const rustResult = native.locationComputeFamiliarity(count)
			const tsResult = tsFamiliarity(count)

			expect(rustResult).toBeCloseTo(tsResult, 10)
		}
	})

	it("familiarity curve properties hold for both implementations", () => {
		if (!hasNative || !native) return

		// f(1) ≈ 0.091
		expect(native.locationComputeFamiliarity(1)).toBeCloseTo(0.091, 2)
		expect(tsFamiliarity(1)).toBeCloseTo(0.091, 2)

		// f(10) ≈ 0.5
		expect(native.locationComputeFamiliarity(10)).toBeCloseTo(0.5, 1)
		expect(tsFamiliarity(10)).toBeCloseTo(0.5, 1)

		// f(24) >= 0.7 (well-known threshold)
		expect(native.locationComputeFamiliarity(24)).toBeGreaterThanOrEqual(0.7)
		expect(tsFamiliarity(24)).toBeGreaterThanOrEqual(0.7)

		// Monotonically increasing
		let prevRust = 0
		let prevTs = 0
		for (const count of testCases) {
			const rustVal = native.locationComputeFamiliarity(count)
			const tsVal = tsFamiliarity(count)
			expect(rustVal).toBeGreaterThan(prevRust)
			expect(tsVal).toBeGreaterThan(prevTs)
			prevRust = rustVal
			prevTs = tsVal
		}
	})
})

describe("Rust vs TypeScript: Activity Inference", () => {
	const testCases: { context: string; tool?: string; explicit?: string }[] = [
		// Keyword-based
		{ context: "Debugging the authentication bug" },
		{ context: "Let me fix this issue" },
		{ context: "Refactoring the module structure" },
		{ context: "Reviewing the pull request" },
		{ context: "Implementing the new feature" },
		{ context: "Reading through the code" },

		// Tool-based (no keywords)
		{ context: "Opening the file", tool: "Read" },
		{ context: "Making changes", tool: "Edit" },
		{ context: "Creating new content", tool: "Write" },
		{ context: "Searching for patterns", tool: "Grep" },

		// Explicit override
		{ context: "Some generic context", explicit: "debugging" },
		{
			context: "Debugging but explicit says refactoring",
			explicit: "refactoring",
		},

		// Keyword beats tool
		{ context: "Debugging via Read tool", tool: "Read" },

		// Default fallback
		{ context: "Doing something" },
		{ context: "Random stuff" },
	]

	it("produces identical activity type inference", () => {
		if (!hasNative || !native) {
			console.log("  [skipped] Native module not available")
			return
		}

		for (const tc of testCases) {
			const rustResult = native.locationInferActivity(
				tc.context,
				tc.tool ?? null,
				tc.explicit ?? null
			)
			const tsResult = tsInferActivityType(tc.context, tc.tool, tc.explicit)

			expect(rustResult.activityType).toBe(tsResult.activityType)
			expect(rustResult.source).toBe(tsResult.source)
			expect(rustResult.confidence).toBeCloseTo(tsResult.confidence, 5)
		}
	})

	it("respects precedence order: explicit > keyword > tool > default", () => {
		if (!hasNative || !native) return

		// Explicit wins over keyword
		const explicitResult = native.locationInferActivity(
			"debugging code",
			"Read",
			"refactoring"
		)
		expect(explicitResult.activityType).toBe("refactoring")
		expect(explicitResult.source).toBe("explicit")

		// Keyword wins over tool
		const keywordResult = native.locationInferActivity(
			"debugging the issue",
			"Read",
			null
		)
		expect(keywordResult.activityType).toBe("debugging")
		expect(keywordResult.source).toBe("keyword")

		// Tool when no keyword
		const toolResult = native.locationInferActivity(
			"opening file",
			"Read",
			null
		)
		expect(toolResult.activityType).toBe("reading")
		expect(toolResult.source).toBe("tool")

		// Default when nothing matches
		const defaultResult = native.locationInferActivity("stuff", null, null)
		expect(defaultResult.activityType).toBe("unknown")
		expect(defaultResult.source).toBe("default")
	})
})

describe("Rust vs TypeScript: Association Strength", () => {
	const testCases = [
		{ count: 1, isSameTask: true, isSameActivity: true },
		{ count: 1, isSameTask: true, isSameActivity: false },
		{ count: 1, isSameTask: false, isSameActivity: true },
		{ count: 1, isSameTask: false, isSameActivity: false },
		{ count: 5, isSameTask: true, isSameActivity: true },
		{ count: 10, isSameTask: false, isSameActivity: false },
	]

	it("produces identical association strength values", () => {
		if (!hasNative || !native) {
			console.log("  [skipped] Native module not available")
			return
		}

		for (const tc of testCases) {
			const rustResult = native.locationAssociationStrength(
				tc.count,
				tc.isSameTask,
				tc.isSameActivity
			)
			const tsResult = tsAssociationStrength(
				tc.count,
				tc.isSameTask,
				tc.isSameActivity
			)

			expect(rustResult).toBeCloseTo(tsResult, 10)
		}
	})

	it("maintains multiplier hierarchy in both implementations", () => {
		if (!hasNative || !native) return

		const rustTaskSame = native.locationAssociationStrength(1, true, true)
		const rustTaskDiff = native.locationAssociationStrength(1, true, false)
		const rustTimeSame = native.locationAssociationStrength(1, false, true)
		const rustTimeDiff = native.locationAssociationStrength(1, false, false)

		const tsTaskSame = tsAssociationStrength(1, true, true)
		const tsTaskDiff = tsAssociationStrength(1, true, false)
		const tsTimeSame = tsAssociationStrength(1, false, true)
		const tsTimeDiff = tsAssociationStrength(1, false, false)

		// Rust hierarchy
		expect(rustTaskSame).toBeGreaterThan(rustTaskDiff)
		expect(rustTaskDiff).toBeGreaterThan(rustTimeSame)
		expect(rustTimeSame).toBeGreaterThan(rustTimeDiff)

		// TypeScript hierarchy (should match)
		expect(tsTaskSame).toBeGreaterThan(tsTaskDiff)
		expect(tsTaskDiff).toBeGreaterThan(tsTimeSame)
		expect(tsTimeSame).toBeGreaterThan(tsTimeDiff)
	})
})

describe("Rust vs TypeScript: Well-Known Threshold", () => {
	const testCases = [0.0, 0.3, 0.5, 0.69, 0.7, 0.71, 0.9, 1.0]

	it("produces identical well-known classification", () => {
		if (!hasNative || !native) {
			console.log("  [skipped] Native module not available")
			return
		}

		for (const familiarity of testCases) {
			const rustResult = native.locationIsWellKnown(familiarity)
			const tsResult = tsIsWellKnown(familiarity)

			expect(rustResult).toBe(tsResult)
		}
	})

	it("threshold is exactly 0.7", () => {
		if (!hasNative || !native) return

		expect(native.locationIsWellKnown(0.69)).toBe(false)
		expect(native.locationIsWellKnown(0.7)).toBe(true)
		expect(tsIsWellKnown(0.69)).toBe(false)
		expect(tsIsWellKnown(0.7)).toBe(true)
	})
})

describe("Rust Performance Characteristics", () => {
	it("familiarity computation is fast", () => {
		if (!hasNative || !native) {
			console.log("  [skipped] Native module not available")
			return
		}

		const iterations = 10000
		const start = performance.now()

		for (let i = 0; i < iterations; i++) {
			native.locationComputeFamiliarity(i % 1000)
		}

		const elapsed = performance.now() - start
		const perCall = (elapsed / iterations) * 1000 // microseconds

		console.log(
			`  Familiarity: ${perCall.toFixed(3)}μs/call (${iterations} iterations)`
		)

		// Should be < 10μs per call (very conservative)
		expect(perCall).toBeLessThan(10)
	})

	it("activity inference is fast", () => {
		if (!hasNative || !native) return

		const iterations = 10000
		const contexts = [
			"debugging the issue",
			"implementing feature",
			"random context",
		]

		const start = performance.now()

		for (let i = 0; i < iterations; i++) {
			native.locationInferActivity(contexts[i % 3] ?? "", null, null)
		}

		const elapsed = performance.now() - start
		const perCall = (elapsed / iterations) * 1000

		console.log(
			`  Activity inference: ${perCall.toFixed(3)}μs/call (${iterations} iterations)`
		)

		// Should be < 50μs per call
		expect(perCall).toBeLessThan(50)
	})

	it("association strength is fast", () => {
		if (!hasNative || !native) return

		const iterations = 10000
		const start = performance.now()

		for (let i = 0; i < iterations; i++) {
			native.locationAssociationStrength(i % 100, i % 2 === 0, i % 3 === 0)
		}

		const elapsed = performance.now() - start
		const perCall = (elapsed / iterations) * 1000

		console.log(
			`  Association strength: ${perCall.toFixed(3)}μs/call (${iterations} iterations)`
		)

		// Should be < 10μs per call
		expect(perCall).toBeLessThan(10)
	})
})
