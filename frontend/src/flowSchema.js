/**
 * FlowDiff data contract.
 * Normalized payload for files, functions, flows, and edges.
 */

/** @typedef {{ path: string, hunks: { oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[] }[], changedRanges: { start: number, end: number }[], sourceLines?: string[] }} File */
/** @typedef {{ id: string, name: string, file: string, startLine: number, endLine: number, snippet: string, changed: boolean, changeType?: "added" | "modified" }} FunctionMeta */
/** @typedef {{ id: string, rootId: string, name?: string }} Flow */
/** @typedef {{ callerId: string, calleeId: string, callIndex: number }} Edge */

/**
 * @typedef {Object} FlowPayload
 * @property {File[]} files
 * @property {Record<string, FunctionMeta>} functionsById
 * @property {Flow[]} flows
 * @property {Edge[]} edges
 */

/** @type {FlowPayload} */
export const emptyFlowPayload = {
  files: [],
  functionsById: {},
  flows: [],
  edges: []
};
