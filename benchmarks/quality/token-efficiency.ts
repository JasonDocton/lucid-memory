/**
 * Token Efficiency Benchmarks
 *
 * Compares token usage across different retrieval approaches:
 * 1. lucid-memory: Gist compression + token budgeting
 * 2. claude-mem style: 3-layer progressive disclosure
 * 3. Pinecone/RAG: Fixed-size chunks
 *
 * Key metrics:
 * - Tokens used per query (to deliver equivalent information)
 * - Information density (relevance per token)
 * - Storage overhead (tokens stored vs original)
 * - Retrieval quality at fixed token budgets
 */

import {
	cosineSimilarityBatch,
	type JsAssociation,
	retrieve,
} from "../../packages/lucid-native/index.js"

const VERBOSE = process.argv.includes("--verbose")

// Time constants
const MS_SECOND = 1000
const MS_MINUTE = 60 * MS_SECOND
const MS_HOUR = 60 * MS_MINUTE
const MS_DAY = 24 * MS_HOUR
const NOW = Date.now()

// Token estimation (GPT-style: ~4 chars per token)
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

// Generate realistic memory content
function generateMemoryContent(
	seed: number,
	type: "short" | "medium" | "long"
): string {
	const templates = {
		short: [
			"Fixed bug in {module} where {issue} caused {effect}.",
			"Added {feature} to {component} for better {benefit}.",
			"Refactored {module} to use {pattern} instead of {old}.",
		],
		medium: [
			"The {module} module was experiencing {issue} when processing {input}. After investigation, found that {root_cause}. Fixed by {solution}. This change affects {affected} and requires {testing}.",
			"Implemented {feature} in {component}. This allows users to {capability}. The implementation uses {approach} which provides {benefit}. Key files modified: {files}. Testing: {tests}.",
		],
		long: [
			"## Investigation: {issue}\n\nContext: The {module} was failing intermittently when {trigger}.\n\nRoot cause analysis:\n1. {analysis1}\n2. {analysis2}\n3. {analysis3}\n\nSolution implemented:\n- {solution1}\n- {solution2}\n- {solution3}\n\nFiles modified:\n- {file1}: {change1}\n- {file2}: {change2}\n- {file3}: {change3}\n\nTesting performed:\n- Unit tests: {unit}\n- Integration tests: {integration}\n- Manual testing: {manual}\n\nFollow-up tasks:\n- {followup1}\n- {followup2}",
		],
	}

	const modules = [
		"auth",
		"api",
		"database",
		"cache",
		"payment",
		"user",
		"admin",
		"search",
		"notification",
		"logging",
	]
	const issues = [
		"null pointer",
		"race condition",
		"memory leak",
		"timeout",
		"validation error",
		"encoding issue",
	]
	const features = [
		"caching",
		"retry logic",
		"batch processing",
		"rate limiting",
		"compression",
		"encryption",
	]

	const template = templates[type][seed % templates[type].length]

	// Simple template filling
	return template
		.replace(/{module}/g, modules[seed % modules.length] ?? "module")
		.replace(/{issue}/g, issues[seed % issues.length] ?? "issue")
		.replace(/{feature}/g, features[seed % features.length] ?? "feature")
		.replace(
			/{component}/g,
			modules[(seed + 1) % modules.length] ?? "component"
		)
		.replace(/{effect}/g, "unexpected behavior")
		.replace(/{benefit}/g, "performance and reliability")
		.replace(/{pattern}/g, "dependency injection")
		.replace(/{old}/g, "singleton pattern")
		.replace(/{input}/g, "large payloads")
		.replace(
			/{root_cause}/g,
			"the buffer was not being cleared between requests"
		)
		.replace(/{solution}/g, "implementing proper cleanup in the finally block")
		.replace(/{affected}/g, "all downstream consumers")
		.replace(/{testing}/g, "regression testing")
		.replace(/{capability}/g, "process requests more efficiently")
		.replace(/{approach}/g, "lazy loading with memoization")
		.replace(/{files}/g, "handler.ts, service.ts, types.ts")
		.replace(/{tests}/g, "added 5 unit tests, 2 integration tests")
		.replace(/{trigger}/g, "handling concurrent requests")
		.replace(/{analysis\d}/g, "Found correlation with high traffic periods")
		.replace(/{solution\d}/g, "Added mutex for critical section")
		.replace(/{file\d}/g, "src/services/handler.ts")
		.replace(/{change\d}/g, "Added error handling")
		.replace(/{unit}/g, "15 tests passing")
		.replace(/{integration}/g, "3 tests passing")
		.replace(/{manual}/g, "Verified in staging environment")
		.replace(/{followup\d}/g, "Monitor performance metrics")
}

// Generate gist (extractive summary)
function generateGist(content: string, maxLength = 150): string {
	const cleaned = content.trim().replace(/\s+/g, " ")
	if (cleaned.length <= maxLength) return cleaned

	// Find first sentence
	const sentenceEnd = cleaned.search(/[.!?]\s/)
	if (sentenceEnd > 0 && sentenceEnd < maxLength) {
		return cleaned.slice(0, sentenceEnd + 1)
	}

	// Truncate at word boundary
	const truncated = cleaned.slice(0, maxLength - 3)
	const lastSpace = truncated.lastIndexOf(" ")
	return truncated.slice(0, lastSpace) + "..."
}

// Embedding generation
function seededRandom(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed / 0x7fffffff
	}
}

function makeEmbedding(seed: number, dim = 384): number[] {
	const rand = seededRandom(seed)
	const emb = Array.from({ length: dim }, () => rand() * 2 - 1)
	const norm = Math.sqrt(emb.reduce((sum, x) => sum + x * x, 0))
	return emb.map((x) => x / norm)
}

function makeSimilarEmbedding(
	base: number[],
	similarity: number,
	seed: number
): number[] {
	const rand = seededRandom(seed)
	const noise = Array.from({ length: base.length }, () => rand() * 2 - 1)
	const noiseNorm = Math.sqrt(noise.reduce((sum, x) => sum + x * x, 0))
	const normalizedNoise = noise.map((x) => x / noiseNorm)
	const blend = Math.sqrt(1 - similarity * similarity)
	const result = base.map((b, i) => similarity * b + blend * normalizedNoise[i])
	const norm = Math.sqrt(result.reduce((sum, x) => sum + x * x, 0))
	return result.map((x) => x / norm)
}

// ============================================================================
// Memory Retrieval Strategies
// ============================================================================

interface Memory {
	id: number
	content: string
	gist: string
	embedding: number[]
	accessHistory: number[]
	relevance: number // Ground truth relevance (0-1)
}

interface RetrievalResult {
	memoryId: number
	score: number
	tokensUsed: number
	text: string
}

/**
 * Strategy 1: lucid-memory
 * - Stores gists (~37 tokens each)
 * - Token-budgeted retrieval
 * - Returns gists within budget
 */
function retrieveLucidMemory(
	query: number[],
	memories: Memory[],
	tokenBudget: number
): RetrievalResult[] {
	// Run cognitive retrieval
	const results = retrieve(
		query,
		memories.map((m) => m.embedding),
		memories.map((m) => m.accessHistory),
		memories.map(() => 0.5), // emotional weights
		memories.map(() => 0.5), // decay rates
		memories.map(() => 1.0), // wm boosts
		NOW,
		null,
		{ minProbability: 0, maxResults: memories.length }
	)

	// Budget allocation with gists
	const selected: RetrievalResult[] = []
	let tokensUsed = 0

	for (const result of results) {
		const memory = memories[result.index]
		if (!memory) continue

		const tokens = estimateTokens(memory.gist)
		if (tokensUsed + tokens <= tokenBudget) {
			selected.push({
				memoryId: memory.id,
				score: result.totalActivation,
				tokensUsed: tokens,
				text: memory.gist,
			})
			tokensUsed += tokens
		} else {
			break
		}
	}

	return selected
}

/**
 * Strategy 2: claude-mem (3-layer progressive disclosure)
 * - Layer 1: Compact index (~10 tokens per entry, IDs only)
 * - Layer 2: Timeline context (~30 tokens per entry)
 * - Layer 3: Full details on demand
 *
 * Simulates their workflow: search → timeline → get_observations
 */
function retrieveClaudeMem(
	query: number[],
	memories: Memory[],
	tokenBudget: number
): RetrievalResult[] {
	// Layer 1: Vector search returns top 20 by similarity
	const similarities = cosineSimilarityBatch(
		query,
		memories.map((m) => m.embedding)
	)
	const indexed = similarities.map((sim, idx) => ({ sim, idx }))
	indexed.sort((a, b) => b.sim - a.sim)
	const top20 = indexed.slice(0, 20)

	// Layer 1 cost: ~10 tokens per ID entry (ID + type + date)
	const layer1TokensPerEntry = 10
	const layer1Tokens = Math.min(top20.length, 10) * layer1TokensPerEntry // Usually show top 10

	// Layer 2: Timeline context for subset (~30 tokens each)
	const layer2TokensPerEntry = 30
	const layer2Entries = Math.min(5, top20.length) // Usually drill into 5
	const layer2Tokens = layer2Entries * layer2TokensPerEntry

	// Layer 3: Full content for selected items
	// Calculate how many full items fit in remaining budget
	const overheadTokens = layer1Tokens + layer2Tokens
	const remainingBudget = tokenBudget - overheadTokens

	const selected: RetrievalResult[] = []
	let tokensUsed = overheadTokens

	// Get full content for top matches within budget
	for (let i = 0; i < layer2Entries && i < top20.length; i++) {
		const entry = top20[i]
		if (!entry) continue
		const memory = memories[entry.idx]
		if (!memory) continue

		// claude-mem returns full content, not gists
		const tokens = estimateTokens(memory.content)
		if (tokensUsed + tokens <= tokenBudget) {
			selected.push({
				memoryId: memory.id,
				score: entry.sim,
				tokensUsed: tokens,
				text: memory.content,
			})
			tokensUsed += tokens
		}
	}

	// Account for overhead in token usage
	if (selected.length > 0) {
		selected[0]!.tokensUsed += overheadTokens
	}

	return selected
}

/**
 * Strategy 3: Pinecone/RAG (fixed chunks)
 * - Pre-chunked at 256 tokens
 * - Returns top-k by similarity
 * - No compression or budgeting
 */
function retrievePineconeRAG(
	query: number[],
	memories: Memory[],
	tokenBudget: number,
	chunkSize = 256
): RetrievalResult[] {
	// Simulate chunked content (memories are already chunks in this sim)
	const similarities = cosineSimilarityBatch(
		query,
		memories.map((m) => m.embedding)
	)
	const indexed = similarities.map((sim, idx) => ({ sim, idx }))
	indexed.sort((a, b) => b.sim - a.sim)

	// Return as many chunks as fit in budget
	const selected: RetrievalResult[] = []
	let tokensUsed = 0

	for (const entry of indexed) {
		const memory = memories[entry.idx]
		if (!memory) continue

		// RAG returns full chunk (simulate fixed chunk size)
		const chunkContent = memory.content.slice(0, chunkSize * 4) // ~256 tokens
		const tokens = estimateTokens(chunkContent)

		if (tokensUsed + tokens <= tokenBudget) {
			selected.push({
				memoryId: memory.id,
				score: entry.sim,
				tokensUsed: tokens,
				text: chunkContent,
			})
			tokensUsed += tokens
		} else {
			break
		}
	}

	return selected
}

// ============================================================================
// Benchmark Scenarios
// ============================================================================

interface BenchmarkResult {
	strategy: string
	scenario: string
	tokenBudget: number
	tokensUsed: number
	memoriesRetrieved: number
	relevantRetrieved: number
	totalRelevant: number
	precision: number
	recall: number
	tokenEfficiency: number // relevant memories per 100 tokens
	informationDensity: number // relevance sum per token
}

function runBenchmark(
	scenario: string,
	memories: Memory[],
	query: number[],
	tokenBudget: number
): BenchmarkResult[] {
	const relevantIndices = new Set(
		memories
			.map((m, i) => ({ m, i }))
			.filter(({ m }) => m.relevance >= 0.5)
			.map(({ i }) => i)
	)

	const results: BenchmarkResult[] = []

	// Test each strategy
	const strategies = [
		{ name: "lucid-memory", fn: retrieveLucidMemory },
		{ name: "claude-mem", fn: retrieveClaudeMem },
		{ name: "pinecone-rag", fn: retrievePineconeRAG },
	]

	for (const strategy of strategies) {
		const retrieved = strategy.fn(query, memories, tokenBudget)
		const tokensUsed = retrieved.reduce((sum, r) => sum + r.tokensUsed, 0)
		const retrievedIds = new Set(retrieved.map((r) => r.memoryId))
		const relevantRetrieved = [...retrievedIds].filter((id) => {
			const idx = memories.findIndex((m) => m.id === id)
			return idx >= 0 && relevantIndices.has(idx)
		}).length

		const relevanceSum = retrieved.reduce((sum, r) => {
			const memory = memories.find((m) => m.id === r.memoryId)
			return sum + (memory?.relevance ?? 0)
		}, 0)

		results.push({
			strategy: strategy.name,
			scenario,
			tokenBudget,
			tokensUsed,
			memoriesRetrieved: retrieved.length,
			relevantRetrieved,
			totalRelevant: relevantIndices.size,
			precision:
				retrieved.length > 0 ? relevantRetrieved / retrieved.length : 0,
			recall:
				relevantIndices.size > 0 ? relevantRetrieved / relevantIndices.size : 0,
			tokenEfficiency:
				tokensUsed > 0 ? (relevantRetrieved / tokensUsed) * 100 : 0,
			informationDensity: tokensUsed > 0 ? relevanceSum / tokensUsed : 0,
		})
	}

	return results
}

// ============================================================================
// Scenario Setup
// ============================================================================

function createScenario(
	name: string,
	memoryCount: number,
	relevantCount: number,
	contentType: "short" | "medium" | "long"
): { name: string; memories: Memory[]; query: number[] } {
	const query = makeEmbedding(1000)
	const memories: Memory[] = []

	// Create relevant memories (high similarity)
	for (let i = 0; i < relevantCount; i++) {
		const similarity = 0.85 + Math.random() * 0.1 // 0.85-0.95
		const content = generateMemoryContent(2000 + i, contentType)
		memories.push({
			id: i,
			content,
			gist: generateGist(content),
			embedding: makeSimilarEmbedding(query, similarity, 2000 + i),
			accessHistory: [NOW - (1 + Math.random() * 7) * MS_DAY],
			relevance: 0.8 + Math.random() * 0.2,
		})
	}

	// Create noise memories (low similarity)
	for (let i = relevantCount; i < memoryCount; i++) {
		const similarity = 0.1 + Math.random() * 0.4 // 0.1-0.5
		const content = generateMemoryContent(3000 + i, contentType)
		memories.push({
			id: i,
			content,
			gist: generateGist(content),
			embedding: makeSimilarEmbedding(query, similarity, 3000 + i),
			accessHistory: [NOW - (1 + Math.random() * 30) * MS_DAY],
			relevance: Math.random() * 0.3,
		})
	}

	return { name, memories, query }
}

// ============================================================================
// Main
// ============================================================================

console.log(
	"╔════════════════════════════════════════════════════════════════════╗"
)
console.log(
	"║              Token Efficiency Benchmarks                           ║"
)
console.log(
	"║                                                                    ║"
)
console.log(
	"║  Comparing lucid-memory vs claude-mem vs Pinecone/RAG            ║"
)
console.log(
	"║  at various token budgets.                                        ║"
)
console.log(
	"╚════════════════════════════════════════════════════════════════════╝\n"
)

const scenarios = [
	createScenario("small_short", 50, 5, "short"),
	createScenario("medium_mixed", 100, 10, "medium"),
	createScenario("large_long", 200, 15, "long"),
]

const tokenBudgets = [100, 300, 500, 1000]

const allResults: BenchmarkResult[] = []

for (const scenario of scenarios) {
	for (const budget of tokenBudgets) {
		const results = runBenchmark(
			scenario.name,
			scenario.memories,
			scenario.query,
			budget
		)
		allResults.push(...results)
	}
}

// Print results by scenario
console.log(
	"\n═══════════════════════════════════════════════════════════════════════════════════════"
)
console.log(" Results by Scenario & Token Budget")
console.log(
	"═══════════════════════════════════════════════════════════════════════════════════════\n"
)

for (const scenario of scenarios) {
	console.log(
		`\n┌─ ${scenario.name} (${scenario.memories.length} memories, ${scenario.memories.filter((m) => m.relevance >= 0.5).length} relevant) ─────────────────────────────────────────────┐`
	)
	console.log(
		"│                                                                                           │"
	)
	console.log(
		"│  Budget │   Strategy    │ Tokens │ Memories │ Relevant │ Precision │  Recall │ Efficiency │"
	)
	console.log(
		"│─────────┼───────────────┼────────┼──────────┼──────────┼───────────┼─────────┼────────────│"
	)

	for (const budget of tokenBudgets) {
		const scenarioResults = allResults.filter(
			(r) => r.scenario === scenario.name && r.tokenBudget === budget
		)

		for (const r of scenarioResults) {
			const budgetStr =
				budget === tokenBudgets[0] ? budget.toString().padStart(7) : "       "
			const strategy = r.strategy.padEnd(13)
			const tokens = r.tokensUsed.toString().padStart(6)
			const memories = r.memoriesRetrieved.toString().padStart(8)
			const relevant = r.relevantRetrieved.toString().padStart(8)
			const precision = `${(r.precision * 100).toFixed(0)}%`.padStart(9)
			const recall = `${(r.recall * 100).toFixed(0)}%`.padStart(7)
			const efficiency = `${r.tokenEfficiency.toFixed(2)}`.padStart(10)

			console.log(
				`│ ${budgetStr} │ ${strategy} │ ${tokens} │ ${memories} │ ${relevant} │ ${precision} │ ${recall} │ ${efficiency} │`
			)
		}
		if (budget !== tokenBudgets[tokenBudgets.length - 1]) {
			console.log(
				"│         │               │        │          │          │           │         │            │"
			)
		}
	}
	console.log(
		"└─────────────────────────────────────────────────────────────────────────────────────────────┘"
	)
}

// Summary statistics
console.log(
	"\n═══════════════════════════════════════════════════════════════════════════════════════"
)
console.log(" Summary Statistics")
console.log(
	"═══════════════════════════════════════════════════════════════════════════════════════\n"
)

const strategies = ["lucid-memory", "claude-mem", "pinecone-rag"]

for (const strategy of strategies) {
	const strategyResults = allResults.filter((r) => r.strategy === strategy)
	const avgPrecision =
		strategyResults.reduce((sum, r) => sum + r.precision, 0) /
		strategyResults.length
	const avgRecall =
		strategyResults.reduce((sum, r) => sum + r.recall, 0) /
		strategyResults.length
	const avgEfficiency =
		strategyResults.reduce((sum, r) => sum + r.tokenEfficiency, 0) /
		strategyResults.length
	const avgTokensUsed =
		strategyResults.reduce((sum, r) => sum + r.tokensUsed, 0) /
		strategyResults.length
	const avgMemories =
		strategyResults.reduce((sum, r) => sum + r.memoriesRetrieved, 0) /
		strategyResults.length

	console.log(`${strategy}:`)
	console.log(`  Avg Precision:  ${(avgPrecision * 100).toFixed(1)}%`)
	console.log(`  Avg Recall:     ${(avgRecall * 100).toFixed(1)}%`)
	console.log(
		`  Avg Efficiency: ${avgEfficiency.toFixed(2)} relevant/100 tokens`
	)
	console.log(`  Avg Tokens:     ${avgTokensUsed.toFixed(0)} tokens`)
	console.log(`  Avg Memories:   ${avgMemories.toFixed(1)} memories`)
	console.log("")
}

// Head-to-head comparison
console.log(
	"═══════════════════════════════════════════════════════════════════════════════════════"
)
console.log(" Head-to-Head: lucid-memory vs Others")
console.log(
	"═══════════════════════════════════════════════════════════════════════════════════════\n"
)

const lucidResults = allResults.filter((r) => r.strategy === "lucid-memory")
const claudeMemResults = allResults.filter((r) => r.strategy === "claude-mem")
const pineconeResults = allResults.filter((r) => r.strategy === "pinecone-rag")

const lucidAvgEfficiency =
	lucidResults.reduce((sum, r) => sum + r.tokenEfficiency, 0) /
	lucidResults.length
const claudeMemAvgEfficiency =
	claudeMemResults.reduce((sum, r) => sum + r.tokenEfficiency, 0) /
	claudeMemResults.length
const pineconeAvgEfficiency =
	pineconeResults.reduce((sum, r) => sum + r.tokenEfficiency, 0) /
	pineconeResults.length

const lucidAvgRecall =
	lucidResults.reduce((sum, r) => sum + r.recall, 0) / lucidResults.length
const claudeMemAvgRecall =
	claudeMemResults.reduce((sum, r) => sum + r.recall, 0) /
	claudeMemResults.length
const pineconeAvgRecall =
	pineconeResults.reduce((sum, r) => sum + r.recall, 0) / pineconeResults.length

console.log("Token Efficiency (relevant memories per 100 tokens):")
console.log(`  lucid-memory:  ${lucidAvgEfficiency.toFixed(2)}`)
console.log(
	`  claude-mem:    ${claudeMemAvgEfficiency.toFixed(2)} (${((lucidAvgEfficiency / claudeMemAvgEfficiency - 1) * 100).toFixed(0)}% ${lucidAvgEfficiency > claudeMemAvgEfficiency ? "behind" : "ahead"})`
)
console.log(
	`  pinecone-rag:  ${pineconeAvgEfficiency.toFixed(2)} (${((lucidAvgEfficiency / pineconeAvgEfficiency - 1) * 100).toFixed(0)}% ${lucidAvgEfficiency > pineconeAvgEfficiency ? "behind" : "ahead"})`
)
console.log("")

console.log("Recall (fraction of relevant memories retrieved):")
console.log(`  lucid-memory:  ${(lucidAvgRecall * 100).toFixed(1)}%`)
console.log(`  claude-mem:    ${(claudeMemAvgRecall * 100).toFixed(1)}%`)
console.log(`  pinecone-rag:  ${(pineconeAvgRecall * 100).toFixed(1)}%`)
console.log("")

// Storage overhead analysis
console.log(
	"═══════════════════════════════════════════════════════════════════════════════════════"
)
console.log(" Storage Overhead Analysis")
console.log(
	"═══════════════════════════════════════════════════════════════════════════════════════\n"
)

const mediumScenario = scenarios.find((s) => s.name === "medium_mixed")
if (mediumScenario) {
	const totalContentTokens = mediumScenario.memories.reduce(
		(sum, m) => sum + estimateTokens(m.content),
		0
	)
	const totalGistTokens = mediumScenario.memories.reduce(
		(sum, m) => sum + estimateTokens(m.gist),
		0
	)
	const compressionRatio = totalContentTokens / totalGistTokens

	console.log(
		`Scenario: ${mediumScenario.name} (${mediumScenario.memories.length} memories)`
	)
	console.log(`  Total content tokens: ${totalContentTokens}`)
	console.log(`  Total gist tokens:    ${totalGistTokens}`)
	console.log(`  Compression ratio:    ${compressionRatio.toFixed(1)}x`)
	console.log(
		`  Token savings:        ${((1 - 1 / compressionRatio) * 100).toFixed(0)}%`
	)
	console.log("")
	console.log(`  lucid-memory stores gists → ${totalGistTokens} tokens`)
	console.log(`  claude-mem stores full content → ${totalContentTokens} tokens`)
	console.log(
		`  pinecone-rag stores chunks → ${totalContentTokens} tokens (no compression)`
	)
}

console.log("\n")
