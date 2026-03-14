/**
 * Flow tree pane: shows selected flow as an indented function tree with branch lines.
 * Preserves call order (func2, func5 under func1; func3, func4 under func2).
 */

import { getState, toggleExpandedTreeNode, setActiveFunction, setHoveredTreeNodeKey } from '../state/store.js';

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
  const rootKey = `root:${root.id}`;
  const pathFromRoot = new Set([root.id]);
  const pathKeysById = new Map([[root.id, rootKey]]);
  renderNode(tree, flowPayload, root, false, rootKey, pathFromRoot, pathKeysById);
  tree.addEventListener('mouseleave', () => setHoveredTreeNodeKey(null));
  container.appendChild(tree);
}

/**
 * @param {HTMLElement} parent
 * @param {import('../flowSchema.js').FlowPayload} payload
 * @param {import('../flowSchema.js').FunctionMeta} fn
 * @param {boolean} isLast - whether this node is the last among its siblings
 * @param {string} treeNodeKey - unique path-based key (root:id or parentPath/e:callerId:callIndex:calleeId)
 * @param {Set<string>} pathFromRoot - function IDs from root to this node (recursion = callee already in path, e.g. A→C→A)
 * @param {Map<string, string>} pathKeysById - function id -> treeNodeKey of first occurrence on path (so recursive click can jump to original)
 */
function renderNode(parent, payload, fn, isLast, treeNodeKey, pathFromRoot, pathKeysById) {
  const { uiState } = getState();
  const expanded = uiState.expandedTreeNodeIds.has(treeNodeKey);
  const isActive = uiState.activeTreeNodeKey === treeNodeKey;
  const childEdges = payload.edges
    .filter((e) => e.callerId === fn.id)
    .sort((a, b) => a.callIndex - b.callIndex);
  const children = childEdges.map((e) => payload.functionsById[e.calleeId]).filter(Boolean);

  const item = document.createElement('div');
  item.className = 'flow-tree-item' + (isLast ? ' flow-tree-item-last' : '');

  const row = document.createElement('div');
  row.className = 'flow-tree-node' + (isActive ? ' active' : '');
  const hasChildren = children.length > 0;
  const expandIcon = hasChildren ? (expanded ? '▾' : '▸') : '◦';
  const changeBadge = fn.changeType ? `<span class="flow-tree-badge flow-tree-badge-${fn.changeType}" title="${fn.changeType}"></span>` : '';
  row.innerHTML = `<span class="flow-tree-icon">${expandIcon}</span><span class="flow-tree-label">${changeBadge}${escapeHtml(fn.name)}</span>`;
  row.dataset.functionId = fn.id;
  row.dataset.treeNodeKey = treeNodeKey;
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    setActiveFunction(fn.id, treeNodeKey);
    toggleExpandedTreeNode(treeNodeKey);
  });
  row.addEventListener('mouseenter', () => setHoveredTreeNodeKey(treeNodeKey));
  row.addEventListener('mouseleave', () => setHoveredTreeNodeKey(null));
  item.appendChild(row);

  if (hasChildren && expanded) {
    const branch = document.createElement('div');
    branch.className = 'flow-tree-branch';
    const pathIncludingThis = new Set(pathFromRoot);
    pathIncludingThis.add(fn.id);
    const pathKeysIncludingThis = new Map(pathKeysById);
    pathKeysIncludingThis.set(fn.id, treeNodeKey);
    for (let i = 0; i < children.length; i++) {
      const e = childEdges[i];
      const childKey = `${treeNodeKey}/e:${e.callerId}:${e.callIndex}:${e.calleeId}`;
      const child = children[i];
      const isRecursive = pathIncludingThis.has(child.id);
      if (isRecursive) {
        const originalKey = pathKeysById.get(child.id);
        const recItem = document.createElement('div');
        recItem.className = 'flow-tree-item flow-tree-item-recursive';
        const recRow = document.createElement('div');
        recRow.className = 'flow-tree-node flow-tree-node-recursive' + (uiState.activeTreeNodeKey === originalKey ? ' active' : '');
        recRow.innerHTML = `<span class="flow-tree-icon">↻</span><span class="flow-tree-label">${escapeHtml(child.name)} <span class="flow-tree-recursive-hint">(already above)</span></span>`;
        recRow.title = 'Recursive call — click to go to original above';
        recRow.dataset.functionId = child.id;
        recRow.dataset.treeNodeKey = originalKey;
        recRow.addEventListener('click', (ev) => {
          ev.stopPropagation();
          setActiveFunction(child.id, originalKey);
        });
        recRow.addEventListener('mouseenter', () => setHoveredTreeNodeKey(originalKey));
        recRow.addEventListener('mouseleave', () => setHoveredTreeNodeKey(null));
        recItem.appendChild(recRow);
        branch.appendChild(recItem);
      } else {
        renderNode(branch, payload, child, i === children.length - 1, childKey, pathIncludingThis, pathKeysIncludingThis);
      }
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
