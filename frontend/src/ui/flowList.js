/**
 * Flow list pane: lists discovered flows with root labels.
 */

import { getState, setSelectedFlow } from '../state/store.js';

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

  const list = document.createElement('div');
  list.className = 'flow-list';

  for (const flow of flowPayload.flows) {
    const root = flowPayload.functionsById[flow.rootId];
    const item = document.createElement('div');
    item.className = 'flow-list-item';
    if (flow.id === uiState.selectedFlowId) item.classList.add('selected');
    item.textContent = flow.name ?? (root ? root.name : flow.rootId);
    item.dataset.flowId = flow.id;
    item.addEventListener('click', () => setSelectedFlow(flow.id, flow.rootId));
    list.appendChild(item);
  }

  container.appendChild(list);
}
