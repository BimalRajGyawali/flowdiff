/**
 * Central state store for FlowDiff.
 * Holds flow payload, UI state (selected flow, expanded functions, active function),
 * and notifies subscribers on updates.
 */

import { emptyFlowPayload } from '../flowSchema.js';

/** @type {import('../flowSchema.js').FlowPayload} */
let flowPayload = { ...emptyFlowPayload };

/** @type {{ owner: string, repo: string, number: string, headSha: string } | null } */
let prContext = null;

/** @type {{ selectedFlowId: string | null, selectedFileInFlow: string | null, expandedIds: Set<string>, expandedTreeNodeIds: Set<string>, flowTreeExpandedIds: Set<string>, activeFunctionId: string | null, activeTreeNodeKey: string | null, hoveredTreeNodeKey: string | null, inViewTreeNodeKey: string | null, readFunctionIds: Set<string>, collapsedFunctionIds: Set<string>, multiFlowFunctionIds?: Set<string> }} */
let uiState = {
  selectedFlowId: null,
  selectedFileInFlow: null,
  expandedIds: new Set(),
  expandedTreeNodeIds: new Set(),
  flowTreeExpandedIds: new Set(),
  activeFunctionId: null,
  activeTreeNodeKey: null,
  hoveredTreeNodeKey: null,
  inViewTreeNodeKey: null,
  readFunctionIds: new Set(),
  collapsedFunctionIds: new Set(),
  multiFlowFunctionIds: new Set(),
};

// Per-flow cache of tree expansion state so navigating back to a flow restores
// its previous expanded/collapsed nodes.
/** @type {Map<string, { expandedTreeNodeIds: Set<string>, flowTreeExpandedIds: Set<string> }>} */
const flowTreeExpansionByFlowId = new Map();

/** @type {(() => void)[]} */
const subscribers = [];

export function getState() {
  return { flowPayload, uiState, prContext };
}

export function setPrContext(owner, repo, number, headSha) {
  prContext = owner && repo && number && headSha ? { owner, repo, number, headSha } : null;
  notify();
}

export function setFlowPayload(payload) {
  flowPayload = payload;
  const firstFlow = payload.flows[0];
  const rootKey = firstFlow?.rootId ? `root:${firstFlow.rootId}` : null;

  // Expand full tree by default for the initially selected flow.
  let initialTree = new Set();
  if (firstFlow?.rootId) {
    const rootId = firstFlow.rootId;
    const keysToExpand = new Set([`root:${rootId}`]);
    function visit(fnId, pathFromRoot, treeNodeKey) {
      const pathIncludingThis = new Set(pathFromRoot);
      pathIncludingThis.add(fnId);
      const childEdges = payload.edges
        .filter((e) => e.callerId === fnId)
        .sort((a, b) => a.callIndex - b.callIndex);
      if (childEdges.length > 0) keysToExpand.add(treeNodeKey);
      for (const e of childEdges) {
        if (pathIncludingThis.has(e.calleeId)) continue;
        const childKey = `${treeNodeKey}/e:${e.callerId}:${e.callIndex}:${e.calleeId}`;
        visit(e.calleeId, pathIncludingThis, childKey);
      }
    }
    visit(rootId, new Set(), `root:${rootId}`);
    initialTree = keysToExpand;
  }

  // Track functions that participate in more than one flow (used for shared-function hinting).
  // Payload flows exclude test roots (see buildFlows).
  const functionFlowCounts = new Map();
  for (const flow of payload.flows || []) {
    if (!flow.rootId) continue;
    const ids = new Set([flow.rootId]);
    let added = true;
    while (added) {
      added = false;
      for (const e of payload.edges || []) {
        if (ids.has(e.callerId) && !ids.has(e.calleeId)) {
          ids.add(e.calleeId);
          added = true;
        }
      }
    }
    for (const id of ids) {
      functionFlowCounts.set(id, (functionFlowCounts.get(id) || 0) + 1);
    }
  }
  const multiFlowIds = new Set(
    [...functionFlowCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
  );

  uiState = {
    selectedFlowId: firstFlow?.id ?? null,
    selectedFileInFlow: null,
    expandedIds: firstFlow?.rootId ? new Set([firstFlow.rootId]) : new Set(),
    expandedTreeNodeIds: initialTree,
    flowTreeExpandedIds: new Set(initialTree),
    activeFunctionId: null,
    activeTreeNodeKey: null,
    hoveredTreeNodeKey: null,
    inViewTreeNodeKey: null,
    readFunctionIds: new Set(),
    // Do not auto-collapse shared functions; users reported this hides bodies unexpectedly.
    collapsedFunctionIds: new Set(),
    multiFlowFunctionIds: new Set(multiFlowIds),
  };
  flowTreeExpansionByFlowId.clear();
  notify();
}

export function setSelectedFlow(flowId, rootId) {
  // Persist current flow tree expansion state for the previously selected flow.
  if (uiState.selectedFlowId) {
    flowTreeExpansionByFlowId.set(uiState.selectedFlowId, {
      expandedTreeNodeIds: new Set(uiState.expandedTreeNodeIds),
      flowTreeExpandedIds: new Set(uiState.flowTreeExpandedIds)
    });
  }

  uiState.selectedFlowId = flowId;
  uiState.selectedFileInFlow = null;
  uiState.expandedIds = rootId ? new Set([rootId]) : new Set();

  // Restore previous tree expansion for this flow if available; otherwise start at root only.
  const cached = flowTreeExpansionByFlowId.get(flowId);
  if (cached) {
    uiState.expandedTreeNodeIds = new Set(cached.expandedTreeNodeIds);
    uiState.flowTreeExpandedIds = new Set(cached.flowTreeExpandedIds);
  } else {
    // No cached state for this flow yet: expand its full tree by default.
    const fullTree = getFlowTreeKeysAtDepth(Infinity);
    uiState.flowTreeExpandedIds = new Set(fullTree);
    uiState.expandedTreeNodeIds = new Set(fullTree);
  }

  uiState.activeFunctionId = null;
  uiState.activeTreeNodeKey = null;
  uiState.hoveredTreeNodeKey = null;
  uiState.inViewTreeNodeKey = null;
  notify();
}

export function setSelectedFileInFlow(filePath) {
  uiState.selectedFileInFlow = filePath;
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
 * @param {string} treeNodeKey
 * @param {Set<string>} [fromSet] - set to search in (default: flowTreeExpandedIds)
 */
function getDescendantTreeNodeKeys(treeNodeKey, fromSet = uiState.flowTreeExpandedIds) {
  const prefix = treeNodeKey + '/';
  const keys = new Set();
  for (const k of fromSet) {
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
  uiState.flowTreeExpandedIds.add(pathKey);
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
    uiState.flowTreeExpandedIds.add(pathKey);
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
 * Updates both code view and flow tree expansion.
 */
function ensurePathToTreeNode(treeNodeKey) {
  const parts = treeNodeKey.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const key = parts.slice(0, i).join('/');
    uiState.expandedTreeNodeIds.add(key);
    uiState.flowTreeExpandedIds.add(key);
  }
}

/**
 * Toggle expansion of a single tree node. Updates both flow tree and code view.
 */
export function toggleExpandedTreeNode(treeNodeKey) {
  if (uiState.flowTreeExpandedIds.has(treeNodeKey)) {
    uiState.flowTreeExpandedIds.delete(treeNodeKey);
    uiState.expandedTreeNodeIds.delete(treeNodeKey);
    for (const k of getDescendantTreeNodeKeys(treeNodeKey)) {
      uiState.flowTreeExpandedIds.delete(k);
      uiState.expandedTreeNodeIds.delete(k);
    }
  } else {
    ensurePathToTreeNode(treeNodeKey);
  }
  notify();
}

/**
 * Returns the set of tree node keys that would be expanded for the selected flow at the given depth.
 * @param {number} maxDepth - use Infinity for "expand all"
 * @returns {Set<string>}
 */
export function getFlowTreeKeysAtDepth(maxDepth) {
  const selectedFlow = flowPayload.flows?.find((f) => f.id === uiState.selectedFlowId);
  if (!selectedFlow?.rootId) return new Set();
  const rootId = selectedFlow.rootId;
  const rootKey = `root:${rootId}`;
  const keysToExpand = new Set([rootKey]);

  function visit(fnId, depth, pathFromRoot, treeNodeKey) {
    if (depth >= maxDepth) return;
    const pathIncludingThis = new Set(pathFromRoot);
    pathIncludingThis.add(fnId);
    const childEdges = flowPayload.edges
      .filter((e) => e.callerId === fnId)
      .sort((a, b) => a.callIndex - b.callIndex);
    if (childEdges.length > 0) keysToExpand.add(treeNodeKey);
    for (const e of childEdges) {
      if (pathIncludingThis.has(e.calleeId)) continue;
      const childKey = `${treeNodeKey}/e:${e.callerId}:${e.callIndex}:${e.calleeId}`;
      visit(e.calleeId, depth + 1, pathIncludingThis, childKey);
    }
  }

  const rootChildEdges = flowPayload.edges
    .filter((e) => e.callerId === rootId)
    .sort((a, b) => a.callIndex - b.callIndex);
  if (rootChildEdges.length > 0 && maxDepth > 0) keysToExpand.add(rootKey);
  for (const e of rootChildEdges) {
    if (e.calleeId === rootId) continue;
    const pathIncludingThis = new Set([rootId]);
    if (pathIncludingThis.has(e.calleeId)) continue;
    const childKey = `${rootKey}/e:${e.callerId}:${e.callIndex}:${e.calleeId}`;
    visit(e.calleeId, 1, pathIncludingThis, childKey);
  }

  return keysToExpand;
}

/**
 * Expand the flow tree (tree pane only) to a given depth, or all nodes. Does not change code view.
 * @param {number} maxDepth - use Infinity for "expand all"
 */
export function expandFlowTreeToDepth(maxDepth) {
  uiState.flowTreeExpandedIds = getFlowTreeKeysAtDepth(maxDepth);
  notify();
}

/**
 * Collapse the flow tree to root only (tree pane only). Does not change code view.
 */
export function collapseFlowTree() {
  const selectedFlow = flowPayload.flows?.find((f) => f.id === uiState.selectedFlowId);
  if (!selectedFlow?.rootId) return;
  uiState.flowTreeExpandedIds = new Set([`root:${selectedFlow.rootId}`]);
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

export function setInViewTreeNodeKey(treeNodeKey) {
  if (uiState.inViewTreeNodeKey !== treeNodeKey) {
    uiState.inViewTreeNodeKey = treeNodeKey;
    notify();
  }
}

/**
 * Toggle or set the collapsed/expanded state for a function block in the code view.
 * @param {string} functionId
 * @param {boolean} [isCollapsed] - if omitted, toggles; otherwise sets explicitly
 */
export function setFunctionCollapsedState(functionId, isCollapsed) {
  const currentlyCollapsed = uiState.collapsedFunctionIds.has(functionId);
  const next = typeof isCollapsed === 'boolean' ? isCollapsed : !currentlyCollapsed;
  if (next === currentlyCollapsed) return;
  if (next) uiState.collapsedFunctionIds.add(functionId);
  else uiState.collapsedFunctionIds.delete(functionId);
  notify();
}

/**
 * Toggle or set the "read/done" state for a function block.
 * @param {string} functionId
 * @param {boolean} [isRead] - if omitted, toggles; otherwise sets explicitly
 */
export function setFunctionReadState(functionId, isRead) {
  const currentlyRead = uiState.readFunctionIds.has(functionId);
  const next = typeof isRead === 'boolean' ? isRead : !currentlyRead;
  if (next === currentlyRead) return;
  if (next) uiState.readFunctionIds.add(functionId);
  else uiState.readFunctionIds.delete(functionId);
  notify();
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
  prContext = null;
  uiState = {
    selectedFlowId: null,
    selectedFileInFlow: null,
    flowListFilter: '',
    flowListSort: 'name',
    expandedIds: new Set(),
    expandedTreeNodeIds: new Set(),
    flowTreeExpandedIds: new Set(),
    activeFunctionId: null,
    activeTreeNodeKey: null,
    hoveredTreeNodeKey: null,
    inViewTreeNodeKey: null,
    readFunctionIds: new Set(),
    collapsedFunctionIds: new Set(),
    multiFlowFunctionIds: new Set(),
  };
}
