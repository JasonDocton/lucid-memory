/**
 * Quality Benchmark: Naive vs Cognitive Retrieval
 *
 * Compares retrieval quality (not just speed) between:
 * - Naive: cosine similarity → top-k
 * - Cognitive: cosine sim → MINERVA 2 → base-level → spreading → combined
 *
 * Measures: NDCG@k, MRR, Precision@k
 */

import {
	retrieve,
	cosineSimilarityBatch,
	type JsAssociation,
	type JsRetrievalCandidate,
} from "../../packages/lucid-native/index.js";

const VERBOSE = process.argv.includes("--verbose");

// Synthetic embeddings - we use simple vectors where similarity is controllable
function makeEmbedding(pattern: number[], dim = 128): number[] {
	const emb = new Array(dim).fill(0);
	for (let i = 0; i < pattern.length && i < dim; i++) {
		emb[i] = pattern[i];
	}
	// Normalize
	const norm = Math.sqrt(emb.reduce((sum, x) => sum + x * x, 0));
	return norm > 0 ? emb.map((x) => x / norm) : emb;
}

interface TestCase {
	name: string;
	description: string;
	probe: number[];
	memories: {
		embedding: number[];
		accessHistory: number[]; // timestamps in ms
		emotionalWeight: number;
		expectedRank: number; // 1 = should be first
	}[];
	associations?: JsAssociation[];
	currentTime: number;
}

// Test cases designed to show where cognitive retrieval should outperform naive
const testCases: TestCase[] = [
	{
		name: "recency_tiebreaker",
		description:
			"Two identical memories, one accessed recently. Cognitive should break the tie.",
		probe: makeEmbedding([1, 0, 0]),
		currentTime: 1_000_000_000,
		memories: [
			{
				embedding: makeEmbedding([1, 0, 0]), // identical to probe
				accessHistory: [1_000_000_000 - 3600_000], // 1 hour ago
				emotionalWeight: 0.5,
				expectedRank: 1,
			},
			{
				embedding: makeEmbedding([1, 0, 0]), // identical to probe
				accessHistory: [1_000_000_000 - 86400_000 * 30], // 30 days ago
				emotionalWeight: 0.5,
				expectedRank: 2,
			},
		],
	},
	{
		name: "frequency_over_similarity",
		description:
			"Frequently accessed memory should beat slightly-more-similar infrequent one.",
		probe: makeEmbedding([1, 0, 0]),
		currentTime: 1_000_000_000,
		memories: [
			{
				embedding: makeEmbedding([0.9, 0.1, 0]), // slightly less similar
				accessHistory: Array(20)
					.fill(0)
					.map((_, i) => 1_000_000_000 - i * 86400_000), // 20 accesses over 20 days
				emotionalWeight: 0.5,
				expectedRank: 1, // but frequently accessed
			},
			{
				embedding: makeEmbedding([0.95, 0.05, 0]), // more similar
				accessHistory: [1_000_000_000 - 86400_000], // only 1 access
				emotionalWeight: 0.5,
				expectedRank: 2,
			},
		],
	},
	{
		name: "emotional_boost",
		description:
			"Emotionally significant memory should rank higher (equal similarity, equal recency).",
		probe: makeEmbedding([1, 0, 0]),
		currentTime: 1_000_000_000,
		memories: [
			{
				embedding: makeEmbedding([0.9, 0.1, 0]), // same similarity
				accessHistory: [1_000_000_000 - 86400_000],
				emotionalWeight: 1.0, // max emotion
				expectedRank: 1,
			},
			{
				embedding: makeEmbedding([0.9, 0.1, 0]), // same similarity
				accessHistory: [1_000_000_000 - 86400_000],
				emotionalWeight: 0.0, // no emotion
				expectedRank: 2,
			},
		],
	},
	{
		name: "spreading_surfaces_related",
		description:
			"Associated memory should rank higher than unassociated one (both have some similarity).",
		probe: makeEmbedding([1, 0, 0]),
		currentTime: 1_000_000_000,
		memories: [
			{
				embedding: makeEmbedding([1, 0, 0]), // direct match (seed)
				accessHistory: [1_000_000_000 - 3600_000],
				emotionalWeight: 0.5,
				expectedRank: 1,
			},
			{
				embedding: makeEmbedding([0.3, 0.7, 0]), // weak match BUT associated
				accessHistory: [1_000_000_000 - 3600_000],
				emotionalWeight: 0.5,
				expectedRank: 2,
			},
			{
				embedding: makeEmbedding([0.35, 0.65, 0]), // slightly better match but NOT associated
				accessHistory: [1_000_000_000 - 3600_000],
				emotionalWeight: 0.5,
				expectedRank: 3,
			},
		],
		associations: [
			{
				source: 0,
				target: 1,
				forwardStrength: 0.9,
				backwardStrength: 0.7,
			},
		],
	},
	{
		name: "combined_signals",
		description:
			"Memory with multiple weak signals (recent + frequent + emotional) should beat single strong signal.",
		probe: makeEmbedding([1, 0, 0]),
		currentTime: 1_000_000_000,
		memories: [
			{
				embedding: makeEmbedding([0.85, 0.15, 0]), // less similar
				accessHistory: [
					1_000_000_000 - 1000, // very recent
					1_000_000_000 - 3600_000,
					1_000_000_000 - 7200_000,
					1_000_000_000 - 86400_000,
					1_000_000_000 - 86400_000 * 2,
				], // 5 accesses
				emotionalWeight: 0.9, // high emotion
				expectedRank: 1,
			},
			{
				embedding: makeEmbedding([0.95, 0.05, 0]), // more similar
				accessHistory: [1_000_000_000 - 86400_000 * 7], // 1 access, week ago
				emotionalWeight: 0.3, // low emotion
				expectedRank: 2,
			},
		],
	},
	{
		name: "working_memory_recent",
		description:
			"Recently accessed items in working memory buffer should surface even with weaker match.",
		probe: makeEmbedding([1, 0, 0]),
		currentTime: 1_000_000_000,
		memories: [
			{
				embedding: makeEmbedding([0.8, 0.2, 0]), // weaker match
				accessHistory: [
					1_000_000_000 - 100, // 100ms ago - in working memory!
				],
				emotionalWeight: 0.5,
				expectedRank: 1,
			},
			{
				embedding: makeEmbedding([0.9, 0.1, 0]), // stronger match
				accessHistory: [1_000_000_000 - 86400_000 * 30], // 30 days ago
				emotionalWeight: 0.5,
				expectedRank: 2,
			},
		],
	},
];

// Metrics

function computeNDCG(
	actualRanking: number[],
	expectedRanking: number[],
	k: number,
): number {
	// DCG = Σ (2^rel_i - 1) / log2(i + 2)
	// where rel_i is the relevance score at position i

	// Build relevance scores: expectedRank 1 = highest relevance
	const maxRank = Math.max(...expectedRanking);
	const relevance = actualRanking.map((idx) => {
		const expected = expectedRanking[idx];
		return maxRank - expected + 1; // higher = more relevant
	});

	const dcg = relevance.slice(0, k).reduce((sum, rel, i) => {
		return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
	}, 0);

	// Ideal DCG: sort by relevance descending
	const idealRelevance = [...relevance].sort((a, b) => b - a);
	const idcg = idealRelevance.slice(0, k).reduce((sum, rel, i) => {
		return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
	}, 0);

	return idcg > 0 ? dcg / idcg : 0;
}

function computeMRR(actualRanking: number[], expectedRanking: number[]): number {
	// Find the rank of the first relevant item (expected rank 1)
	const bestExpectedIdx = expectedRanking.indexOf(1);
	const positionInActual = actualRanking.indexOf(bestExpectedIdx);
	return positionInActual >= 0 ? 1 / (positionInActual + 1) : 0;
}

function computePrecisionAtK(
	actualRanking: number[],
	expectedRanking: number[],
	k: number,
): number {
	// How many of the top-k actual results are in the top-k expected?
	const topKExpected = expectedRanking
		.map((rank, idx) => ({ rank, idx }))
		.filter((x) => x.rank <= k)
		.map((x) => x.idx);

	const topKActual = actualRanking.slice(0, k);
	const hits = topKActual.filter((idx) => topKExpected.includes(idx)).length;
	return hits / k;
}

// Retrieval functions

function naiveRetrieve(
	probe: number[],
	embeddings: number[][],
	k: number,
): number[] {
	const similarities = cosineSimilarityBatch(probe, embeddings);
	const indexed = similarities.map((sim, idx) => ({ sim, idx }));
	indexed.sort((a, b) => b.sim - a.sim);
	return indexed.slice(0, k).map((x) => x.idx);
}

function cognitiveRetrieve(
	probe: number[],
	memories: TestCase["memories"],
	associations: JsAssociation[] | undefined,
	currentTime: number,
	k: number,
): number[] {
	const embeddings = memories.map((m) => m.embedding);
	const accessHistories = memories.map((m) => m.accessHistory);
	const emotionalWeights = memories.map((m) => m.emotionalWeight);
	const decayRates = memories.map(() => 0.5);
	const wmBoosts = memories.map(() => 1.0);

	const results = retrieve(
		probe,
		embeddings,
		accessHistories,
		emotionalWeights,
		decayRates,
		wmBoosts,
		currentTime,
		associations ?? null,
		{ minProbability: 0, maxResults: k },
	);

	return results.map((r) => r.index);
}

// Run benchmarks

interface BenchmarkResult {
	testCase: string;
	naive: { ndcg: number; mrr: number; precision: number };
	cognitive: { ndcg: number; mrr: number; precision: number };
	winner: "naive" | "cognitive" | "tie";
}

function runBenchmark(testCase: TestCase): BenchmarkResult {
	const k = Math.min(testCase.memories.length, 5);
	const expectedRanking = testCase.memories.map((m) => m.expectedRank);
	const embeddings = testCase.memories.map((m) => m.embedding);

	// Naive retrieval
	const naiveRanking = naiveRetrieve(testCase.probe, embeddings, k);

	// Cognitive retrieval
	const cognitiveRanking = cognitiveRetrieve(
		testCase.probe,
		testCase.memories,
		testCase.associations,
		testCase.currentTime,
		k,
	);

	const naiveMetrics = {
		ndcg: computeNDCG(naiveRanking, expectedRanking, k),
		mrr: computeMRR(naiveRanking, expectedRanking),
		precision: computePrecisionAtK(naiveRanking, expectedRanking, k),
	};

	const cognitiveMetrics = {
		ndcg: computeNDCG(cognitiveRanking, expectedRanking, k),
		mrr: computeMRR(cognitiveRanking, expectedRanking),
		precision: computePrecisionAtK(cognitiveRanking, expectedRanking, k),
	};

	// Winner based on NDCG (primary metric)
	let winner: "naive" | "cognitive" | "tie";
	if (Math.abs(cognitiveMetrics.ndcg - naiveMetrics.ndcg) < 0.01) {
		winner = "tie";
	} else if (cognitiveMetrics.ndcg > naiveMetrics.ndcg) {
		winner = "cognitive";
	} else {
		winner = "naive";
	}

	if (VERBOSE) {
		console.log(`\n  ${testCase.name}:`);
		console.log(`    ${testCase.description}`);
		console.log(`    Naive ranking:     [${naiveRanking.join(", ")}]`);
		console.log(`    Cognitive ranking: [${cognitiveRanking.join(", ")}]`);
		console.log(`    Expected ranking:  [${expectedRanking.map((_, i) => expectedRanking.indexOf(i + 1) === -1 ? "?" : expectedRanking.indexOf(i + 1)).join(", ")}]`);
	}

	return {
		testCase: testCase.name,
		naive: naiveMetrics,
		cognitive: cognitiveMetrics,
		winner,
	};
}

// Main

console.log("Quality Benchmark: Naive vs Cognitive Retrieval");
console.log("================================================\n");

const results = testCases.map(runBenchmark);

console.log("\nResults:");
console.log("--------");
console.log(
	"Test Case                  | Naive NDCG | Cognitive NDCG | Winner",
);
console.log(
	"---------------------------|------------|----------------|----------",
);

for (const r of results) {
	const name = r.testCase.padEnd(26);
	const naiveNdcg = r.naive.ndcg.toFixed(3).padStart(10);
	const cogNdcg = r.cognitive.ndcg.toFixed(3).padStart(14);
	const winner = r.winner.padStart(10);
	console.log(`${name} |${naiveNdcg} |${cogNdcg} |${winner}`);
}

// Summary
const cognitiveWins = results.filter((r) => r.winner === "cognitive").length;
const naiveWins = results.filter((r) => r.winner === "naive").length;
const ties = results.filter((r) => r.winner === "tie").length;

console.log("\nSummary:");
console.log(`  Cognitive wins: ${cognitiveWins}/${results.length}`);
console.log(`  Naive wins:     ${naiveWins}/${results.length}`);
console.log(`  Ties:           ${ties}/${results.length}`);

// Average metrics
const avgNaive = {
	ndcg: results.reduce((sum, r) => sum + r.naive.ndcg, 0) / results.length,
	mrr: results.reduce((sum, r) => sum + r.naive.mrr, 0) / results.length,
};
const avgCognitive = {
	ndcg: results.reduce((sum, r) => sum + r.cognitive.ndcg, 0) / results.length,
	mrr: results.reduce((sum, r) => sum + r.cognitive.mrr, 0) / results.length,
};

console.log("\nAverage Metrics:");
console.log(`  Naive:     NDCG=${avgNaive.ndcg.toFixed(3)}, MRR=${avgNaive.mrr.toFixed(3)}`);
console.log(`  Cognitive: NDCG=${avgCognitive.ndcg.toFixed(3)}, MRR=${avgCognitive.mrr.toFixed(3)}`);

const improvement = ((avgCognitive.ndcg - avgNaive.ndcg) / avgNaive.ndcg) * 100;
console.log(`\nCognitive improvement over naive: ${improvement > 0 ? "+" : ""}${improvement.toFixed(1)}% NDCG`);

// Exit with error if cognitive doesn't win overall
if (cognitiveWins <= naiveWins) {
	console.log("\n⚠️  Warning: Cognitive retrieval is not outperforming naive!");
	process.exit(1);
}

console.log("\n✓ Cognitive retrieval provides measurable value over naive similarity.");
