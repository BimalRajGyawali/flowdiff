/**
 * Renders the 2-pane layout shell and mounts code view and flow tree.
 */

import { renderCodeView, syncCodePanePointerStyles } from './codeView.js';
import { renderFlowTree, patchFlowTreePointerUi } from './flowTree.js';
import { getState, subscribe } from '../state/store.js';

const codePane = document.getElementById('code-pane');
const flowTreePane = document.getElementById('flow-tree-pane');
const flowListPane = document.getElementById('flow-list-pane');
let flowPaneCollapsed = false;
let savedCodePaneFlex = '';
let savedFlowPaneFlex = '';

/** @param {Set<string> | undefined} s */
function serializeSet(s) {
  if (!(s instanceof Set) || s.size === 0) return '';
  return [...s].sort().join('\u0001');
}

function buildCodeStructuralSig() {
  const { flowPayload, uiState, prContext } = getState();
  return [
    prContext?.headSha ?? '',
    String(flowPayload.files?.length ?? 0),
    uiState.selectedFlowId ?? '',
    uiState.selectedStandaloneClassId ?? '',
    serializeSet(uiState.readFunctionIds),
    serializeSet(uiState.collapsedFunctionIds),
    uiState.activeFunctionId ?? '',
    uiState.activeTreeNodeKey ?? '',
    uiState.callSiteCallerTreeNodeKey ?? '',
    serializeSet(uiState.callSiteReturnConsumedKeys),
    String(Object.keys(flowPayload.functionsById || {}).length),
    String((flowPayload.edges || []).length),
    String(Object.keys(flowPayload.classDefAboveMethod || {}).length),
    uiState.codePaneOutsideDiffPath ?? ''
  ].join('|');
}

function buildTreeStructuralSig() {
  const { flowPayload, uiState, prContext } = getState();
  return [
    prContext?.headSha ?? '',
    uiState.selectedFlowId ?? '',
    uiState.selectedStandaloneClassId ?? '',
    serializeSet(uiState.flowTreeExpandedIds),
    serializeSet(uiState.readFunctionIds),
    serializeSet(uiState.completedFlowIds),
    serializeSet(uiState.multiFlowFunctionIds),
    String((flowPayload.flows || []).length),
    String(Object.keys(flowPayload.functionsById || {}).length),
    String((flowPayload.edges || []).length),
    String(Object.keys(flowPayload.classDefAboveMethod || {}).length)
  ].join('|');
}

let prevCodeStructuralSig = null;
let prevTreeStructuralSig = null;
let prevHoveredTreeNodeKey = null;
let prevInViewTreeNodeKey = null;

function render() {
  const { uiState } = getState();
  const hover = uiState.hoveredTreeNodeKey;
  const inView = uiState.inViewTreeNodeKey;
  const codeSig = buildCodeStructuralSig();
  const treeSig = buildTreeStructuralSig();

  const pointerOnly =
    prevCodeStructuralSig != null &&
    prevTreeStructuralSig != null &&
    codeSig === prevCodeStructuralSig &&
    treeSig === prevTreeStructuralSig &&
    (hover !== prevHoveredTreeNodeKey || inView !== prevInViewTreeNodeKey);

  if (pointerOnly) {
    if (hover !== prevHoveredTreeNodeKey) syncCodePanePointerStyles(codePane);
    patchFlowTreePointerUi(flowTreePane);
    prevHoveredTreeNodeKey = hover;
    prevInViewTreeNodeKey = inView;
    return;
  }

  const treeLayoutOnly =
    prevCodeStructuralSig != null && codeSig === prevCodeStructuralSig && treeSig !== prevTreeStructuralSig;

  if (treeLayoutOnly) {
    prevTreeStructuralSig = treeSig;
    prevHoveredTreeNodeKey = hover;
    prevInViewTreeNodeKey = inView;
    renderFlowTree(flowTreePane);
    return;
  }

  prevCodeStructuralSig = codeSig;
  prevTreeStructuralSig = treeSig;
  prevHoveredTreeNodeKey = hover;
  prevInViewTreeNodeKey = inView;
  renderCodeView(codePane);
  renderFlowTree(flowTreePane);
}

function initHorizontalResizers() {
  const main = document.querySelector('.main');
  if (!main || !codePane || !flowTreePane) return;

  // Helper to create a vertical drag handle between two panes.
  function createResizer(leftPane, rightPane) {
    const handle = document.createElement('div');
    handle.className = 'pane-resizer';
    rightPane.parentNode.insertBefore(handle, rightPane);

    let startX = 0;
    let startLeftWidth = 0;
    let startRightWidth = 0;
    let dragging = false;

    function onMouseDown(e) {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      const leftRect = leftPane.getBoundingClientRect();
      const rightRect = rightPane.getBoundingClientRect();
      startLeftWidth = leftRect.width;
      startRightWidth = rightRect.width;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }

    function onMouseMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      let newLeft = startLeftWidth + dx;
      let newRight = startRightWidth - dx;
      const minLeft = 200;
      const minRight = 140;
      if (newLeft < minLeft) {
        newLeft = minLeft;
        newRight = startLeftWidth + startRightWidth - newLeft;
      } else if (newRight < minRight) {
        newRight = minRight;
        newLeft = startLeftWidth + startRightWidth - newRight;
      }
      leftPane.style.flex = `0 0 ${newLeft}px`;
      rightPane.style.flex = `0 0 ${newRight}px`;
    }

    function onMouseUp() {
      dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    handle.addEventListener('mousedown', onMouseDown);
  }

  // Only initialize once.
  if (!main.dataset.resizersInitialized) {
    main.dataset.resizersInitialized = '1';
    createResizer(codePane, flowTreePane);
  }
}

function initPaneToggles() {
  const main = document.querySelector('.main');
  if (!main || !codePane || !flowTreePane) return;
  if (main.dataset.paneTogglesInitialized) return;
  main.dataset.paneTogglesInitialized = '1';

  const flowToggle = document.createElement('button');
  flowToggle.type = 'button';
  flowToggle.className = 'pane-toggle pane-toggle-flow';
  flowToggle.title = 'Collapse/expand rhizome panel';

  function applyFlowPaneCollapsed(nextCollapsed) {
    flowPaneCollapsed = nextCollapsed;
    const resizer = main.querySelector('.pane-resizer');
    if (flowPaneCollapsed) {
      savedCodePaneFlex = codePane.style.flex || '';
      savedFlowPaneFlex = flowTreePane.style.flex || '';
      flowTreePane.style.display = 'none';
      if (resizer) resizer.style.display = 'none';
      codePane.style.flex = '1 1 auto';
      flowToggle.innerHTML = `
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path>
        </svg>
      `;
      flowToggle.title = 'Show rhizome panel';
      flowToggle.setAttribute('aria-label', 'Show rhizome panel');
      flowToggle.setAttribute('aria-expanded', 'false');
    } else {
      flowTreePane.style.display = '';
      if (resizer) resizer.style.display = '';
      if (savedCodePaneFlex) codePane.style.flex = savedCodePaneFlex;
      if (savedFlowPaneFlex) flowTreePane.style.flex = savedFlowPaneFlex;
      flowToggle.innerHTML = `
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z"></path>
        </svg>
      `;
      flowToggle.title = 'Hide rhizome panel';
      flowToggle.setAttribute('aria-label', 'Hide rhizome panel');
      flowToggle.setAttribute('aria-expanded', 'true');
    }
  }

  flowToggle.addEventListener('click', () => {
    applyFlowPaneCollapsed(!flowPaneCollapsed);
  });

  main.appendChild(flowToggle);
  applyFlowPaneCollapsed(false);
}

export function renderLayout() {
  if (flowListPane) flowListPane.style.display = 'none';
  render();
  initHorizontalResizers();
  subscribe(render);
}
