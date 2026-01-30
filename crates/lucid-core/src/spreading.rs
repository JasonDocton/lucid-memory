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

        if next_frontier.is_empty() {
            break;
        }

        // Update activations
        for (idx, activation) in next_activations {
            activations[idx] += activation;
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
}
