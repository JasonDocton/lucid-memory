//! Spreading Activation
//!
//! Memories don't exist in isolation. Activating one memory
//! spreads activation to connected memories through the
//! association graph.
//!
//! `A_j = Σ(W_i / n_i) × S_ij`
//!
//! Where:
//! - `A_j` = activation received by node j
//! - `W_i` = source strength of node i
//! - `n_i` = fan (number of outgoing connections from i)
//! - `S_ij` = associative strength between i and j

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

/// Adjacency list type for graph edges: Vec of (`target_index`, weight) pairs per node.
type AdjacencyList = Vec<Vec<(usize, f64)>>;

/// An edge in the association graph.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Association {
	/// Source node index
	pub source: usize,
	/// Target node index
	pub target: usize,
	/// Forward strength (source → target)
	pub forward_strength: f64,
	/// Backward strength (target → source)
	pub backward_strength: f64,
}

/// Result of spreading activation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpreadingResult {
	/// Final activation values (index → activation)
	pub activations: Vec<f64>,
	/// Which nodes were visited at each depth
	pub visited_by_depth: Vec<Vec<usize>>,
}

/// Configuration for spreading activation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpreadingConfig {
	/// How much activation decays per hop (0-1)
	pub decay_per_hop: f64,
	/// Minimum activation to propagate
	pub minimum_activation: f64,
	/// Maximum nodes to visit
	pub max_nodes: usize,
	/// Whether to spread bidirectionally
	pub bidirectional: bool,
}

impl Default for SpreadingConfig {
	fn default() -> Self {
		Self {
			decay_per_hop: 0.7,
			minimum_activation: 0.01,
			max_nodes: 1000,
			bidirectional: true,
		}
	}
}

/// Build adjacency lists from associations.
fn build_adjacency(
	associations: &[Association],
	num_nodes: usize,
) -> (AdjacencyList, AdjacencyList) {
	let mut forward: Vec<Vec<(usize, f64)>> = vec![Vec::new(); num_nodes];
	let mut backward: Vec<Vec<(usize, f64)>> = vec![Vec::new(); num_nodes];

	for assoc in associations {
		if assoc.source < num_nodes && assoc.target < num_nodes {
			forward[assoc.source].push((assoc.target, assoc.forward_strength));
			backward[assoc.target].push((assoc.source, assoc.backward_strength));
		}
	}

	(forward, backward)
}

/// Perform spreading activation through the association graph.
///
/// Starting from seed nodes, activation spreads outward,
/// decaying with distance and splitting across connections.
///
/// # Arguments
///
/// * `num_nodes` - Total number of nodes in the graph
/// * `associations` - Edges with forward/backward strengths
/// * `seed_indices` - Starting nodes
/// * `seed_activations` - Initial activation values for seeds
/// * `config` - Spreading configuration
/// * `depth` - Maximum spreading depth
///
/// # Returns
///
/// Spreading result with final activations and visitation history.
#[must_use]
pub fn spread_activation(
	num_nodes: usize,
	associations: &[Association],
	seed_indices: &[usize],
	seed_activations: &[f64],
	config: &SpreadingConfig,
	depth: usize,
) -> SpreadingResult {
	let (forward_adj, backward_adj) = build_adjacency(associations, num_nodes);

	// Initialize activations
	let mut activations = vec![0.0; num_nodes];
	for (i, &idx) in seed_indices.iter().enumerate() {
		if idx < num_nodes {
			activations[idx] = seed_activations.get(i).copied().unwrap_or(1.0);
		}
	}

	let mut visited: HashSet<usize> = seed_indices.iter().copied().collect();
	let mut visited_by_depth: Vec<Vec<usize>> = vec![seed_indices.to_vec()];
	let mut frontier: Vec<usize> = seed_indices.to_vec();
	let mut total_visited = frontier.len();

	// Spread for each depth level
	for _ in 0..depth {
		if total_visited >= config.max_nodes {
			break;
		}

		let mut next_frontier: Vec<usize> = Vec::new();
		let mut next_activations: HashMap<usize, f64> = HashMap::new();

		for &source_idx in &frontier {
			let source_activation = activations[source_idx];
			if source_activation < config.minimum_activation {
				continue;
			}

			// Forward spreading
			let forward_edges = &forward_adj[source_idx];
			#[allow(clippy::cast_precision_loss)]
			let fan = forward_edges.len().max(1) as f64;

			for &(target_idx, strength) in forward_edges {
				if total_visited >= config.max_nodes {
					break;
				}

				// ACT-R spreading: A_j = Σ(W_i / n_i) × S_ij
				let spread_amount = (source_activation / fan) * strength * config.decay_per_hop;

				*next_activations.entry(target_idx).or_insert(0.0) += spread_amount;

				if visited.insert(target_idx) {
					next_frontier.push(target_idx);
					total_visited += 1;
				}
			}

			// Backward spreading (if enabled)
			if config.bidirectional {
				let backward_edges = &backward_adj[source_idx];
				#[allow(clippy::cast_precision_loss)]
				let back_fan = backward_edges.len().max(1) as f64;

				for &(target_idx, strength) in backward_edges {
					if total_visited >= config.max_nodes {
						break;
					}

					// Reduced strength for backward spreading
					let spread_amount =
						(source_activation / back_fan) * strength * config.decay_per_hop * 0.7;

					*next_activations.entry(target_idx).or_insert(0.0) += spread_amount;

					if visited.insert(target_idx) {
						next_frontier.push(target_idx);
						total_visited += 1;
					}
				}
			}
		}

		// Update activations BEFORE checking frontier
		// This ensures spread is applied even when targets are already seeds
		for (idx, activation) in next_activations {
			activations[idx] += activation;
		}

		if next_frontier.is_empty() {
			break;
		}

		visited_by_depth.push(next_frontier.clone());
		frontier = next_frontier;
	}

	SpreadingResult {
		activations,
		visited_by_depth,
	}
}

/// Get top k activated nodes.
#[must_use]
pub fn get_top_activated(activations: &[f64], top_k: usize) -> Vec<usize> {
	let mut indexed: Vec<(usize, f64)> = activations
		.iter()
		.enumerate()
		.filter(|(_, &a)| a > 0.0)
		.map(|(i, &a)| (i, a))
		.collect();

	indexed.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

	indexed.into_iter().take(top_k).map(|(i, _)| i).collect()
}

/// Find shortest path between two nodes using BFS.
#[must_use]
pub fn find_activation_path(
	num_nodes: usize,
	associations: &[Association],
	source: usize,
	target: usize,
) -> Vec<usize> {
	let (forward_adj, _) = build_adjacency(associations, num_nodes);

	if source == target {
		return vec![source];
	}

	let mut visited = vec![false; num_nodes];
	let mut parent = vec![usize::MAX; num_nodes];
	let mut queue = VecDeque::new();

	visited[source] = true;
	queue.push_back(source);

	while let Some(current) = queue.pop_front() {
		for &(neighbor, _) in &forward_adj[current] {
			if !visited[neighbor] {
				visited[neighbor] = true;
				parent[neighbor] = current;
				queue.push_back(neighbor);

				if neighbor == target {
					// Reconstruct path
					let mut path = Vec::new();
					let mut node = target;
					while node != usize::MAX {
						path.push(node);
						node = parent[node];
					}
					path.reverse();
					return path;
				}
			}
		}
	}

	// No path found
	Vec::new()
}

/// Compute `PageRank` for node importance.
#[must_use]
pub fn compute_pagerank(
	num_nodes: usize,
	associations: &[Association],
	damping: f64,
	iterations: usize,
) -> Vec<f64> {
	let (forward_adj, _) = build_adjacency(associations, num_nodes);

	#[allow(clippy::cast_precision_loss)]
	let num_nodes_f64 = num_nodes as f64;
	let mut ranks = vec![1.0 / num_nodes_f64; num_nodes];
	let mut new_ranks = vec![0.0; num_nodes];

	for _ in 0..iterations {
		// Reset new ranks
		for r in &mut new_ranks {
			*r = (1.0 - damping) / num_nodes_f64;
		}

		// Distribute rank
		for (i, edges) in forward_adj.iter().enumerate() {
			if edges.is_empty() {
				// Dangling node: distribute to all
				let contribution = damping * ranks[i] / num_nodes_f64;
				for r in &mut new_ranks {
					*r += contribution;
				}
			} else {
				#[allow(clippy::cast_precision_loss)]
				let contribution = damping * ranks[i] / edges.len() as f64;
				for &(target, _) in edges {
					new_ranks[target] += contribution;
				}
			}
		}

		std::mem::swap(&mut ranks, &mut new_ranks);
	}

	ranks
}

// ============================================================================
// Temporal Spreading (Episodic Memory - TCM)
// ============================================================================

/// Configuration for temporal spreading activation.
/// Based on Temporal Context Model (Howard & Kahana 2002).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TemporalSpreadingConfig {
	/// Forward temporal link strength multiplier (A→B, later in sequence)
	pub forward_strength: f64,
	/// Backward temporal link strength multiplier (B→A, earlier in sequence)
	/// Typically less than forward per TCM asymmetry
	pub backward_strength: f64,
	/// Decay rate for temporal link strength with position distance
	pub distance_decay_rate: f64,
	/// Activation boost for memories linked via episode
	pub episode_boost: f64,
	/// TCM context persistence parameter (beta)
	pub context_persistence: f64,
	/// Maximum temporal distance (positions) to consider
	pub max_temporal_distance: usize,
}

impl Default for TemporalSpreadingConfig {
	fn default() -> Self {
		Self {
			forward_strength: 1.0,
			backward_strength: 0.7, // Asymmetric per TCM
			distance_decay_rate: 0.3,
			episode_boost: 1.2,
			context_persistence: 0.7,
			max_temporal_distance: 10,
		}
	}
}

/// A temporal link between two memories within an episode.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TemporalLink {
	/// Source event index (within episode)
	pub source_position: usize,
	/// Target event index (within episode)
	pub target_position: usize,
	/// Memory index for source
	pub source_memory: usize,
	/// Memory index for target
	pub target_memory: usize,
	/// Forward link strength (source → target)
	pub forward_strength: f64,
	/// Backward link strength (target → source)
	pub backward_strength: f64,
}

/// Result of temporal spreading activation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TemporalSpreadingResult {
	/// Activation values for each memory (memory index → activation)
	pub activations: Vec<f64>,
	/// Which memories were activated via forward links
	pub forward_activated: Vec<usize>,
	/// Which memories were activated via backward links
	pub backward_activated: Vec<usize>,
}

/// Compute temporal link strength based on position distance.
///
/// `strength = base × e^(-distance × decay_rate)`
///
/// Adjacent events have strongest links, distant events have weaker links.
#[inline]
#[must_use]
pub fn compute_temporal_link_strength(
	base_strength: f64,
	position_distance: usize,
	config: &TemporalSpreadingConfig,
) -> f64 {
	#[allow(clippy::cast_precision_loss)]
	let distance = position_distance as f64;
	base_strength * (-distance * config.distance_decay_rate).exp()
}

/// Create temporal links for an episode.
///
/// Creates forward and backward links between consecutive events,
/// with strength decaying over distance.
#[must_use]
pub fn create_episode_links(
	event_memory_indices: &[usize],
	config: &TemporalSpreadingConfig,
) -> Vec<TemporalLink> {
	let mut links = Vec::new();
	let n = event_memory_indices.len();

	if n < 2 {
		return links;
	}

	// Create links between events within max temporal distance
	for i in 0..n {
		for j in (i + 1)..n.min(i + config.max_temporal_distance + 1) {
			let distance = j - i;

			let forward = compute_temporal_link_strength(config.forward_strength, distance, config);
			let backward =
				compute_temporal_link_strength(config.backward_strength, distance, config);

			links.push(TemporalLink {
				source_position: i,
				target_position: j,
				source_memory: event_memory_indices[i],
				target_memory: event_memory_indices[j],
				forward_strength: forward,
				backward_strength: backward,
			});
		}
	}

	links
}

/// Spread activation through temporal links.
///
/// Given a seed memory within an episode, spreads activation to
/// temporally adjacent memories. Forward links (to later events)
/// are stronger than backward links (to earlier events) per TCM.
///
/// # Arguments
///
/// * `num_memories` - Total number of memories
/// * `temporal_links` - Links from `create_episode_links`
/// * `seed_memory` - The activated memory index
/// * `seed_activation` - Initial activation value
/// * `config` - Temporal spreading configuration
///
/// # Returns
///
/// Temporal spreading result with activations and which memories were reached.
#[must_use]
pub fn spread_temporal_activation(
	num_memories: usize,
	temporal_links: &[TemporalLink],
	seed_memory: usize,
	seed_activation: f64,
	config: &TemporalSpreadingConfig,
) -> TemporalSpreadingResult {
	let mut activations = vec![0.0; num_memories];
	let mut forward_activated = Vec::new();
	let mut backward_activated = Vec::new();

	if seed_memory >= num_memories {
		return TemporalSpreadingResult {
			activations,
			forward_activated,
			backward_activated,
		};
	}

	// Set seed activation
	activations[seed_memory] = seed_activation;

	// Spread through temporal links
	for link in temporal_links {
		// Forward: source → target (seed is source, activate target)
		if link.source_memory == seed_memory && link.target_memory < num_memories {
			let spread = seed_activation * link.forward_strength * config.episode_boost;
			activations[link.target_memory] += spread;
			if !forward_activated.contains(&link.target_memory) {
				forward_activated.push(link.target_memory);
			}
		}

		// Backward: target → source (seed is target, activate source)
		if link.target_memory == seed_memory && link.source_memory < num_memories {
			let spread = seed_activation * link.backward_strength * config.episode_boost;
			activations[link.source_memory] += spread;
			if !backward_activated.contains(&link.source_memory) {
				backward_activated.push(link.source_memory);
			}
		}
	}

	// Sort by position for predictable output
	forward_activated.sort_unstable();
	backward_activated.sort_unstable();

	TemporalSpreadingResult {
		activations,
		forward_activated,
		backward_activated,
	}
}

/// Spread activation through multiple episodes.
///
/// Handles case where a memory appears in multiple episodes.
#[must_use]
pub fn spread_temporal_activation_multi(
	num_memories: usize,
	episode_links: &[Vec<TemporalLink>],
	seed_memory: usize,
	seed_activation: f64,
	config: &TemporalSpreadingConfig,
) -> TemporalSpreadingResult {
	let mut combined_activations = vec![0.0; num_memories];
	let mut all_forward = Vec::new();
	let mut all_backward = Vec::new();

	for links in episode_links {
		// Check if seed memory is in this episode
		let in_episode = links
			.iter()
			.any(|l| l.source_memory == seed_memory || l.target_memory == seed_memory);

		if in_episode {
			let result = spread_temporal_activation(
				num_memories,
				links,
				seed_memory,
				seed_activation,
				config,
			);

			// Combine activations (take max, don't sum to avoid over-boosting)
			for (i, &a) in result.activations.iter().enumerate() {
				if a > combined_activations[i] {
					combined_activations[i] = a;
				}
			}

			for m in result.forward_activated {
				if !all_forward.contains(&m) {
					all_forward.push(m);
				}
			}

			for m in result.backward_activated {
				if !all_backward.contains(&m) {
					all_backward.push(m);
				}
			}
		}
	}

	all_forward.sort_unstable();
	all_backward.sort_unstable();

	TemporalSpreadingResult {
		activations: combined_activations,
		forward_activated: all_forward,
		backward_activated: all_backward,
	}
}

/// Find temporally adjacent memories ("what was I working on before/after X?").
///
/// Returns memory indices sorted by temporal proximity.
///
/// # Arguments
///
/// * `temporal_links` - Links from `create_episode_links`
/// * `anchor_memory` - The reference memory
/// * `direction` - "before" (backward), "after" (forward), or "both"
/// * `limit` - Maximum memories to return
#[must_use]
pub fn find_temporal_neighbors(
	temporal_links: &[TemporalLink],
	anchor_memory: usize,
	direction: &str,
	limit: usize,
) -> Vec<(usize, f64)> {
	let mut neighbors: Vec<(usize, f64, usize)> = Vec::new(); // (memory, strength, distance)

	for link in temporal_links {
		match direction {
			"before" | "backward" => {
				// Looking for memories BEFORE anchor (anchor is target)
				if link.target_memory == anchor_memory {
					let distance = link.target_position - link.source_position;
					neighbors.push((link.source_memory, link.backward_strength, distance));
				}
			}
			"after" | "forward" => {
				// Looking for memories AFTER anchor (anchor is source)
				if link.source_memory == anchor_memory {
					let distance = link.target_position - link.source_position;
					neighbors.push((link.target_memory, link.forward_strength, distance));
				}
			}
			_ => {
				// Both directions
				if link.target_memory == anchor_memory {
					let distance = link.target_position - link.source_position;
					neighbors.push((link.source_memory, link.backward_strength, distance));
				}
				if link.source_memory == anchor_memory {
					let distance = link.target_position - link.source_position;
					neighbors.push((link.target_memory, link.forward_strength, distance));
				}
			}
		}
	}

	// Sort by distance (closest first), then by strength (highest first)
	neighbors.sort_by(|a, b| {
		a.2.cmp(&b.2)
			.then_with(|| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
	});

	// Return (memory, strength) pairs
	neighbors
		.into_iter()
		.take(limit)
		.map(|(m, s, _)| (m, s))
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn make_assoc(source: usize, target: usize, strength: f64) -> Association {
		Association {
			source,
			target,
			forward_strength: strength,
			backward_strength: strength * 0.5,
		}
	}

	#[test]
	fn test_spreading_simple() {
		// Simple chain: 0 → 1 → 2
		let associations = vec![make_assoc(0, 1, 1.0), make_assoc(1, 2, 1.0)];

		let config = SpreadingConfig {
			decay_per_hop: 0.7,
			minimum_activation: 0.01,
			max_nodes: 100,
			bidirectional: false,
		};

		let result = spread_activation(3, &associations, &[0], &[1.0], &config, 2);

		// Node 0 should have highest activation
		assert!(result.activations[0] > result.activations[1]);
		assert!(result.activations[1] > result.activations[2]);
	}

	#[test]
	fn test_spreading_fan_out() {
		// Fan: 0 → 1, 0 → 2, 0 → 3
		let associations = vec![
			make_assoc(0, 1, 1.0),
			make_assoc(0, 2, 1.0),
			make_assoc(0, 3, 1.0),
		];

		let config = SpreadingConfig {
			decay_per_hop: 0.7,
			minimum_activation: 0.01,
			max_nodes: 100,
			bidirectional: false,
		};

		let result = spread_activation(4, &associations, &[0], &[1.0], &config, 1);

		// Each target should receive 1/3 of spread activation
		let expected = 1.0 / 3.0 * 0.7;
		assert!((result.activations[1] - expected).abs() < 0.01);
		assert!((result.activations[2] - expected).abs() < 0.01);
		assert!((result.activations[3] - expected).abs() < 0.01);
	}

	#[test]
	fn test_find_path() {
		let associations = vec![
			make_assoc(0, 1, 1.0),
			make_assoc(1, 2, 1.0),
			make_assoc(2, 3, 1.0),
		];

		let path = find_activation_path(4, &associations, 0, 3);
		assert_eq!(path, vec![0, 1, 2, 3]);
	}

	#[test]
	fn test_pagerank() {
		// Simple graph
		let associations = vec![
			make_assoc(0, 1, 1.0),
			make_assoc(1, 2, 1.0),
			make_assoc(2, 0, 1.0),
		];

		let ranks = compute_pagerank(3, &associations, 0.85, 100);

		// In a cycle, all nodes should have similar rank
		let avg = ranks.iter().sum::<f64>() / 3.0;
		for r in &ranks {
			assert!((r - avg).abs() < 0.01);
		}
	}

	// Temporal Spreading tests

	#[test]
	fn test_temporal_link_strength_decay() {
		let config = TemporalSpreadingConfig::default();

		let adjacent = compute_temporal_link_strength(1.0, 1, &config);
		let distant = compute_temporal_link_strength(1.0, 5, &config);

		// Adjacent should be stronger than distant
		assert!(adjacent > distant);
		// Adjacent with decay_rate=0.3 should be ~0.74
		assert!((adjacent - 0.74).abs() < 0.01);
	}

	#[test]
	fn test_create_episode_links() {
		let config = TemporalSpreadingConfig::default();
		// Episode with 3 events: memories 10, 20, 30
		let links = create_episode_links(&[10, 20, 30], &config);

		// Should have links: 10→20, 10→30, 20→30
		assert_eq!(links.len(), 3);

		// Check forward > backward (TCM asymmetry)
		for link in &links {
			assert!(link.forward_strength > link.backward_strength);
		}
	}

	#[test]
	fn test_spread_temporal_activation() {
		let config = TemporalSpreadingConfig::default();
		// Episode: memories 0, 1, 2
		let links = create_episode_links(&[0, 1, 2], &config);

		// Activate middle memory (1)
		let result = spread_temporal_activation(3, &links, 1, 1.0, &config);

		// Memory 1 should have seed activation
		assert!(result.activations[1] > 0.0);

		// Forward spread to memory 2
		assert!(result.activations[2] > 0.0);
		assert!(result.forward_activated.contains(&2));

		// Backward spread to memory 0
		assert!(result.activations[0] > 0.0);
		assert!(result.backward_activated.contains(&0));

		// Forward should be stronger than backward
		assert!(result.activations[2] > result.activations[0]);
	}

	#[test]
	fn test_find_temporal_neighbors_before() {
		let config = TemporalSpreadingConfig::default();
		// Episode: memories 0, 1, 2, 3
		let links = create_episode_links(&[0, 1, 2, 3], &config);

		// Find memories BEFORE memory 2
		let before = find_temporal_neighbors(&links, 2, "before", 10);

		// Should find 0 and 1 (both come before 2)
		let memory_ids: Vec<usize> = before.iter().map(|(m, _)| *m).collect();
		assert!(memory_ids.contains(&0));
		assert!(memory_ids.contains(&1));
		// Should NOT contain 3 (comes after)
		assert!(!memory_ids.contains(&3));
	}

	#[test]
	fn test_find_temporal_neighbors_after() {
		let config = TemporalSpreadingConfig::default();
		// Episode: memories 0, 1, 2, 3
		let links = create_episode_links(&[0, 1, 2, 3], &config);

		// Find memories AFTER memory 1
		let after = find_temporal_neighbors(&links, 1, "after", 10);

		// Should find 2 and 3 (both come after 1)
		let memory_ids: Vec<usize> = after.iter().map(|(m, _)| *m).collect();
		assert!(memory_ids.contains(&2));
		assert!(memory_ids.contains(&3));
		// Should NOT contain 0 (comes before)
		assert!(!memory_ids.contains(&0));
	}
}
