/**
 * Renders the 3-pane layout shell and mounts code view, flow tree, and flow list.
 */

import { renderCodeView } from './codeView.js';
import { renderFlowTree } from './flowTree.js';
import { renderFlowList } from './flowList.js';
import { subscribe } from '../state/store.js';

const codePane = document.getElementById('code-pane');
const flowTreePane = document.getElementById('flow-tree-pane');
const flowListPane = document.getElementById('flow-list-pane');

function render() {
  renderCodeView(codePane);
  renderFlowTree(flowTreePane);
  renderFlowList(flowListPane);
}

function initHorizontalResizers() {
  const main = document.querySelector('.main');
  if (!main || !codePane || !flowTreePane || !flowListPane) return;

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
    createResizer(flowTreePane, flowListPane);
  }
}

export function renderLayout() {
  render();
  initHorizontalResizers();
  subscribe(render);
}
