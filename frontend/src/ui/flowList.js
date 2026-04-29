/**
 * Flow list pane: lists discovered flows with root labels and metadata.
 * Test-only roots are omitted (see buildFlows); this list is production flows only.
 */

import { getState, selectRhizomeFlow, setFlowCompletedState } from '../state/store.js';

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
  return { nodeCount: ids.size, ids, files: Array.from(files), depth };
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

  const flowsWithMeta = flowPayload.flows
    .map((f) => ({
      flow: f,
      root: flowPayload.functionsById[f.rootId],
      meta: getFlowMetadata(f, flowPayload)
    }))
    .filter(({ root }) => root);
  flowsWithMeta.sort((a, b) => b.meta.nodeCount - a.meta.nodeCount);

  const list = document.createElement('div');
  list.className = 'flow-list';

  if (flowsWithMeta.length === 0) {
    list.textContent = 'No flows.';
    container.appendChild(list);
    return;
  }

  function appendFlowItem(parent, { flow, root, meta }) {
    const item = document.createElement('div');
    item.className = 'flow-list-item';
    if (flow.id === uiState.selectedFlowId) item.classList.add('selected');
    if (uiState.completedFlowIds?.has(flow.id)) item.classList.add('flow-list-item-flow-complete');
    item.dataset.flowId = flow.id;

    const completeLabel = document.createElement('label');
    completeLabel.className = 'flow-list-flow-complete-label';
    completeLabel.title = 'Mark entire flow as complete';
    const completeCheck = document.createElement('input');
    completeCheck.type = 'checkbox';
    completeCheck.className = 'flow-list-flow-complete-check';
    completeCheck.checked = uiState.completedFlowIds?.has(flow.id) ?? false;
    completeCheck.setAttribute('aria-label', 'Mark entire flow as complete');
    completeCheck.addEventListener('click', (e) => e.stopPropagation());
    completeCheck.addEventListener('mousedown', (e) => e.stopPropagation());
    completeCheck.addEventListener('change', (e) => {
      e.stopPropagation();
      setFlowCompletedState(flow.id, completeCheck.checked);
    });
    completeLabel.addEventListener('click', (e) => e.stopPropagation());
    completeLabel.appendChild(completeCheck);

    const changeType = root?.changeType;
    const badge = changeType ? `<span class="flow-list-badge flow-list-badge-${changeType}" title="${changeType}"></span>` : '';

    const nameEl = document.createElement('div');
    nameEl.className = 'flow-list-item-name';
    const name = escapeHtml(flow.name ?? root?.name ?? flow.rootId);
    const nameClass = root?.changeType === 'deleted' ? 'flow-list-name-deleted' : '';
    const deletedTag = root?.changeType === 'deleted'
      ? '<span class="flow-list-deleted-tag" title="Deleted function">Deleted</span>'
      : '';
    nameEl.innerHTML = `${badge}${deletedTag}<span class="${nameClass}">${name}</span>`;

    const metaEl = document.createElement('div');
    metaEl.className = 'flow-list-item-meta';
    const fileCountText = meta.files.length === 1 ? '1 file' : `${meta.files.length} files`;
    const totalFns = meta.nodeCount || 0;
    let doneFns = 0;
    if (totalFns > 0 && uiState.readFunctionIds?.size) {
      for (const id of meta.ids) {
        if (uiState.readFunctionIds.has(id)) doneFns += 1;
      }
    }
    const pct = totalFns > 0 ? Math.round((doneFns / totalFns) * 100) : 0;

    const barOuter = document.createElement('div');
    barOuter.className = 'flow-progress-bar';
    const barInner = document.createElement('div');
    barInner.className = 'flow-progress-bar-fill';
    barInner.style.width = `${pct}%`;
    barOuter.appendChild(barInner);

    const metaText = document.createElement('span');
    metaText.className = 'flow-list-meta-text';
    metaText.textContent = fileCountText;

    metaEl.appendChild(metaText);
    metaEl.appendChild(barOuter);

    if (meta.files.length > 0) {
      metaEl.title = `${meta.files.join('\n')}\n\nDone: ${doneFns}/${totalFns} (${pct}%)`;
    }

    if (pct === 100) {
      item.classList.add('flow-list-item-complete');
    }

    const body = document.createElement('div');
    body.className = 'flow-list-item-body';
    body.appendChild(nameEl);
    body.appendChild(metaEl);

    item.appendChild(completeLabel);
    item.appendChild(body);

    item.addEventListener('click', () => selectRhizomeFlow(flow.id));
    parent.appendChild(item);
  }

  for (const entry of flowsWithMeta) {
    appendFlowItem(list, entry);
  }

  container.appendChild(list);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
