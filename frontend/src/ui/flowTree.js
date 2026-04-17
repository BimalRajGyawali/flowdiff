/**
 * Flow tree pane: shows selected flow as an indented function tree with branch lines.
 * Preserves call order (func2, func5 under func1; func3, func4 under func2).
 */

import {
  getState,
  toggleExpandedTreeNode,
  setActiveFunction,
  restoreCallSiteReturnTreeNode,
  expandFlowTreeToDepth,
  collapseFlowTree,
  getFlowTreeKeysAtDepth
} from '../state/store.js';
import { getFunctionDisplayName } from '../parser/functionDisplayName.js';

// Tracks the first tree-node key where each function ID appears in the current flow tree.
/** @type {Map<string, string>} */
const firstTreeNodeKeyByFunctionId = new Map();

/** @param {string | null | undefined} treeNodeKey */
function parentTreeNodeKey(treeNodeKey) {
  if (!treeNodeKey) return null;
  const idx = treeNodeKey.lastIndexOf('/');
  return idx > 0 ? treeNodeKey.slice(0, idx) : null;
}

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

  const wrapper = document.createElement('div');
  wrapper.className = 'flow-tree-wrapper';

  const hasExpandableNodes = flowPayload.edges.some((e) => e.callerId === root.id);
  const rootKey = `root:${root.id}`;

  // Reset per-render tracking of first occurrences.
  firstTreeNodeKeyByFunctionId.clear();
  firstTreeNodeKeyByFunctionId.set(root.id, rootKey);
  if (hasExpandableNodes) {
    const toolbar = document.createElement('div');
    toolbar.className = 'flow-tree-toolbar';
    const currentFlowKeys = () => {
      const { uiState: state } = getState();
      return new Set([...state.flowTreeExpandedIds].filter((k) => k === rootKey || k.startsWith(rootKey + '/')));
    };
    const setsEqual = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'flow-tree-toolbar-btn';
    allBtn.innerHTML = '<span class="flow-tree-toolbar-icon" aria-hidden="true">⤢</span><span class="flow-tree-toolbar-label">Full tree</span>';
    allBtn.title = 'Expand entire tree (click again to collapse)';
    allBtn.addEventListener('click', () => {
      const target = getFlowTreeKeysAtDepth(Infinity);
      if (setsEqual(currentFlowKeys(), target)) collapseFlowTree();
      else expandFlowTreeToDepth(Infinity);
    });
    toolbar.appendChild(allBtn);
    wrapper.appendChild(toolbar);
  }

  const tree = document.createElement('div');
  tree.className = 'flow-tree';
  const pathFromRoot = new Set([root.id]);
  const pathKeysById = new Map([[root.id, rootKey]]);
  renderNode(tree, flowPayload, root, false, rootKey, pathFromRoot, pathKeysById);

  wrapper.appendChild(tree);
  container.appendChild(wrapper);

  if (uiState.activeTreeNodeKey) {
    const activeRow = container.querySelector(
      `[data-tree-node-key="${CSS.escape(uiState.activeTreeNodeKey)}"]`
    );
    if (activeRow) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      });
    }
  }
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
  const expanded = uiState.flowTreeExpandedIds.has(treeNodeKey);
  const isActive = uiState.activeTreeNodeKey === treeNodeKey;
  const childEdges = payload.edges
    .filter((e) => e.callerId === fn.id)
    .sort((a, b) => a.callIndex - b.callIndex);
  const children = childEdges.map((e) => payload.functionsById[e.calleeId]).filter(Boolean);

  const item = document.createElement('div');
  item.className = 'flow-tree-item' + (isLast ? ' flow-tree-item-last' : '');

  const isInView = uiState.inViewTreeNodeKey === treeNodeKey;
  const isCallHover = uiState.hoveredTreeNodeKey === treeNodeKey;
  const isRead = uiState.readFunctionIds?.has?.(fn.id);
  const isMultiFlow = uiState.multiFlowFunctionIds?.has?.(fn.id);
  const hasChildren = children.length > 0;
  const parentOfActive = parentTreeNodeKey(uiState.activeTreeNodeKey);
  const callerHighlightKey = uiState.callSiteCallerTreeNodeKey ?? parentOfActive;
  const isCallerOfActive = Boolean(callerHighlightKey && callerHighlightKey === treeNodeKey);
  const row = document.createElement('div');
  row.className =
    'flow-tree-node' +
    (isCallerOfActive ? ' flow-tree-node-caller-of-active' : '') +
    (isActive ? ' active' : '') +
    (isInView ? ' in-view' : '') +
    (isCallHover ? ' call-hover-target' : '') +
    (isRead ? ' read' : '');
  const expandIcon = hasChildren ? (expanded ? '▾' : '▸') : '◦';
  const changeBadge = fn.changeType ? `<span class="flow-tree-badge flow-tree-badge-${fn.changeType}" title="${fn.changeType}"></span>` : '';
  const sharedHint = isMultiFlow
    ? `<span class="flow-tree-shared-hint" title="Also appears in other flows (collapsed in code view)">↗</span>`
    : '';
  const labelHtml = flowTreeLabelHtml(fn);
  row.innerHTML = `<span class="flow-tree-icon">${expandIcon}</span><span class="flow-tree-label">${changeBadge}${labelHtml}${sharedHint}</span>`;
  row.dataset.functionId = fn.id;
  row.dataset.treeNodeKey = treeNodeKey;

  // Record the first time we render this function as a full node (for later references).
  if (!firstTreeNodeKeyByFunctionId.has(fn.id)) {
    firstTreeNodeKeyByFunctionId.set(fn.id, treeNodeKey);
  }
  // Clicking the row selects the function (syncs code view) without toggling expansion.
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    restoreCallSiteReturnTreeNode(treeNodeKey);
    setActiveFunction(fn.id, treeNodeKey);
  });

  // Clicking the icon toggles expansion independently.
  const iconEl = row.querySelector('.flow-tree-icon');
  if (iconEl && hasChildren) {
    iconEl.style.cursor = 'pointer';
    iconEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExpandedTreeNode(treeNodeKey);
    });
  }
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
      const firstKey = firstTreeNodeKeyByFunctionId.get(child.id);

      // Treat recursive calls and repeated functions (already shown elsewhere)
      // as references that jump to the original occurrence.
      if (isRecursive || (firstKey && firstKey !== childKey)) {
        const originalKey = isRecursive ? pathKeysById.get(child.id) : firstKey;
        const recItem = document.createElement('div');
        recItem.className = 'flow-tree-item flow-tree-item-recursive';
        const recRow = document.createElement('div');
        const recInView = uiState.inViewTreeNodeKey === originalKey;
        const recCallHover = uiState.hoveredTreeNodeKey === originalKey;
        const recIsRead = uiState.readFunctionIds?.has?.(child.id);
        recRow.className =
          'flow-tree-node flow-tree-node-recursive' +
          (uiState.activeTreeNodeKey === originalKey ? ' active' : '') +
          (recInView ? ' in-view' : '') +
          (recCallHover ? ' call-hover-target' : '') +
          (recIsRead ? ' read' : '');
        recRow.innerHTML = `<span class="flow-tree-icon">↻</span><span class="flow-tree-label">${flowTreeLabelHtml(child)}</span>`;
        recRow.title = 'Click to jump to where this function is shown above';
        recRow.dataset.functionId = child.id;
        recRow.dataset.treeNodeKey = originalKey;
        recRow.addEventListener('click', (ev) => {
          ev.stopPropagation();
          restoreCallSiteReturnTreeNode(originalKey);
          setActiveFunction(child.id, originalKey);
        });
        recItem.appendChild(recRow);
        branch.appendChild(recItem);
      } else {
        // Record the first time we render this function as a full node.
        if (!firstTreeNodeKeyByFunctionId.has(child.id)) {
          firstTreeNodeKeyByFunctionId.set(child.id, childKey);
        }
        renderNode(branch, payload, child, i === children.length - 1, childKey, pathIncludingThis, pathKeysIncludingThis);
      }
    }
    item.appendChild(branch);
  }

  parent.appendChild(item);
}

/**
 * Rich label: methods show class name + dot + method (class segment muted).
 * @param {import('../flowSchema.js').FunctionMeta} fn
 */
function flowTreeLabelHtml(fn) {
  const deletedPrefix = fn.changeType === 'deleted'
    ? '<span class="flow-tree-deleted-tag" title="Deleted function">Deleted</span>'
    : '';
  if (fn.kind === 'method' && fn.className) {
    const cls = escapeHtml(fn.className);
    const nm = escapeHtml(fn.name);
    const title = fn.changeType === 'deleted' ? `Deleted method of class ${cls}` : `Method of class ${cls}`;
    return `${deletedPrefix}<span class="flow-tree-method${fn.changeType === 'deleted' ? ' flow-tree-method-deleted' : ''}" title="${title}"><span class="flow-tree-class-name">${cls}</span><span class="flow-tree-method-dot">.</span><span class="flow-tree-method-name">${nm}</span></span>`;
  }
  const label = escapeHtml(getFunctionDisplayName(fn));
  return `${deletedPrefix}<span class="${fn.changeType === 'deleted' ? 'flow-tree-name-deleted' : ''}">${label}</span>`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
