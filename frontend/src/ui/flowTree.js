/**
 * Flow tree pane: shows selected flow as an indented function tree.
 * Preserves call order (func2, func5 under func1; func3, func4 under func2).
 */

import { getState, toggleExpanded, setActiveFunction } from '../state/store.js';

/**
 * @param {HTMLElement} container
 */
export function renderFlowTree(container) {
  const { flowPayload, uiState } = getState();
  container.innerHTML = '';

  if (!flowPayload.flows?.length) {
    container.textContent = 'No flows.';
    return;
  }

  const selectedFlow = flowPayload.flows.find((f) => f.id === uiState.selectedFlowId);
  if (!selectedFlow) {
    container.textContent = 'Select a flow.';
    return;
  }

  const root = flowPayload.functionsById[selectedFlow.rootId];
  if (!root) {
    container.textContent = 'Root not found.';
    return;
  }

  const tree = document.createElement('div');
  tree.className = 'flow-tree';
  renderNode(tree, flowPayload, root, 0);
  container.appendChild(tree);
}

/**
 * @param {HTMLElement} parent
 * @param {import('../flowSchema.js').FlowPayload} payload
 * @param {import('../flowSchema.js').FunctionMeta} fn
 * @param {number} depth
 */
function renderNode(parent, payload, fn, depth) {
  const { uiState } = getState();
  const expanded = uiState.expandedIds.has(fn.id);
  const isActive = uiState.activeFunctionId === fn.id;
  const children = payload.edges
    .filter((e) => e.callerId === fn.id)
    .sort((a, b) => a.callIndex - b.callIndex)
    .map((e) => payload.functionsById[e.calleeId])
    .filter(Boolean);

  const row = document.createElement('div');
  row.className = 'flow-tree-node' + (isActive ? ' active' : '');
  row.style.paddingLeft = `${depth * 16}px`;
  const prefix = children.length > 0 ? (expanded ? '− ' : '+ ') : '';
  row.textContent = prefix + fn.name;
  row.dataset.functionId = fn.id;
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    setActiveFunction(fn.id);
    if (children.length > 0) toggleExpanded(fn.id);
  });
  parent.appendChild(row);

  if (children.length > 0 && expanded) {
    for (const child of children) {
      renderNode(parent, payload, child, depth + 1);
    }
  }
}
