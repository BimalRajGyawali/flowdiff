/**
 * Flow tree pane: shows selected flow as an indented function tree with branch lines.
 * Preserves call order (func2, func5 under func1; func3, func4 under func2).
 */

import { getState, toggleExpanded, setActiveFunction, setHoveredFunction } from '../state/store.js';

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
  renderNode(tree, flowPayload, root, false);
  tree.addEventListener('mouseleave', () => setHoveredFunction(null));
  container.appendChild(tree);
}

/**
 * @param {HTMLElement} parent
 * @param {import('../flowSchema.js').FlowPayload} payload
 * @param {import('../flowSchema.js').FunctionMeta} fn
 * @param {boolean} isLast - whether this node is the last among its siblings
 */
function renderNode(parent, payload, fn, isLast) {
  const { uiState } = getState();
  const expanded = uiState.expandedIds.has(fn.id);
  const isActive = uiState.activeFunctionId === fn.id;
  const children = payload.edges
    .filter((e) => e.callerId === fn.id)
    .sort((a, b) => a.callIndex - b.callIndex)
    .map((e) => payload.functionsById[e.calleeId])
    .filter(Boolean);

  const item = document.createElement('div');
  item.className = 'flow-tree-item' + (isLast ? ' flow-tree-item-last' : '');

  const row = document.createElement('div');
  row.className = 'flow-tree-node' + (isActive ? ' active' : '');
  const hasChildren = children.length > 0;
  const expandIcon = hasChildren ? (expanded ? '▾' : '▸') : '◦';
  row.innerHTML = `<span class="flow-tree-icon">${expandIcon}</span><span class="flow-tree-label">${escapeHtml(fn.name)}</span>`;
  row.dataset.functionId = fn.id;
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    setActiveFunction(fn.id);
    if (hasChildren) toggleExpanded(fn.id);
  });
  row.addEventListener('mouseenter', () => setHoveredFunction(fn.id));
  row.addEventListener('mouseleave', () => setHoveredFunction(null));
  item.appendChild(row);

  if (hasChildren && expanded) {
    const branch = document.createElement('div');
    branch.className = 'flow-tree-branch';
    for (let i = 0; i < children.length; i++) {
      renderNode(branch, payload, children[i], i === children.length - 1);
    }
    item.appendChild(branch);
  }

  parent.appendChild(item);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
