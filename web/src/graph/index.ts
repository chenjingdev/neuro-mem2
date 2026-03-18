/**
 * Graph module — graphology-based graph data model for sigma.js visualization.
 */
export {
  GraphAdapter,
  createGraphAdapter,
  type GraphNodeAttributes,
  type GraphEdgeAttributes,
  type GraphStats,
  type Graph,
} from './graph-adapter';

export {
  // Constants & types
  MAX_DEPTH,
  DEPTH_PROFILES,
  type DepthLevel,
  type DepthVisualProfile,
  type DepthNodeVisuals,
  type DepthEdgeVisuals,
  type DepthAnnotatedNode,
  type DepthAnnotatedEdge,
  type SigmaNodeAttributes,
  type SigmaEdgeAttributes,
  type DepthGraphData,
  type DepthStats,
  type DepthLegendEntry,
  // Core functions
  getDepthProfile,
  applyDepthColor,
  computeDepthNodeVisuals,
  computeDepthEdgeVisuals,
  convertToDepthGraph,
  // BFS depth assignment helpers
  assignBfsDepths,
  buildAdjacency,
  // Legend
  getDepthLegend,
} from './depth-visual-mapper';
