/**
 * Central state store for FlowDiff.
 * Holds flow payload, UI state (selected flow, expanded functions, active function),
 * and notifies subscribers on updates.
 */

import { emptyFlowPayload } from '../flowSchema.js';

/** @type {import('../flowSchema.js').FlowPayload} */
let flowPayload = { ...emptyFlowPayload };

/** @type {{ selectedFlowId: string | null, expandedIds: Set<string>, activeFunctionId: string | null }} */
let uiState = {
  selectedFlowId: null,
  expandedIds: new Set(),
  activeFunctionId: null
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
    activeFunctionId: null
  };
  notify();
}

export function setSelectedFlow(flowId, rootId) {
  uiState.selectedFlowId = flowId;
  uiState.expandedIds = rootId ? new Set([rootId]) : new Set();
  uiState.activeFunctionId = null;
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

export function toggleExpanded(functionId) {
  if (uiState.expandedIds.has(functionId)) {
    uiState.expandedIds.delete(functionId);
    for (const descId of getDescendantIds(functionId)) {
      uiState.expandedIds.delete(descId);
    }
  } else {
    uiState.expandedIds.add(functionId);
  }
  notify();
}

export function setActiveFunction(functionId) {
  uiState.activeFunctionId = functionId;
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
  uiState = {
    selectedFlowId: null,
    expandedIds: new Set(),
    activeFunctionId: null
  };
}
