/**
 * Gist Generation Module
 *
 * Extracts semantic essence from content using extractive summarization.
 * No LLM required - works through linguistic patterns.
 *
 * The goal: compress content to ~50 tokens while preserving meaning.
 */

/**
 * Generate a gist from content.
 * Uses extractive summarization: first meaningful sentence + key terms.
 */
export function generateGist(content: string, maxLength = 150): string {
	// Clean and normalize
	const cleaned = content.trim().replace(/\s+/g, " ")

	if (cleaned.length <= maxLength) {
		return cleaned
	}

	// Split into sentences
	const sentences = splitSentences(cleaned)

	if (sentences.length === 0) {
		return cleaned.slice(0, maxLength)
	}

	// Get first meaningful sentence (we know sentences.length > 0 from early return)
	const firstSentence =
		sentences.find((s) => s.length > 20) ?? sentences[0] ?? cleaned

	// If first sentence fits, use it
	if (firstSentence.length <= maxLength) {
		// Try to add key terms from rest of content
		const keyTerms = extractKeyTerms(cleaned, firstSentence)
		if (
			keyTerms.length > 0 &&
			firstSentence.length + keyTerms.join(", ").length + 3 <= maxLength
		) {
			return `${firstSentence} [${keyTerms.join(", ")}]`
		}
		return firstSentence
	}

	// First sentence too long - extract key phrase
	return extractKeyPhrase(cleaned, maxLength)
}

/**
 * Split text into sentences, handling common edge cases.
 */
function splitSentences(text: string): string[] {
	// Simple sentence splitting - handles most cases
	const sentences: string[] = []
	let current = ""

	for (let i = 0; i < text.length; i++) {
		current += text[i]

		// Check for sentence ending
		if (text[i] === "." || text[i] === "!" || text[i] === "?") {
			// Look ahead to avoid splitting on abbreviations like "Dr." or "etc."
			const nextChar = text[i + 1]
			if (!nextChar || nextChar === " " || nextChar === "\n") {
				const trimmed = current.trim()
				if (trimmed.length > 0) {
					sentences.push(trimmed)
				}
				current = ""
			}
		}
	}

	// Add any remaining text
	const trimmed = current.trim()
	if (trimmed.length > 0) {
		sentences.push(trimmed)
	}

	return sentences
}

/**
 * Extract key terms that aren't in the first sentence.
 */
function extractKeyTerms(fullText: string, firstSentence: string): string[] {
	const stopWords = new Set([
		"the",
		"a",
		"an",
		"is",
		"are",
		"was",
		"were",
		"be",
		"been",
		"being",
		"have",
		"has",
		"had",
		"do",
		"does",
		"did",
		"will",
		"would",
		"could",
		"should",
		"may",
		"might",
		"must",
		"shall",
		"can",
		"need",
		"dare",
		"to",
		"of",
		"in",
		"for",
		"on",
		"with",
		"at",
		"by",
		"from",
		"as",
		"into",
		"through",
		"during",
		"before",
		"after",
		"above",
		"below",
		"between",
		"under",
		"again",
		"further",
		"then",
		"once",
		"here",
		"there",
		"when",
		"where",
		"why",
		"how",
		"all",
		"each",
		"every",
		"both",
		"few",
		"more",
		"most",
		"other",
		"some",
		"such",
		"no",
		"nor",
		"not",
		"only",
		"own",
		"same",
		"so",
		"than",
		"too",
		"very",
		"just",
		"also",
		"now",
		"and",
		"but",
		"or",
		"if",
		"because",
		"this",
		"that",
		"these",
		"those",
		"it",
		"its",
		"i",
		"we",
		"you",
		"he",
		"she",
		"they",
		"them",
		"their",
		"our",
		"your",
		"my",
	])

	// Get words from full text that aren't in first sentence
	const firstWords = new Set(
		firstSentence.toLowerCase().match(/\b[a-z]+\b/g) ?? []
	)

	const allWords = fullText.toLowerCase().match(/\b[a-z]+\b/g) ?? []

	// Count word frequency
	const freq = new Map<string, number>()
	for (const word of allWords) {
		if (word.length > 3 && !stopWords.has(word) && !firstWords.has(word)) {
			freq.set(word, (freq.get(word) ?? 0) + 1)
		}
	}

	// Get top terms by frequency
	return Array.from(freq.entries())
		.filter(([_, count]) => count >= 2)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([word]) => word)
}

/**
 * Extract a key phrase from long text.
 */
function extractKeyPhrase(text: string, maxLength: number): string {
	// Try to find a natural break point
	const words = text.split(" ")
	let result = ""

	for (const word of words) {
		const next = result ? `${result} ${word}` : word
		if (next.length > maxLength - 3) {
			return `${result}...`
		}
		result = next
	}

	return result
}

/**
 * Estimate token count (rough approximation).
 * GPT-style tokenizers average ~4 characters per token for English.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * Check if content fits within a token budget.
 */
export function fitsInBudget(text: string, budget: number): boolean {
	return estimateTokens(text) <= budget
}
