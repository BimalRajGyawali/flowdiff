/**
 * Flow list pane: lists discovered flows with root labels and metadata.
 */

import { getState, setSelectedFlow } from '../state/store.js';

/**
 * Compute flow metadata: depth, node count, files.
 */
function getFlowMetadata(flow, payload) {
  const ids = new Set([flow.rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const e of payload.edges) {
      if (ids.has(e.callerId) && !ids.has(e.calleeId)) {
        ids.add(e.calleeId);
        added = true;
      }
    }
  }
  const files = new Set();
  for (const id of ids) {
    const fn = payload.functionsById[id];
    if (fn?.file) files.add(fn.file);
  }
  const depth = computeDepth(flow.rootId, payload.edges, new Set());
  return { nodeCount: ids.size, files: Array.from(files), depth };
}

function computeDepth(rootId, edges, visited) {
  if (visited.has(rootId)) return 0;
  visited.add(rootId);
  const children = edges.filter((e) => e.callerId === rootId).map((e) => e.calleeId);
  if (children.length === 0) return 1;
  const childDepths = children.map((c) => computeDepth(c, edges, visited));
  return 1 + Math.max(...childDepths);
}

/**
 * @param {HTMLElement} container
 */
export function renderFlowList(container) {
  const { flowPayload, uiState } = getState();
  container.innerHTML = '';

  if (!flowPayload.flows?.length) {
    container.textContent = 'No flows.';
    return;
  }

  let flows = flowPayload.flows.map((f) => ({
    flow: f,
    root: flowPayload.functionsById[f.rootId],
    meta: getFlowMetadata(f, flowPayload)
  }));

  // Default ordering: largest flows first (by node count).
  flows.sort((a, b) => b.meta.nodeCount - a.meta.nodeCount);

  const list = document.createElement('div');
  list.className = 'flow-list';

  if (flows.length === 0) {
    list.textContent = 'No matching flows.';
    container.appendChild(list);
    return;
  }

  for (const { flow, root, meta } of flows) {
    const item = document.createElement('div');
    item.className = 'flow-list-item';
    if (flow.id === uiState.selectedFlowId) item.classList.add('selected');
    item.dataset.flowId = flow.id;

    const changeType = root?.changeType;
    const badge = changeType ? `<span class="flow-list-badge flow-list-badge-${changeType}" title="${changeType}"></span>` : '';

    const nameEl = document.createElement('div');
    nameEl.className = 'flow-list-item-name';
    nameEl.innerHTML = `${badge}${escapeHtml(flow.name ?? root?.name ?? flow.rootId)}`;
    item.appendChild(nameEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'flow-list-item-meta';
    const fileCountText = meta.files.length === 1 ? '1 file' : `${meta.files.length} files`;
    metaEl.textContent = fileCountText;
    if (meta.files.length > 0) {
      metaEl.title = meta.files.join('\n');
    }
    item.appendChild(metaEl);

    item.addEventListener('click', () => setSelectedFlow(flow.id, flow.rootId));
    list.appendChild(item);
  }

  container.appendChild(list);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
