/**
 * Memory Consolidation Engine (0.6.0)
 *
 * Implements offline memory maintenance:
 * - Micro-consolidation: strengthen recently accessed, decay stale
 * - Full consolidation: advance state machine, prune weak associations
 *
 * Based on two-window consolidation (Stickgold & Walker 2013):
 * - Micro window (5 min): immediate synaptic strengthening
 * - Full window (1 hour): systems-level state transitions
 */

import { AssociationDecayConfig, ConsolidationConfig } from "./config.ts"
import type { ConsolidationState, LucidStorage } from "./storage.ts"

// Try to load native Rust bindings
let nativeModule: typeof import("@lucid-memory/native") | null = null
try {
	nativeModule = await import("@lucid-memory/native")
} catch {
	// TypeScript fallback
}

export interface MicroConsolidationStats {
	strengthened: number
	decayed: number
	associationsDecayed: number
	associationsPruned: number
}

export interface FullConsolidationStats {
	freshToConsolidating: number
	consolidatingToConsolidated: number
	reconsolidatingToConsolidated: number
	associationsPruned: number
	memoriesPruned: number
	contextsConsolidated: number
	visualsPruned: number
}

export class ConsolidationEngine {
	constructor(private storage: LucidStorage) {}

	runMicroConsolidation(): MicroConsolidationStats {
		const stats: MicroConsolidationStats = {
			strengthened: 0,
			decayed: 0,
			associationsDecayed: 0,
			associationsPruned: 0,
		}

		// 1. Strengthen recently accessed memories
		const recent = this.storage.getRecentlyAccessedMemories(
			ConsolidationConfig.recentAccessWindowMs,
			ConsolidationConfig.batchSize
		)
		for (const memory of recent) {
			const newStrength = Math.min(
				memory.encodingStrength * ConsolidationConfig.microStrengthenFactor,
				1.0
			)
			if (newStrength !== memory.encodingStrength) {
				this.storage.updateEncodingStrength(memory.id, newStrength)
				stats.strengthened++
			}
		}

		// 2. Verbatim decay for stale memories
		const stale = this.storage.getStaleMemories(
			ConsolidationConfig.staleThresholdDays,
			ConsolidationConfig.batchSize
		)
		for (const memory of stale) {
			const newStrength = Math.max(
				memory.encodingStrength * ConsolidationConfig.verbatimDecayFactor,
				ConsolidationConfig.encodingStrengthFloor
			)
			if (newStrength !== memory.encodingStrength) {
				this.storage.updateEncodingStrength(memory.id, newStrength)
				stats.decayed++
			}
		}

		// 3. Association decay
		if (AssociationDecayConfig.enabled) {
			const associations = this.storage.getAllAssociationsForDecay()
			const now = Date.now()
			for (const assoc of associations) {
				if (!assoc.lastReinforced) continue
				const daysSince = (now - assoc.lastReinforced) / (24 * 60 * 60 * 1000)

				const decayed = nativeModule
					? nativeModule.computeAssociationDecay(
							assoc.strength,
							daysSince,
							"fresh",
							null
						)
					: assoc.strength *
						Math.exp(-daysSince / AssociationDecayConfig.tauFreshDays)

				const shouldPrune = nativeModule
					? nativeModule.shouldPruneAssociation(decayed)
					: decayed < AssociationDecayConfig.pruneThreshold
				if (shouldPrune) {
					this.storage.dissociate(assoc.sourceId, assoc.targetId)
					stats.associationsPruned++
				} else if (Math.abs(decayed - assoc.strength) > 0.001) {
					this.storage.updateAssociationStrength(
						assoc.sourceId,
						assoc.targetId,
						decayed
					)
					stats.associationsDecayed++
				}
			}
		}

		return stats
	}

	runFullConsolidation(maxMemoryCount = 50000): FullConsolidationStats {
		const stats: FullConsolidationStats = {
			freshToConsolidating: 0,
			consolidatingToConsolidated: 0,
			reconsolidatingToConsolidated: 0,
			associationsPruned: 0,
			memoriesPruned: 0,
			contextsConsolidated: 0,
			visualsPruned: 0,
		}

		const now = Date.now()
		const oneHourMs = 60 * 60 * 1000
		const oneDayMs = 24 * oneHourMs

		// 1. fresh → consolidating (memories older than 1 hour)
		const freshMemories = this.storage.getMemoriesByConsolidationState(
			"fresh",
			ConsolidationConfig.batchSize
		)
		for (const memory of freshMemories) {
			if (now - memory.createdAt > oneHourMs) {
				this.storage.updateConsolidationState(memory.id, "consolidating")
				stats.freshToConsolidating++
			}
		}

		// 2. consolidating → consolidated (memories older than 24 hours)
		const consolidating = this.storage.getMemoriesByConsolidationState(
			"consolidating",
			ConsolidationConfig.batchSize
		)
		for (const memory of consolidating) {
			if (now - memory.createdAt > oneDayMs) {
				this.storage.updateConsolidationState(memory.id, "consolidated")
				stats.consolidatingToConsolidated++
			}
		}

		// 3. reconsolidating → consolidated (after 24 hours in reconsolidating)
		const reconsolidating = this.storage.getMemoriesByConsolidationState(
			"reconsolidating",
			ConsolidationConfig.batchSize
		)
		for (const memory of reconsolidating) {
			const lastConsolidated = memory.lastConsolidated ?? memory.createdAt
			if (now - lastConsolidated > oneDayMs) {
				this.storage.updateConsolidationState(memory.id, "consolidated")
				stats.reconsolidatingToConsolidated++
			}
		}

		// 4. Prune weak associations
		if (AssociationDecayConfig.enabled) {
			stats.associationsPruned = this.storage.pruneWeakAssociations(
				AssociationDecayConfig.pruneThreshold
			)
		}

		// 5. Prune old memories if database exceeds capacity
		stats.memoriesPruned = this.storage.pruneOldMemories(maxMemoryCount)

		// 6. Prune stale visual memories
		if (nativeModule) {
			const { visuals } = this.storage.getAllVisualsForRetrieval()
			const now = Date.now()
			const oneDayMs = 24 * 60 * 60 * 1000
			for (const v of visuals) {
				const hasEmbed = this.storage.getVisualEmbedding(v.id) !== null
				if (!hasEmbed) continue // still being processed, don't prune yet
				const daysSinceAccess =
					(now - (v.lastAccessed ?? v.createdAt)) / oneDayMs
				if (
					nativeModule.visualShouldPrune(
						v.significance,
						daysSinceAccess,
						false,
						false
					)
				) {
					this.storage.deleteVisualMemory(v.id)
					stats.visualsPruned++
				}
			}
		}

		// 7. Consolidate old location access contexts into summaries
		const locations = this.storage.getAllLocations(
			undefined,
			ConsolidationConfig.batchSize
		)
		for (const loc of locations) {
			try {
				this.storage.consolidateOldContexts(
					loc.id,
					ConsolidationConfig.staleThresholdDays
				)
				stats.contextsConsolidated++
			} catch {
				// Individual location failures shouldn't halt consolidation
			}
		}

		return stats
	}
}
