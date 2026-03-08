/**
 * Central state store for FlowDiff.
 * Holds flow payload, UI state (selected flow, expanded functions, active function),
 * and notifies subscribers on updates.
 */

import { emptyFlowPayload } from '../flowSchema.js';

/** @type {import('../flowSchema.js').FlowPayload} */
let flowPayload = { ...emptyFlowPayload };

/** @type {{ selectedFlowId: string | null, expandedIds: Set<string>, activeFunctionId: string | null, hoveredFunctionId: string | null }} */
let uiState = {
  selectedFlowId: null,
  expandedIds: new Set(),
  activeFunctionId: null,
  hoveredFunctionId: null
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
    activeFunctionId: null,
    hoveredFunctionId: null
  };
  notify();
}

export function setSelectedFlow(flowId, rootId) {
  uiState.selectedFlowId = flowId;
  uiState.expandedIds = rootId ? new Set([rootId]) : new Set();
  uiState.activeFunctionId = null;
  uiState.hoveredFunctionId = null;
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
  }
  notify();
}

export function setActiveFunction(functionId) {
  uiState.activeFunctionId = functionId;
  notify();
}

export function setHoveredFunction(functionId) {
  if (uiState.hoveredFunctionId !== functionId) {
    uiState.hoveredFunctionId = functionId;
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
    activeFunctionId: null,
    hoveredFunctionId: null
  };
}
