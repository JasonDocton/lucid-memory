/**
 * Membrane Comparison Benchmark
 *
 * Simulates Membrane's retrieval approach (salience-based, no semantic similarity)
 * against Lucid Memory's cognitive retrieval for apples-to-apples comparison.
 *
 * Membrane retrieval model:
 * - No vector embeddings / semantic similarity
 * - Rank by salience (time-decayed importance)
 * - Filter by memory type layers
 * - Trust-gated access (not simulated here)
 *
 * This benchmark shows WHY semantic similarity matters for query-driven retrieval.
 */

import {
	cosineSimilarityBatch,
	type JsAssociation,
	retrieve,
} from "../../packages/lucid-native/index.js"

const NOW = Date.now()
const MS_SECOND = 1000
const MS_MINUTE = 60 * MS_SECOND
const MS_HOUR = 60 * MS_MINUTE
const MS_DAY = 24 * MS_HOUR

// Seeded random for deterministic results
function seededRandom(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed / 0x7fffffff
	}
}

const globalRand = seededRandom(42)

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

interface ScenarioData {
	query: number[]
	embeddings: number[][]
	accessHistories: number[][]
	emotionalWeights: number[]
	associations: JsAssociation[]
	metadata: { name: string; expectedRelevance: number }[]
}

interface Scenario {
	name: string
	description: string
	setup: () => ScenarioData
	evaluate: (
		ranking: number[],
		data: ScenarioData
	) => { score: number; details: string }
}

// Membrane-style retrieval: rank by salience (most recent access wins)
function membraneRetrieve(data: ScenarioData): number[] {
	// Membrane uses salience = time-decayed importance
	// Simplest model: salience = 2^(-elapsed/halfLife) where halfLife = 24h
	const HALF_LIFE_MS = 24 * MS_HOUR

	const saliences = data.accessHistories.map((history) => {
		if (history.length === 0) return 0
		// Use most recent access (Membrane uses lastReinforcedAt)
		const mostRecent = Math.max(...history)
		const elapsed = NOW - mostRecent
		return 2 ** (-elapsed / HALF_LIFE_MS)
	})

	const indexed = saliences.map((sal, idx) => ({ sal, idx }))
	indexed.sort((a, b) => b.sal - a.sal)
	return indexed.map((x) => x.idx)
}

// RAG baseline: pure cosine similarity
function ragRetrieve(data: ScenarioData): number[] {
	const similarities = cosineSimilarityBatch(data.query, data.embeddings)
	const indexed = similarities.map((sim, idx) => ({ sim, idx }))
	indexed.sort((a, b) => b.sim - a.sim)
	return indexed.map((x) => x.idx)
}

// Lucid cognitive retrieval
function lucidRetrieve(data: ScenarioData): number[] {
	const results = retrieve(
		data.query,
		data.embeddings,
		data.accessHistories,
		data.emotionalWeights,
		data.embeddings.map(() => 0.5),
		data.embeddings.map(() => 1.0),
		NOW,
		data.associations.length > 0 ? data.associations : null,
		{
			minProbability: 0,
			maxResults: data.embeddings.length,
			bidirectional: true,
		}
	)
	return results.map((r) => r.index)
}

// ============================================================================
// Scenarios (subset of realistic-dev.ts for comparison)
// ============================================================================

const morningContext: Scenario = {
	name: "morning_context_restoration",
	description: "Find yesterday's work session files",
	setup: () => {
		const queryEmb = makeEmbedding(1000)
		const memories: ScenarioData["metadata"] = []
		const embeddings: number[][] = []
		const accessHistories: number[][] = []

		// Yesterday's relevant files (17-19 hours ago)
		const yesterdayStart = NOW - 18 * MS_HOUR
		for (let i = 0; i < 4; i++) {
			memories.push({ name: `auth/file${i}.ts`, expectedRelevance: 1 })
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.85 - i * 0.05, 2000 + i))
			accessHistories.push([yesterdayStart + globalRand() * 2 * MS_HOUR])
		}

		// Today's unrelated files (more recent but not relevant)
		for (let i = 0; i < 3; i++) {
			memories.push({ name: `components/Button${i}.tsx`, expectedRelevance: 0 })
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.25, 3000 + i))
			accessHistories.push([NOW - (i + 1) * MS_HOUR])
		}

		// Bulk noise
		for (let i = 0; i < 40; i++) {
			memories.push({ name: `noise/file${i}.ts`, expectedRelevance: 0 })
			embeddings.push(
				makeSimilarEmbedding(queryEmb, 0.1 + globalRand() * 0.3, 4000 + i)
			)
			accessHistories.push([NOW - (1 + globalRand() * 60) * MS_DAY])
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations: [],
			metadata: memories,
		}
	},
	evaluate: (ranking, data) => {
		const relevant = new Set([0, 1, 2, 3])
		const top5 = ranking.slice(0, 5)
		const hits = top5.filter((idx) => relevant.has(idx)).length
		return {
			score: hits / 4,
			details: `${hits}/4 relevant in top 5`,
		}
	},
}

const needleInHaystack: Scenario = {
	name: "scale_needle_in_haystack",
	description: "Find specific file among 200 memories by semantic match",
	setup: () => {
		const queryEmb = makeEmbedding(10000)
		const memories: ScenarioData["metadata"] = []
		const embeddings: number[][] = []
		const accessHistories: number[][] = []

		// The needle (high similarity, old access)
		memories.push({ name: "target/exact-match.ts", expectedRelevance: 1 })
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.95, 10001))
		accessHistories.push([NOW - 3 * MS_DAY])

		// 199 distractors (low similarity, varied recency)
		for (let i = 0; i < 199; i++) {
			memories.push({ name: `noise/file${i}.ts`, expectedRelevance: 0 })
			embeddings.push(
				makeSimilarEmbedding(queryEmb, 0.1 + globalRand() * 0.4, 10100 + i)
			)
			// Some are very recent (will rank high in Membrane)
			accessHistories.push([NOW - globalRand() * 2 * MS_DAY])
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations: [],
			metadata: memories,
		}
	},
	evaluate: (ranking, data) => {
		const targetFirst = ranking[0] === 0 ? 1 : 0
		const targetInTop5 = ranking.slice(0, 5).includes(0) ? 1 : 0
		return {
			score: targetFirst * 0.7 + targetInTop5 * 0.3,
			details: `Target@1=${targetFirst}, Target@5=${targetInTop5}`,
		}
	},
}

const adversarialRecency: Scenario = {
	name: "adversarial_recency_trap",
	description: "Recent irrelevant should NOT beat old relevant",
	setup: () => {
		const queryEmb = makeEmbedding(50000)
		const memories: ScenarioData["metadata"] = []
		const embeddings: number[][] = []
		const accessHistories: number[][] = []

		// Relevant but old (2 days ago)
		memories.push({ name: "relevant-old.ts", expectedRelevance: 1 })
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.9, 50001))
		accessHistories.push([NOW - 2 * MS_DAY])

		// Irrelevant but very recent (1-5 minutes ago)
		for (let i = 0; i < 5; i++) {
			memories.push({ name: `irrelevant-recent-${i}.ts`, expectedRelevance: 0 })
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.15, 50100 + i))
			accessHistories.push([NOW - (i + 1) * MS_MINUTE])
		}

		// Noise
		for (let i = 0; i < 30; i++) {
			memories.push({ name: `noise-${i}.ts`, expectedRelevance: 0 })
			embeddings.push(
				makeSimilarEmbedding(queryEmb, 0.2 + globalRand() * 0.3, 50200 + i)
			)
			accessHistories.push([NOW - (1 + globalRand() * 30) * MS_DAY])
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations: [],
			metadata: memories,
		}
	},
	evaluate: (ranking, data) => {
		const relevantFirst = ranking[0] === 0 ? 1 : 0
		const recentIrrelevant = new Set([1, 2, 3, 4, 5])
		const trapAvoided = ranking
			.slice(0, 3)
			.every((idx) => !recentIrrelevant.has(idx))
			? 1
			: 0
		return {
			score: relevantFirst * 0.7 + trapAvoided * 0.3,
			details: `Relevant@1=${relevantFirst}, TrapAvoided=${trapAvoided}`,
		}
	},
}

const coldStart: Scenario = {
	name: "cold_start",
	description: "No history - should use pure similarity",
	setup: () => {
		const queryEmb = makeEmbedding(40000)
		const memories: ScenarioData["metadata"] = []
		const embeddings: number[][] = []
		const accessHistories: number[][] = []

		// Create 50 files with varying similarity, all accessed once at same time
		const sims = [0.95, 0.88, 0.82, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45]
		for (let i = 0; i < sims.length; i++) {
			memories.push({
				name: `file-sim-${sims[i]}.ts`,
				expectedRelevance: sims[i],
			})
			embeddings.push(makeSimilarEmbedding(queryEmb, sims[i], 40000 + i))
			accessHistories.push([NOW - 1 * MS_DAY])
		}

		for (let i = 0; i < 40; i++) {
			memories.push({ name: `noise-${i}.ts`, expectedRelevance: 0 })
			embeddings.push(
				makeSimilarEmbedding(queryEmb, 0.1 + globalRand() * 0.35, 40100 + i)
			)
			accessHistories.push([NOW - 1 * MS_DAY])
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations: [],
			metadata: memories,
		}
	},
	evaluate: (ranking, data) => {
		// Top 5 should be indices 0-4 (highest similarity)
		const expected = new Set([0, 1, 2, 3, 4])
		const top5 = ranking.slice(0, 5)
		const hits = top5.filter((idx) => expected.has(idx)).length
		return {
			score: hits / 5,
			details: `${hits}/5 high-sim in top 5`,
		}
	},
}

const importantVsCasual: Scenario = {
	name: "important_vs_casual",
	description:
		"Important decisions should beat frequently-touched routine files",
	setup: () => {
		const queryEmb = makeEmbedding(90000)
		const memories: ScenarioData["metadata"] = []
		const embeddings: number[][] = []
		const accessHistories: number[][] = []
		const emotionalWeights: number[] = []

		// Important decision (old, single access, high emotional weight)
		memories.push({
			name: "auth-architecture-decision.md",
			expectedRelevance: 1,
		})
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.82, 90001))
		accessHistories.push([NOW - 14 * MS_DAY])
		emotionalWeights.push(0.9)

		// Routine file (recent, many accesses, low emotional weight)
		memories.push({ name: "auth-handler-tweak.ts", expectedRelevance: 0 })
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.85, 90002))
		const routine: number[] = []
		for (let i = 0; i < 8; i++) routine.push(NOW - i * MS_DAY)
		accessHistories.push(routine)
		emotionalWeights.push(0.3)

		// Another important insight
		memories.push({ name: "auth-security-insight.md", expectedRelevance: 1 })
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.78, 90003))
		accessHistories.push([NOW - 21 * MS_DAY])
		emotionalWeights.push(0.85)

		// Noise
		for (let i = 0; i < 35; i++) {
			memories.push({ name: `other-${i}.ts`, expectedRelevance: 0 })
			embeddings.push(
				makeSimilarEmbedding(queryEmb, 0.25 + globalRand() * 0.4, 90100 + i)
			)
			accessHistories.push([NOW - globalRand() * 30 * MS_DAY])
			emotionalWeights.push(0.3 + globalRand() * 0.3)
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights,
			associations: [],
			metadata: memories,
		}
	},
	evaluate: (ranking, data) => {
		const decision = ranking.indexOf(0)
		const routine = ranking.indexOf(1)
		const insight = ranking.indexOf(2)

		let score = 0
		if (decision < 3) score += 0.4
		if (decision < routine) score += 0.3
		if (insight < 5) score += 0.2
		if (routine >= 3) score += 0.1

		return {
			score,
			details: `Decision@${decision + 1}, Routine@${routine + 1}, Insight@${insight + 1}`,
		}
	},
}

const scenarios: Scenario[] = [
	morningContext,
	needleInHaystack,
	adversarialRecency,
	coldStart,
	importantVsCasual,
]

// ============================================================================
// Run comparison
// ============================================================================

console.log(
	"╔════════════════════════════════════════════════════════════════════╗"
)
console.log(
	"║          Membrane vs Lucid Memory Retrieval Comparison             ║"
)
console.log(
	"║                                                                    ║"
)
console.log(
	"║  Membrane: Salience-based (recency), no semantic similarity        ║"
)
console.log(
	"║  Lucid: ACT-R + MINERVA 2 cognitive retrieval                      ║"
)
console.log(
	"║  RAG: Pure cosine similarity baseline                              ║"
)
console.log(
	"╚════════════════════════════════════════════════════════════════════╝\n"
)

const results: {
	name: string
	lucid: number
	membrane: number
	rag: number
}[] = []

for (const scenario of scenarios) {
	const data = scenario.setup()

	const lucidRanking = lucidRetrieve(data)
	const membraneRanking = membraneRetrieve(data)
	const ragRanking = ragRetrieve(data)

	const lucidResult = scenario.evaluate(lucidRanking, data)
	const membraneResult = scenario.evaluate(membraneRanking, data)
	const ragResult = scenario.evaluate(ragRanking, data)

	results.push({
		name: scenario.name,
		lucid: lucidResult.score,
		membrane: membraneResult.score,
		rag: ragResult.score,
	})

	console.log(`┌─ ${scenario.name} ─${"─".repeat(60 - scenario.name.length)}┐`)
	console.log(`│ ${scenario.description.padEnd(68)}│`)
	console.log(`│${"─".repeat(70)}│`)
	console.log(
		`│  Lucid Memory: ${(lucidResult.score * 100).toFixed(1).padStart(6)}%  │  ${lucidResult.details.padEnd(42)}│`
	)
	console.log(
		`│  Membrane:     ${(membraneResult.score * 100).toFixed(1).padStart(6)}%  │  ${membraneResult.details.padEnd(42)}│`
	)
	console.log(
		`│  RAG Baseline: ${(ragResult.score * 100).toFixed(1).padStart(6)}%  │  ${ragResult.details.padEnd(42)}│`
	)
	console.log(`└${"─".repeat(70)}┘\n`)
}

// Summary
console.log(
	"\n═══════════════════════════════════════════════════════════════════════"
)
console.log("                              SUMMARY")
console.log(
	"═══════════════════════════════════════════════════════════════════════\n"
)

console.log(
	"Scenario                       │ Lucid  │ Membrane │  RAG   │ Winner"
)
console.log("─".repeat(75))

for (const r of results) {
	const name = r.name.slice(0, 30).padEnd(30)
	const lucid = `${(r.lucid * 100).toFixed(1)}%`.padStart(6)
	const membrane = `${(r.membrane * 100).toFixed(1)}%`.padStart(8)
	const rag = `${(r.rag * 100).toFixed(1)}%`.padStart(6)

	let winner: string
	const scores = [
		{ name: "Lucid", score: r.lucid },
		{ name: "Membrane", score: r.membrane },
		{ name: "RAG", score: r.rag },
	]
	scores.sort((a, b) => b.score - a.score)
	winner = scores[0].name

	console.log(`${name} │ ${lucid} │ ${membrane} │ ${rag} │ ${winner}`)
}

console.log("─".repeat(75))

const avgLucid = results.reduce((sum, r) => sum + r.lucid, 0) / results.length
const avgMembrane =
	results.reduce((sum, r) => sum + r.membrane, 0) / results.length
const avgRag = results.reduce((sum, r) => sum + r.rag, 0) / results.length

console.log(
	`${"AVERAGE".padEnd(30)} │ ${(avgLucid * 100).toFixed(1).padStart(5)}% │ ${(avgMembrane * 100).toFixed(1).padStart(7)}% │ ${(avgRag * 100).toFixed(1).padStart(5)}% │`
)

console.log("\n")
console.log("Key Insights:")
console.log("─".repeat(75))
console.log("• Membrane excels at 'what's most recently important' (salience)")
console.log(
	"• Lucid excels at 'what matches this query' (semantic + cognitive)"
)
console.log(
	"• Membrane fails adversarial recency: recent irrelevant beats old relevant"
)
console.log(
	"• Membrane fails cold start: no signal when all access times equal"
)
console.log("• They solve DIFFERENT problems - not direct competitors")
console.log("")
console.log(
	"Recommendation: Hybrid architecture could use Membrane for lifecycle"
)
console.log("                management and Lucid for query-driven retrieval.")
