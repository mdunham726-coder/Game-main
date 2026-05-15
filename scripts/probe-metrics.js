'use strict';
// Single source of truth for probe metric vocabulary.
// Required by both probe-runner.js (runtime) and create_probe_spec executeToolCall (authorship).
// Adding a new metric that needs spec config: add to METRIC_NAMES + add entry to
// METRIC_CONFIG_REQUIREMENTS in the same commit. Both consumers pick it up automatically.

const METRIC_NAMES = [
  'total_sites_placed',
  'total_cells_evaluated',
  'populated_cells_count',
  'pct_populated_cells',
  'empty_cells_count',
  'max_sites_per_cell',
  'mean_sites_per_populated_cell',
  'enterable_ratio',
  'spacing_rejections',
  'edge_concentration_pct',
  'cell_occupancy_entropy',
  'site_size_stddev',
  'community_ratio',
  'isolated_cells_count',
  // Localspace distribution metrics (Stage 2b) — require post_extract in spec
  'ls_pct',
  'eligible_tile_count',
  'localspace_count',
  'enterable_localspace_ratio',
  'site_size',
  // Localspace semantics metrics (Stage 2c) — require post_extract with active_site.local_spaces array
  'ls_fill_rate',
  'ls_unique_name_rate',
  'ls_size_spread',
  'ls_mean_size',
  // Continuity/narrator metrics — require post_extract resolving to debug.narration_debug.continuity_block_chars (a number)
  'continuity_block_chars',
];

const METRIC_CONFIG_REQUIREMENTS = {
  edge_concentration_pct: ['edge_topology.radius', 'edge_topology.anchor_path'],
};

module.exports = { METRIC_NAMES, METRIC_CONFIG_REQUIREMENTS };
