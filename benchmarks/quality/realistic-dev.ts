/**
 * Realistic Developer Workflow Benchmarks
 *
 * These benchmarks simulate actual developer behavior, not idealized scenarios.
 * The goal is to expose weaknesses and guide improvements, not look good.
 *
 * Key principles:
 * 1. Realistic timing (minutes/hours, not seconds)
 * 2. Realistic scale (50-500 memories, not 2-3)
 * 3. Realistic similarity distributions (not hand-tuned gaps)
 * 4. Include failure cases where we SHOULD struggle
 */

import {
	retrieve,
	cosineSimilarityBatch,
	type JsAssociation,
} from "../../packages/lucid-native/index.js";

const VERBOSE = process.argv.includes("--verbose");

// Time constants
const MS_SECOND = 1000;
const MS_MINUTE = 60 * MS_SECOND;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;
const NOW = Date.now();

// Generate realistic embeddings using random but reproducible vectors
function seededRandom(seed: number): () => number {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

function makeEmbedding(seed: number, dim = 384): number[] {
	const rand = seededRandom(seed);
	const emb = Array.from({ length: dim }, () => rand() * 2 - 1);
	const norm = Math.sqrt(emb.reduce((sum, x) => sum + x * x, 0));
	return emb.map((x) => x / norm);
}

// Create embeddings with controlled similarity to a base
function makeSimilarEmbedding(base: number[], similarity: number, seed: number): number[] {
	const rand = seededRandom(seed);
	const noise = Array.from({ length: base.length }, () => rand() * 2 - 1);
	const noiseNorm = Math.sqrt(noise.reduce((sum, x) => sum + x * x, 0));
	const normalizedNoise = noise.map((x) => x / noiseNorm);

	// Blend base with noise to achieve target similarity
	const blend = Math.sqrt(1 - similarity * similarity);
	const result = base.map((b, i) => similarity * b + blend * normalizedNoise[i]);
	const norm = Math.sqrt(result.reduce((sum, x) => sum + x * x, 0));
	return result.map((x) => x / norm);
}

interface RealisticScenario {
	name: string;
	description: string;
	difficulty: "easy" | "medium" | "hard" | "adversarial";
	setup: () => ScenarioData;
	evaluate: (ranking: number[], data: ScenarioData) => EvalResult;
}

interface ScenarioData {
	query: number[];
	embeddings: number[][];
	accessHistories: number[][];
	emotionalWeights: number[];
	associations: JsAssociation[];
	metadata: { name: string; expectedRelevance: number }[];
}

interface EvalResult {
	score: number;
	maxScore: number;
	details: string;
}

// Metrics
function computePrecisionAtK(ranking: number[], relevantIndices: Set<number>, k: number): number {
	const topK = ranking.slice(0, k);
	const hits = topK.filter((idx) => relevantIndices.has(idx)).length;
	return hits / k;
}

function computeRecallAtK(ranking: number[], relevantIndices: Set<number>, k: number): number {
	if (relevantIndices.size === 0) return 1;
	const topK = ranking.slice(0, k);
	const hits = topK.filter((idx) => relevantIndices.has(idx)).length;
	return hits / relevantIndices.size;
}

function computeMRR(ranking: number[], relevantIndices: Set<number>): number {
	for (let i = 0; i < ranking.length; i++) {
		if (relevantIndices.has(ranking[i])) {
			return 1 / (i + 1);
		}
	}
	return 0;
}

// ============================================================================
// SCENARIO 1: Morning Context Restoration
// "I was debugging the auth module yesterday afternoon, where was I?"
// ============================================================================
const morningContextRestoration: RealisticScenario = {
	name: "morning_context_restoration",
	description: "Developer returns next morning, wants to find where they left off yesterday",
	difficulty: "medium",
	setup: () => {
		// Yesterday's work session: 5pm-7pm (17-19 hours ago)
		const yesterdayStart = NOW - 18 * MS_HOUR;
		const yesterdayEnd = NOW - 16 * MS_HOUR;

		// Query: "auth module debugging" - what they remember working on
		const queryEmb = makeEmbedding(1000);

		const memories: ScenarioData["metadata"] = [];
		const embeddings: number[][] = [];
		const accessHistories: number[][] = [];

		// Files from yesterday's session (relevant)
		const yesterdayFiles = [
			{ name: "auth/handler.ts", similarity: 0.85, accesses: 12 },
			{ name: "auth/middleware.ts", similarity: 0.80, accesses: 8 },
			{ name: "auth/types.ts", similarity: 0.75, accesses: 5 },
			{ name: "auth/tests/handler.test.ts", similarity: 0.70, accesses: 6 },
		];

		for (let i = 0; i < yesterdayFiles.length; i++) {
			const file = yesterdayFiles[i];
			memories.push({ name: file.name, expectedRelevance: 1 });
			embeddings.push(makeSimilarEmbedding(queryEmb, file.similarity, 2000 + i));
			// Spread accesses across yesterday's session
			const accesses: number[] = [];
			for (let j = 0; j < file.accesses; j++) {
				accesses.push(yesterdayStart + Math.random() * (yesterdayEnd - yesterdayStart));
			}
			accessHistories.push(accesses);
		}

		// Older auth files (somewhat relevant but not from yesterday)
		const olderAuthFiles = [
			{ name: "auth/oauth.ts", similarity: 0.82, daysAgo: 14 },
			{ name: "auth/session.ts", similarity: 0.78, daysAgo: 30 },
		];

		for (let i = 0; i < olderAuthFiles.length; i++) {
			const file = olderAuthFiles[i];
			memories.push({ name: file.name, expectedRelevance: 0.3 });
			embeddings.push(makeSimilarEmbedding(queryEmb, file.similarity, 3000 + i));
			accessHistories.push([NOW - file.daysAgo * MS_DAY]);
		}

		// Unrelated files accessed recently (noise)
		const unrelatedRecent = [
			{ name: "components/Button.tsx", similarity: 0.25, hoursAgo: 2 },
			{ name: "utils/format.ts", similarity: 0.20, hoursAgo: 3 },
			{ name: "pages/index.tsx", similarity: 0.30, hoursAgo: 1 },
		];

		for (let i = 0; i < unrelatedRecent.length; i++) {
			const file = unrelatedRecent[i];
			memories.push({ name: file.name, expectedRelevance: 0 });
			embeddings.push(makeSimilarEmbedding(queryEmb, file.similarity, 4000 + i));
			accessHistories.push([NOW - file.hoursAgo * MS_HOUR]);
		}

		// Bulk noise: 40 random files from various times
		for (let i = 0; i < 40; i++) {
			const similarity = 0.1 + Math.random() * 0.4; // 0.1-0.5 similarity
			const daysAgo = 1 + Math.random() * 60; // 1-60 days ago
			memories.push({ name: `noise/file${i}.ts`, expectedRelevance: 0 });
			embeddings.push(makeSimilarEmbedding(queryEmb, similarity, 5000 + i));
			accessHistories.push([NOW - daysAgo * MS_DAY]);
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations: [],
			metadata: memories,
		};
	},
	evaluate: (ranking, data) => {
		// Success: Yesterday's files should be in top 5
		const yesterdayIndices = new Set([0, 1, 2, 3]);
		const p5 = computePrecisionAtK(ranking, yesterdayIndices, 5);
		const r5 = computeRecallAtK(ranking, yesterdayIndices, 5);
		const mrr = computeMRR(ranking, yesterdayIndices);

		return {
			score: (p5 + r5 + mrr) / 3,
			maxScore: 1,
			details: `P@5=${p5.toFixed(2)}, R@5=${r5.toFixed(2)}, MRR=${mrr.toFixed(2)}`,
		};
	},
};

// ============================================================================
// SCENARIO 2: Scale Test - Finding Needle in Haystack
// Large memory pool, looking for specific file
// ============================================================================
const scaleNeedleInHaystack: RealisticScenario = {
	name: "scale_needle_in_haystack",
	description: "Find a specific file among 200 memories with realistic similarity distribution",
	difficulty: "hard",
	setup: () => {
		const queryEmb = makeEmbedding(10000);
		const memories: ScenarioData["metadata"] = [];
		const embeddings: number[][] = [];
		const accessHistories: number[][] = [];

		// The needle: exact file we're looking for
		memories.push({ name: "target/exact-match.ts", expectedRelevance: 1 });
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.95, 10001));
		accessHistories.push([NOW - 3 * MS_DAY]); // 3 days ago

		// Near misses: similar but not quite right (5 files)
		for (let i = 0; i < 5; i++) {
			memories.push({ name: `similar/near-miss-${i}.ts`, expectedRelevance: 0.5 });
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.85 + Math.random() * 0.08, 10100 + i));
			accessHistories.push([NOW - (1 + Math.random() * 7) * MS_DAY]);
		}

		// Medium similarity files (20 files)
		for (let i = 0; i < 20; i++) {
			memories.push({ name: `medium/file-${i}.ts`, expectedRelevance: 0.2 });
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.5 + Math.random() * 0.3, 10200 + i));
			accessHistories.push([NOW - (1 + Math.random() * 30) * MS_DAY]);
		}

		// Low similarity bulk (174 files to reach 200 total)
		for (let i = 0; i < 174; i++) {
			memories.push({ name: `noise/bulk-${i}.ts`, expectedRelevance: 0 });
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.1 + Math.random() * 0.35, 10400 + i));
			accessHistories.push([NOW - (1 + Math.random() * 90) * MS_DAY]);
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations: [],
			metadata: memories,
		};
	},
	evaluate: (ranking, data) => {
		// Success: Target should be #1, near-misses in top 10
		const targetFound = ranking[0] === 0 ? 1 : 0;
		const nearMissIndices = new Set([1, 2, 3, 4, 5]);
		const nearMissRecall = computeRecallAtK(ranking, nearMissIndices, 10);

		return {
			score: targetFound * 0.6 + nearMissRecall * 0.4,
			maxScore: 1,
			details: `Target@1=${targetFound}, NearMiss-R@10=${nearMissRecall.toFixed(2)}`,
		};
	},
};

// ============================================================================
// SCENARIO 3: Recency vs Similarity Tradeoff
// Recent but less relevant vs old but highly relevant
// ============================================================================
const recencyVsSimilarity: RealisticScenario = {
	name: "recency_vs_similarity_tradeoff",
	description: "Balance between very recent low-match vs older high-match files",
	difficulty: "hard",
	setup: () => {
		const queryEmb = makeEmbedding(20000);
		const memories: ScenarioData["metadata"] = [];
		const embeddings: number[][] = [];
		const accessHistories: number[][] = [];

		// Highly relevant but old (7 days ago)
		memories.push({ name: "highly-relevant-old.ts", expectedRelevance: 1 });
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.92, 20001));
		accessHistories.push([NOW - 7 * MS_DAY]);

		// Less relevant but very recent (10 minutes ago)
		memories.push({ name: "less-relevant-recent.ts", expectedRelevance: 0.3 });
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.55, 20002));
		accessHistories.push([NOW - 10 * MS_MINUTE]);

		// Medium relevance, medium recency (1 day ago)
		memories.push({ name: "medium-medium.ts", expectedRelevance: 0.6 });
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.75, 20003));
		accessHistories.push([NOW - 1 * MS_DAY]);

		// Noise
		for (let i = 0; i < 30; i++) {
			memories.push({ name: `noise/file-${i}.ts`, expectedRelevance: 0 });
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.2 + Math.random() * 0.3, 20100 + i));
			accessHistories.push([NOW - (1 + Math.random() * 30) * MS_DAY]);
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations: [],
			metadata: memories,
		};
	},
	evaluate: (ranking, data) => {
		// This is subjective - what SHOULD the ranking be?
		// For a semantic search, similarity should win: [0, 2, 1]
		// We're testing if cognitive memory can balance these signals

		// Award points for having highly-relevant in top 2
		const highlyRelevantInTop2 = ranking.slice(0, 2).includes(0) ? 1 : 0;
		// Award points for not having low-relevance beat high-relevance
		const properOrdering = ranking.indexOf(0) < ranking.indexOf(1) ? 1 : 0;

		return {
			score: (highlyRelevantInTop2 + properOrdering) / 2,
			maxScore: 1,
			details: `HighRel@2=${highlyRelevantInTop2}, ProperOrder=${properOrdering}, Ranking=[${ranking.slice(0, 5).join(",")}]`,
		};
	},
};

// ============================================================================
// SCENARIO 4: Co-edited Files (Realistic Associations)
// Files that are actually edited together in practice
// ============================================================================
const coEditedFiles: RealisticScenario = {
	name: "co_edited_files",
	description: "Find files that are typically edited together (component + test + styles)",
	difficulty: "medium",
	setup: () => {
		const queryEmb = makeEmbedding(30000); // Query for "Button component"
		const memories: ScenarioData["metadata"] = [];
		const embeddings: number[][] = [];
		const accessHistories: number[][] = [];
		const associations: JsAssociation[] = [];

		// Button component (the query target)
		memories.push({ name: "components/Button.tsx", expectedRelevance: 1 });
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.95, 30001));
		// Accessed 5 times over past week, most recent 2 hours ago
		accessHistories.push([
			NOW - 2 * MS_HOUR,
			NOW - 1 * MS_DAY,
			NOW - 3 * MS_DAY,
			NOW - 5 * MS_DAY,
			NOW - 7 * MS_DAY,
		]);

		// Button test (always edited with component)
		memories.push({ name: "components/Button.test.tsx", expectedRelevance: 0.9 });
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.65, 30002)); // Less similar semantically
		accessHistories.push([
			NOW - 2 * MS_HOUR,
			NOW - 1 * MS_DAY,
			NOW - 3 * MS_DAY,
			NOW - 5 * MS_DAY,
		]);

		// Button styles (also co-edited)
		memories.push({ name: "components/Button.module.css", expectedRelevance: 0.8 });
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.35, 30003)); // Very different semantically
		accessHistories.push([
			NOW - 2 * MS_HOUR,
			NOW - 3 * MS_DAY,
			NOW - 7 * MS_DAY,
		]);

		// Associations based on co-editing
		associations.push({ source: 0, target: 1, forwardStrength: 0.3, backwardStrength: 0.3 });
		associations.push({ source: 0, target: 2, forwardStrength: 0.25, backwardStrength: 0.25 });
		associations.push({ source: 1, target: 2, forwardStrength: 0.2, backwardStrength: 0.2 });

		// Other components (similar but not co-edited)
		const otherComponents = ["Input", "Select", "Modal", "Card", "Header"];
		for (let i = 0; i < otherComponents.length; i++) {
			memories.push({ name: `components/${otherComponents[i]}.tsx`, expectedRelevance: 0.2 });
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.6 + Math.random() * 0.2, 30100 + i));
			accessHistories.push([NOW - (2 + Math.random() * 14) * MS_DAY]);
		}

		// Unrelated files
		for (let i = 0; i < 25; i++) {
			memories.push({ name: `other/file-${i}.ts`, expectedRelevance: 0 });
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.1 + Math.random() * 0.3, 30200 + i));
			accessHistories.push([NOW - (1 + Math.random() * 30) * MS_DAY]);
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations,
			metadata: memories,
		};
	},
	evaluate: (ranking, data) => {
		// Success: Button component #1, test and styles in top 5
		const buttonFirst = ranking[0] === 0 ? 1 : 0;
		const coEditedIndices = new Set([1, 2]);
		const coEditedInTop5 = computeRecallAtK(ranking, coEditedIndices, 5);

		return {
			score: buttonFirst * 0.5 + coEditedInTop5 * 0.5,
			maxScore: 1,
			details: `Button@1=${buttonFirst}, CoEdited-R@5=${coEditedInTop5.toFixed(2)}, Top5=[${ranking.slice(0, 5).join(",")}]`,
		};
	},
};

// ============================================================================
// SCENARIO 5: Cold Start - No History
// What happens with minimal access history?
// ============================================================================
const coldStart: RealisticScenario = {
	name: "cold_start",
	description: "New project, minimal access history - should fall back to pure similarity",
	difficulty: "easy",
	setup: () => {
		const queryEmb = makeEmbedding(40000);
		const memories: ScenarioData["metadata"] = [];
		const embeddings: number[][] = [];
		const accessHistories: number[][] = [];

		// Create 50 files with varying similarity, all accessed exactly once 1 day ago
		const similarities = [0.95, 0.88, 0.82, 0.75, 0.70, 0.65, 0.60, 0.55, 0.50, 0.45];
		for (let i = 0; i < similarities.length; i++) {
			memories.push({ name: `file-sim-${similarities[i]}.ts`, expectedRelevance: similarities[i] });
			embeddings.push(makeSimilarEmbedding(queryEmb, similarities[i], 40000 + i));
			accessHistories.push([NOW - 1 * MS_DAY]); // All accessed once, same time
		}

		// More noise
		for (let i = 0; i < 40; i++) {
			const sim = 0.1 + Math.random() * 0.35;
			memories.push({ name: `noise-${i}.ts`, expectedRelevance: 0 });
			embeddings.push(makeSimilarEmbedding(queryEmb, sim, 40100 + i));
			accessHistories.push([NOW - 1 * MS_DAY]);
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations: [],
			metadata: memories,
		};
	},
	evaluate: (ranking, data) => {
		// With equal history, should rank by similarity
		// Top 5 should be indices 0-4 (highest similarity)
		const expectedTop5 = new Set([0, 1, 2, 3, 4]);
		const precision = computePrecisionAtK(ranking, expectedTop5, 5);

		return {
			score: precision,
			maxScore: 1,
			details: `P@5=${precision.toFixed(2)}, Top5=[${ranking.slice(0, 5).join(",")}]`,
		};
	},
};

// ============================================================================
// SCENARIO 6: Adversarial - Recency Trap
// Very recent but completely irrelevant files
// ============================================================================
const adversarialRecencyTrap: RealisticScenario = {
	name: "adversarial_recency_trap",
	description: "Recent irrelevant files should NOT beat older relevant files",
	difficulty: "adversarial",
	setup: () => {
		const queryEmb = makeEmbedding(50000);
		const memories: ScenarioData["metadata"] = [];
		const embeddings: number[][] = [];
		const accessHistories: number[][] = [];

		// Relevant file from 2 days ago
		memories.push({ name: "relevant-old.ts", expectedRelevance: 1 });
		embeddings.push(makeSimilarEmbedding(queryEmb, 0.90, 50001));
		accessHistories.push([NOW - 2 * MS_DAY]);

		// Completely irrelevant files accessed just now
		for (let i = 0; i < 5; i++) {
			memories.push({ name: `irrelevant-recent-${i}.ts`, expectedRelevance: 0 });
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.15 + Math.random() * 0.1, 50100 + i));
			accessHistories.push([NOW - (i + 1) * MS_MINUTE]); // 1-5 minutes ago
		}

		// More noise
		for (let i = 0; i < 30; i++) {
			memories.push({ name: `noise-${i}.ts`, expectedRelevance: 0 });
			embeddings.push(makeSimilarEmbedding(queryEmb, 0.2 + Math.random() * 0.3, 50200 + i));
			accessHistories.push([NOW - (1 + Math.random() * 30) * MS_DAY]);
		}

		return {
			query: queryEmb,
			embeddings,
			accessHistories,
			emotionalWeights: memories.map(() => 0.5),
			associations: [],
			metadata: memories,
		};
	},
	evaluate: (ranking, data) => {
		// The relevant file MUST be #1, regardless of recency
		const relevantFirst = ranking[0] === 0 ? 1 : 0;
		// None of the recent-irrelevant should be in top 3
		const recentIrrelevantIndices = new Set([1, 2, 3, 4, 5]);
		const trapAvoided = ranking.slice(0, 3).every((idx) => !recentIrrelevantIndices.has(idx)) ? 1 : 0;

		return {
			score: relevantFirst * 0.7 + trapAvoided * 0.3,
			maxScore: 1,
			details: `Relevant@1=${relevantFirst}, TrapAvoided=${trapAvoided}, Top5=[${ranking.slice(0, 5).join(",")}]`,
		};
	},
};

// ============================================================================
// Run all scenarios
// ============================================================================

const scenarios: RealisticScenario[] = [
	morningContextRestoration,
	scaleNeedleInHaystack,
	recencyVsSimilarity,
	coEditedFiles,
	coldStart,
	adversarialRecencyTrap,
];

function runScenario(scenario: RealisticScenario): { name: string; score: number; maxScore: number; details: string; difficulty: string } {
	const data = scenario.setup();

	// Run cognitive retrieval
	const results = retrieve(
		data.query,
		data.embeddings,
		data.accessHistories,
		data.emotionalWeights,
		data.embeddings.map(() => 0.5), // decay rates
		data.embeddings.map(() => 1.0), // wm boosts
		NOW,
		data.associations.length > 0 ? data.associations : null,
		{ minProbability: 0, maxResults: data.embeddings.length },
	);

	const ranking = results.map((r) => r.index);
	const evalResult = scenario.evaluate(ranking, data);

	return {
		name: scenario.name,
		score: evalResult.score,
		maxScore: evalResult.maxScore,
		details: evalResult.details,
		difficulty: scenario.difficulty,
	};
}

// Also run pure RAG (cosine similarity only) for comparison
function runScenarioRAG(scenario: RealisticScenario): { score: number; details: string } {
	const data = scenario.setup();

	const similarities = cosineSimilarityBatch(data.query, data.embeddings);
	const indexed = similarities.map((sim, idx) => ({ sim, idx }));
	indexed.sort((a, b) => b.sim - a.sim);
	const ranking = indexed.map((x) => x.idx);

	const evalResult = scenario.evaluate(ranking, data);
	return { score: evalResult.score, details: evalResult.details };
}

// Main
console.log("╔════════════════════════════════════════════════════════════════════╗");
console.log("║          Realistic Developer Workflow Benchmarks                   ║");
console.log("║                                                                    ║");
console.log("║  Testing actual dev scenarios, not idealized cases.               ║");
console.log("║  Goal: Expose weaknesses and guide improvements.                  ║");
console.log("╚════════════════════════════════════════════════════════════════════╝\n");

const results: { name: string; cognitive: number; rag: number; delta: number; difficulty: string; details: string }[] = [];

for (const scenario of scenarios) {
	const cognitiveResult = runScenario(scenario);
	const ragResult = runScenarioRAG(scenario);

	results.push({
		name: scenario.name,
		cognitive: cognitiveResult.score,
		rag: ragResult.score,
		delta: cognitiveResult.score - ragResult.score,
		difficulty: cognitiveResult.difficulty,
		details: cognitiveResult.details,
	});

	if (VERBOSE) {
		console.log(`\n┌─ ${scenario.name} (${scenario.difficulty}) ─${"─".repeat(50 - scenario.name.length)}┐`);
		console.log(`│ ${scenario.description}`);
		console.log(`│`);
		console.log(`│ Cognitive: ${(cognitiveResult.score * 100).toFixed(1)}% - ${cognitiveResult.details}`);
		console.log(`│ RAG:       ${(ragResult.score * 100).toFixed(1)}% - ${ragResult.details}`);
		console.log(`│ Delta:     ${((cognitiveResult.score - ragResult.score) * 100).toFixed(1)}%`);
		console.log(`└${"─".repeat(70)}┘`);
	}
}

console.log("\n Results");
console.log("═".repeat(90));
console.log("Scenario                          │ Difficulty  │ Cognitive │   RAG   │  Delta  │ Status");
console.log("─".repeat(90));

let cognitiveWins = 0;
let ragWins = 0;
let ties = 0;

for (const r of results) {
	const name = r.name.slice(0, 32).padEnd(32);
	const difficulty = r.difficulty.padEnd(11);
	const cognitive = `${(r.cognitive * 100).toFixed(1)}%`.padStart(9);
	const rag = `${(r.rag * 100).toFixed(1)}%`.padStart(7);
	const delta = `${r.delta >= 0 ? "+" : ""}${(r.delta * 100).toFixed(1)}%`.padStart(7);

	let status: string;
	if (Math.abs(r.delta) < 0.01) {
		status = "TIE";
		ties++;
	} else if (r.delta > 0) {
		status = "COGNITIVE+";
		cognitiveWins++;
	} else {
		status = "RAG+";
		ragWins++;
	}

	console.log(`${name} │ ${difficulty} │${cognitive} │${rag} │${delta} │ ${status}`);
}

console.log("─".repeat(90));

const avgCognitive = results.reduce((sum, r) => sum + r.cognitive, 0) / results.length;
const avgRag = results.reduce((sum, r) => sum + r.rag, 0) / results.length;

console.log(`\n Summary`);
console.log("─".repeat(40));
console.log(`Cognitive wins: ${cognitiveWins}/${results.length}`);
console.log(`RAG wins:       ${ragWins}/${results.length}`);
console.log(`Ties:           ${ties}/${results.length}`);
console.log("");
console.log(`Average score:  Cognitive ${(avgCognitive * 100).toFixed(1)}% vs RAG ${(avgRag * 100).toFixed(1)}%`);
console.log(`Overall delta:  ${avgCognitive >= avgRag ? "+" : ""}${((avgCognitive - avgRag) * 100).toFixed(1)}%`);

// Warnings for areas needing improvement
console.log(`\n Areas Needing Improvement`);
console.log("─".repeat(40));
const failedScenarios = results.filter((r) => r.cognitive < 0.7);
if (failedScenarios.length > 0) {
	for (const f of failedScenarios) {
		console.log(`⚠ ${f.name}: ${(f.cognitive * 100).toFixed(1)}% (${f.details})`);
	}
} else {
	console.log("✓ All scenarios above 70% threshold");
}

const ragBetterScenarios = results.filter((r) => r.delta < -0.05);
if (ragBetterScenarios.length > 0) {
	console.log("");
	for (const f of ragBetterScenarios) {
		console.log(`⚠ RAG beats cognitive on ${f.name} by ${(-f.delta * 100).toFixed(1)}%`);
	}
}
