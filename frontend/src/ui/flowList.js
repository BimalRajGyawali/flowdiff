/**
 * Flow list pane: lists discovered flows with root labels and metadata.
 * Test flows (file under tests/ or name starting with test_) are grouped under a "Tests" folder.
 */

import { getState, setSelectedFlow, setFlowListTestsExpanded } from '../state/store.js';
import { isTestFunction } from '../parser/isTestFile.js';

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

  const flowsWithMeta = flowPayload.flows.map((f) => ({
    flow: f,
    root: flowPayload.functionsById[f.rootId],
    meta: getFlowMetadata(f, flowPayload)
  }));

  const mainFlows = flowsWithMeta.filter(({ root }) => !isTestFunction(root));
  const testFlows = flowsWithMeta.filter(({ root }) => isTestFunction(root));
  mainFlows.sort((a, b) => b.meta.nodeCount - a.meta.nodeCount);
  testFlows.sort((a, b) => b.meta.nodeCount - a.meta.nodeCount);

  const list = document.createElement('div');
  list.className = 'flow-list';

  if (mainFlows.length === 0 && testFlows.length === 0) {
    list.textContent = 'No matching flows.';
    container.appendChild(list);
    return;
  }

  function appendFlowItem(parent, { flow, root, meta }) {
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

    item.appendChild(metaEl);

    item.addEventListener('click', () => setSelectedFlow(flow.id, flow.rootId));
    parent.appendChild(item);
  }

  for (const entry of mainFlows) {
    appendFlowItem(list, entry);
  }

  if (testFlows.length > 0) {
    const folder = document.createElement('div');
    folder.className = 'flow-list-folder';
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'flow-list-folder-header';
    const testsExpanded = !!uiState.flowListTestsExpanded;
    header.setAttribute('aria-expanded', testsExpanded ? 'true' : 'false');
    header.innerHTML = `<span class="flow-list-folder-icon">${testsExpanded ? '▾' : '▸'}</span> Tests (${testFlows.length})`;
    header.title = 'Test flows (files under tests/ or names starting with test_)';
    const body = document.createElement('div');
    body.className = 'flow-list-folder-body';
    body.hidden = !testsExpanded;
    testFlows.forEach((entry) => appendFlowItem(body, entry));
    folder.appendChild(header);
    folder.appendChild(body);
    header.addEventListener('click', () => {
      const expanded = header.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      header.setAttribute('aria-expanded', next ? 'true' : 'false');
      body.hidden = !next;
      folder.querySelector('.flow-list-folder-icon').textContent = next ? '▾' : '▸';
      setFlowListTestsExpanded(next);
    });
    list.appendChild(folder);
  }

  container.appendChild(list);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
