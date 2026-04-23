/**
 * Flow tree pane: shows selected flow as an indented function tree with branch lines.
 * Preserves call order (func2, func5 under func1; func3, func4 under func2).
 */

import {
  getState,
  setActiveFunction,
  restoreCallSiteReturnTreeNode,
  setSelectedFlow
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

  const wrapper = document.createElement('div');
  wrapper.className = 'flow-tree-wrapper';

  const title = document.createElement('div');
  title.className = 'flow-tree-pane-title';
  title.textContent = 'FLOWS';
  wrapper.appendChild(title);

  for (let idx = 0; idx < flowPayload.flows.length; idx++) {
    const flow = flowPayload.flows[idx];
    const root = flowPayload.functionsById[flow.rootId];
    if (!root) continue;
    const rootKey = `root:${root.id}`;
    firstTreeNodeKeyByFunctionId.clear();
    firstTreeNodeKeyByFunctionId.set(root.id, rootKey);

    const section = document.createElement('section');
    section.className = 'flow-tree-flow-section';
    if (flow.id === uiState.selectedFlowId) section.classList.add('active');

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'flow-tree-flow-header';
    if (flow.id === uiState.selectedFlowId) header.classList.add('active');
    header.innerHTML = `
      <span class="flow-tree-flow-dot"></span>
      <span class="flow-tree-flow-title">Flow ${idx + 1} — ${escapeHtml(flow.name ?? root.name ?? flow.rootId)}</span>
    `;
    header.addEventListener('click', () => setSelectedFlow(flow.id, flow.rootId));
    section.appendChild(header);

    const tree = document.createElement('div');
    tree.className = 'flow-tree';
    const pathFromRoot = new Set([root.id]);
    const pathKeysById = new Map([[root.id, rootKey]]);
    renderNode(tree, flowPayload, root, false, rootKey, pathFromRoot, pathKeysById, flow.id, flow.rootId, true, 0);
    section.appendChild(tree);
    wrapper.appendChild(section);

    if (idx < flowPayload.flows.length - 1) {
      const sep = document.createElement('div');
      sep.className = 'flow-tree-flow-separator';
      wrapper.appendChild(sep);
    }
  }

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
function renderNode(
  parent,
  payload,
  fn,
  isLast,
  treeNodeKey,
  pathFromRoot,
  pathKeysById,
  flowId,
  flowRootId,
  forceExpanded = false,
  depth = 0
) {
  const { uiState } = getState();
  const expanded = forceExpanded || uiState.flowTreeExpandedIds.has(treeNodeKey);
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
  const leadingIcon = depth > 0 ? '↳' : '';
  const sharedHint = isMultiFlow
    ? `<span class="flow-tree-shared-hint" title="Also appears in other flows (collapsed in code view)">↗</span>`
    : '';
  const labelHtml = flowTreeLabelHtml(fn);
  row.classList.add(depth === 0 ? 'flow-tree-node-root' : 'flow-tree-node-child');
  row.innerHTML = `<span class="flow-tree-icon">${leadingIcon}</span><span class="flow-tree-label">${labelHtml}${sharedHint}</span>`;
  row.dataset.functionId = fn.id;
  row.dataset.treeNodeKey = treeNodeKey;

  // Record the first time we render this function as a full node (for later references).
  if (!firstTreeNodeKeyByFunctionId.has(fn.id)) {
    firstTreeNodeKeyByFunctionId.set(fn.id, treeNodeKey);
  }
  // Clicking the row selects the function (syncs code view) without toggling expansion.
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    if (uiState.selectedFlowId !== flowId) setSelectedFlow(flowId, flowRootId);
    restoreCallSiteReturnTreeNode(treeNodeKey);
    setActiveFunction(fn.id, treeNodeKey);
  });

  // Clicking the icon toggles expansion independently.
  const iconEl = row.querySelector('.flow-tree-icon');
  if (!forceExpanded && iconEl && hasChildren) {
    iconEl.style.cursor = 'pointer';
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
        recRow.classList.add('flow-tree-node-child');
        recRow.innerHTML = `<span class="flow-tree-icon">↳</span><span class="flow-tree-label">${flowTreeLabelHtml(child)}</span>`;
        recRow.title = 'Click to jump to where this function is shown above';
        recRow.dataset.functionId = child.id;
        recRow.dataset.treeNodeKey = originalKey;
        recRow.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (uiState.selectedFlowId !== flowId) setSelectedFlow(flowId, flowRootId);
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
        renderNode(
          branch,
          payload,
          child,
          i === children.length - 1,
          childKey,
          pathIncludingThis,
          pathKeysIncludingThis,
          flowId,
          flowRootId,
          forceExpanded,
          depth + 1
        );
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
