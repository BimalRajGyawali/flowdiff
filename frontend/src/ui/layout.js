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

export function renderLayout() {
  render();
  subscribe(render);
}
