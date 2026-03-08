/**
 * Central state store for FlowDiff.
 * Holds flow payload, UI state (selected flow, expanded functions, active function),
 * and notifies subscribers on updates.
 */

import { emptyFlowPayload } from '../flowSchema.js';

/** @type {import('../flowSchema.js').FlowPayload} */
let flowPayload = { ...emptyFlowPayload };

/** @type {{ selectedFlowId: string | null, expandedIds: Set<string>, expandedTreeNodeIds: Set<string>, activeFunctionId: string | null, activeTreeNodeKey: string | null, hoveredTreeNodeKey: string | null }} */
let uiState = {
  selectedFlowId: null,
  expandedIds: new Set(),
  expandedTreeNodeIds: new Set(),
  activeFunctionId: null,
  activeTreeNodeKey: null,
  hoveredTreeNodeKey: null
};

/** @type {(() => void)[]} */
const subscribers = [];

export function getState() {
  return { flowPayload, uiState };
}

export function setFlowPayload(payload) {
  flowPayload = payload;
  const firstFlow = payload.flows[0];
  uiState = {
    selectedFlowId: firstFlow?.id ?? null,
    expandedIds: firstFlow?.rootId ? new Set([firstFlow.rootId]) : new Set(),
    expandedTreeNodeIds: firstFlow?.rootId ? new Set([`root:${firstFlow.rootId}`]) : new Set(),
    activeFunctionId: null,
    activeTreeNodeKey: null,
    hoveredTreeNodeKey: null
  };
  notify();
}

export function setSelectedFlow(flowId, rootId) {
  uiState.selectedFlowId = flowId;
  uiState.expandedIds = rootId ? new Set([rootId]) : new Set();
  uiState.expandedTreeNodeIds = rootId ? new Set([`root:${rootId}`]) : new Set();
  uiState.activeFunctionId = null;
  uiState.activeTreeNodeKey = null;
  uiState.hoveredTreeNodeKey = null;
  notify();
}

/**
 * Returns all descendant function IDs reachable from the given node via edges.
 */
function getDescendantIds(functionId) {
  const ids = new Set();
  let current = new Set([functionId]);
  while (current.size > 0) {
    const next = new Set();
    for (const e of flowPayload.edges) {
      if (current.has(e.callerId)) {
        ids.add(e.calleeId);
        next.add(e.calleeId);
      }
    }
    current = next;
  }
  return ids;
}

/**
 * Returns all ancestor function IDs on the path from the selected flow root to the given node.
 * Ensures the flow tree can show the path to a node when it is expanded from the code view.
 */
function getAncestorIds(functionId) {
  const selectedFlow = flowPayload.flows?.find((f) => f.id === uiState.selectedFlowId);
  if (!selectedFlow?.rootId) return new Set();
  if (functionId === selectedFlow.rootId) return new Set();
  const ids = new Set();
  let current = new Set([functionId]);
  while (current.size > 0) {
    const next = new Set();
    for (const e of flowPayload.edges) {
      if (current.has(e.calleeId)) {
        ids.add(e.callerId);
        next.add(e.callerId);
      }
    }
    current = next;
  }
  return ids;
}

/**
 * Returns expanded tree node keys that are descendants of the given path-based key.
 * Descendants have keys that start with treeNodeKey + "/".
 */
function getDescendantTreeNodeKeys(treeNodeKey) {
  const prefix = treeNodeKey + '/';
  const keys = new Set();
  for (const k of uiState.expandedTreeNodeIds) {
    if (k.startsWith(prefix)) keys.add(k);
  }
  return keys;
}

/**
 * Ensures one path in the flow tree from root to the given function is expanded (for code-view sync).
 */
function ensurePathToFunctionInTree(functionId) {
  const selectedFlow = flowPayload.flows?.find((f) => f.id === uiState.selectedFlowId);
  if (!selectedFlow?.rootId) return;
  const rootId = selectedFlow.rootId;
  let pathKey = `root:${rootId}`;
  uiState.expandedTreeNodeIds.add(pathKey);
  if (functionId === rootId) return;
  const path = [];
  const parent = new Map();
  for (const e of flowPayload.edges) {
    parent.set(e.calleeId, { callerId: e.callerId, callIndex: e.callIndex, calleeId: e.calleeId });
  }
  let node = functionId;
  while (node && node !== rootId) {
    const edge = parent.get(node);
    if (!edge) break;
    path.push(edge);
    node = edge.callerId;
  }
  for (let i = path.length - 1; i >= 0; i--) {
    const { callerId, callIndex, calleeId } = path[i];
    pathKey = `${pathKey}/e:${callerId}:${callIndex}:${calleeId}`;
    uiState.expandedTreeNodeIds.add(pathKey);
  }
}

export function toggleExpanded(functionId) {
  if (uiState.expandedIds.has(functionId)) {
    uiState.expandedIds.delete(functionId);
    for (const descId of getDescendantIds(functionId)) {
      uiState.expandedIds.delete(descId);
    }
  } else {
    uiState.expandedIds.add(functionId);
    for (const ancId of getAncestorIds(functionId)) {
      uiState.expandedIds.add(ancId);
    }
    ensurePathToFunctionInTree(functionId);
  }
  notify();
}

/**
 * Ensures the path from root to the given tree node is expanded so the node is visible.
 * For path-based keys (root:id or root:id/e:.../e:...), adds all path prefixes.
 */
function ensurePathToTreeNode(treeNodeKey) {
  const parts = treeNodeKey.split('/');
  for (let i = 1; i <= parts.length; i++) {
    uiState.expandedTreeNodeIds.add(parts.slice(0, i).join('/'));
  }
}

/**
 * Toggle expansion of a single tree node (one occurrence in the flow tree).
 * Only that occurrence expands; code view uses expandedTreeNodeIds per call site.
 */
export function toggleExpandedTreeNode(treeNodeKey) {
  if (uiState.expandedTreeNodeIds.has(treeNodeKey)) {
    uiState.expandedTreeNodeIds.delete(treeNodeKey);
    for (const k of getDescendantTreeNodeKeys(treeNodeKey)) {
      uiState.expandedTreeNodeIds.delete(k);
    }
  } else {
    ensurePathToTreeNode(treeNodeKey);
  }
  notify();
}

export function setActiveFunction(functionId, treeNodeKey = null) {
  uiState.activeFunctionId = functionId;
  uiState.activeTreeNodeKey = treeNodeKey;
  notify();
}

export function setHoveredTreeNodeKey(treeNodeKey) {
  if (uiState.hoveredTreeNodeKey !== treeNodeKey) {
    uiState.hoveredTreeNodeKey = treeNodeKey;
    notify();
  }
}

export function subscribe(cb) {
  subscribers.push(cb);
  return () => {
    const i = subscribers.indexOf(cb);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

function notify() {
  subscribers.forEach((cb) => cb());
}

export function initStore() {
  flowPayload = { ...emptyFlowPayload };
  uiState = {
    selectedFlowId: null,
    expandedIds: new Set(),
    expandedTreeNodeIds: new Set(),
    activeFunctionId: null,
    activeTreeNodeKey: null,
    hoveredTreeNodeKey: null
  };
}
