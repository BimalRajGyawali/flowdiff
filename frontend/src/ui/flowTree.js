/**
 * Flow tree pane: shows selected flow as an indented function tree with branch lines.
 * Preserves call order (func2, func5 under func1; func3, func4 under func2).
 */

import {
  getState,
  setActiveFunction,
  restoreCallSiteReturnTreeNode,
  setSelectedFlow,
  setSelectedStandaloneClass,
  toggleFlowTreeSectionCollapsed,
  toggleExpandedTreeNode
} from '../state/store.js';
import { getFunctionDisplayName } from '../parser/functionDisplayName.js';

// Tracks the first tree-node key where each function ID appears in the current flow tree.
/** @type {Map<string, string>} */
const firstTreeNodeKeyByFunctionId = new Map();
const FLOW_TREE_BASE_INDENT_PX = 6;
const FLOW_TREE_STEP_INDENT_PX = 6;
const FLOW_TREE_DEEP_STEP_INDENT_PX = 1;
const FLOW_TREE_COMPACT_DEPTH_THRESHOLD = 2;
const FLOW_TREE_COMPACT_FLOW_COUNT_THRESHOLD = 16;
const FLOW_TREE_COMPACT_FLOW_NODE_THRESHOLD = 30;

/**
 * Compressed indent scale: normal spacing for early levels, tighter spacing for deeper levels.
 * Keeps call graphs readable without pushing nodes too far right.
 * @param {number} depth
 * @returns {number}
 */
function flowTreeIndentPx(depth) {
  const d = Math.max(0, Number(depth) || 0);
  const shallow = Math.min(d, FLOW_TREE_COMPACT_DEPTH_THRESHOLD);
  const deep = Math.max(0, d - FLOW_TREE_COMPACT_DEPTH_THRESHOLD);
  return FLOW_TREE_BASE_INDENT_PX + shallow * FLOW_TREE_STEP_INDENT_PX + deep * FLOW_TREE_DEEP_STEP_INDENT_PX;
}

/**
 * @param {string | null} selectedFlowId
 * @param {Map<string, Set<string>>} flowFnIdsByFlowId
 */
function selectedFlowNodeCount(selectedFlowId, flowFnIdsByFlowId) {
  if (!selectedFlowId) return 0;
  return flowFnIdsByFlowId.get(selectedFlowId)?.size || 0;
}

function topLevelClassName(className) {
  const raw = String(className || '').trim();
  if (!raw) return '';
  return raw.split('.')[0];
}

function singleClassNameForFlow(flowFnIds, payload) {
  let classKey = null;
  let className = null;
  for (const id of flowFnIds) {
    const fn = payload.functionsById[id];
    if (!fn || fn.kind !== 'method' || !fn.className || !fn.file) return null;
    const top = topLevelClassName(fn.className);
    const key = `${fn.file}::${top}`;
    if (classKey == null) {
      classKey = key;
      className = top;
      continue;
    }
    if (classKey !== key) return null;
  }
  return className;
}

function classToneForFlow(flowFnIds, payload, singleClassName) {
  if (!singleClassName || !flowFnIds?.size) return 'neutral';
  const firstId = flowFnIds.values().next().value;
  const firstFn = firstId ? payload.functionsById[firstId] : null;
  const classMeta = Object.values(payload.functionsById || {}).find(
    (fn) =>
      fn &&
      fn.kind === 'class' &&
      topLevelClassName(fn.className) === singleClassName &&
      fn.file === firstFn?.file &&
      fn.changeType !== 'deleted'
  );
  const changeType = classMeta?.changeType;
  if (changeType === 'added') return 'added';
  if (changeType === 'modified') return 'modified';
  if (changeType === 'deleted') return 'deleted';
  return 'neutral';
}

function changedClassAnchorMethodForFlow(flowFnIds, payload, singleClassName) {
  if (!singleClassName || !flowFnIds?.size || !payload?.classDefAboveMethod) return null;
  for (const id of flowFnIds) {
    const fn = payload.functionsById[id];
    if (!fn || fn.kind !== 'method' || topLevelClassName(fn.className) !== singleClassName) continue;
    const classId = payload.classDefAboveMethod[id];
    const classMeta = classId ? payload.functionsById[classId] : null;
    if (classMeta && classMeta.changeType !== 'deleted') return { methodId: id, classId };
  }
  return null;
}

/** @param {string | null | undefined} treeNodeKey */
function parentTreeNodeKey(treeNodeKey) {
  if (!treeNodeKey) return null;
  const idx = treeNodeKey.lastIndexOf('/');
  return idx > 0 ? treeNodeKey.slice(0, idx) : null;
}

/**
 * @param {{ start: number, end: number }[]} moduleChangedRanges
 * @param {string[]} sourceLines
 * @param {string[]} [moduleChangedSymbols]
 * @returns {string[]}
 */
function collectModuleRefSymbolsForScoring(moduleChangedRanges, sourceLines, moduleChangedSymbols) {
  const set = new Set(moduleChangedSymbols || []);
  for (const r of moduleChangedRanges || []) {
    for (let ln = r.start; ln <= r.end; ln++) {
      const line = sourceLines[ln - 1] ?? '';
      if (/^\s+/.test(line)) continue;
      if (/^\s*#/.test(line)) continue;
      const fromImport = line.match(/^\s*from\s+[\w.]+\s+import\s+(.+)/);
      if (fromImport) {
        const tail = fromImport[1].split('#')[0];
        for (const raw of tail.split(',')) {
          const seg = raw.trim();
          if (!seg || seg === '(' || seg === ')') continue;
          const asPair = seg.match(/^(\w+)\s+as\s+(\w+)$/i);
          if (asPair) {
            set.add(asPair[1]);
            set.add(asPair[2]);
            continue;
          }
          const bare = seg.match(/^(\w+)$/);
          if (bare && bare[1] !== '*') set.add(bare[1]);
        }
        continue;
      }
      const plainImport = line.match(/^\s*import\s+(.+)/);
      if (plainImport) {
        const tail = plainImport[1].split('#')[0];
        for (const raw of tail.split(',')) {
          const seg = raw.trim();
          const asOnly = seg.match(/^[\w.]+\s+as\s+(\w+)$/i);
          if (asOnly) {
            set.add(asOnly[1]);
            continue;
          }
          const first = seg.match(/^[\w.]+/);
          if (first) {
            const root = first[0].split('.')[0];
            if (root) set.add(root);
          }
        }
      }
    }
  }
  return [...set].filter((s) => s && /^[A-Za-z_]\w*$/.test(String(s)));
}

/**
 * @param {import('../flowSchema.js').FunctionMeta} fn
 * @param {string[]} symbols
 * @param {string[]} sourceLines
 * @returns {number}
 */
function countModuleSymbolRefsInBody(fn, symbols, sourceLines) {
  const start = Number(fn.startLine);
  const end = Number(fn.endLine);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  const body = sourceLines.slice(start - 1, end).join('\n');
  let total = 0;
  for (const sym of symbols) {
    if (!sym || !/^[A-Za-z_]\w*$/.test(sym)) continue;
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'g');
    const m = body.match(re);
    if (m) total += m.length;
  }
  return total;
}

/**
 * @param {string} rootId
 * @param {import('../flowSchema.js').FlowPayload} payload
 * @returns {string[]}
 */
function collectFlowFunctionOrderIds(rootId, payload) {
  const ordered = [];
  const visited = new Set();
  function visit(fnId, pathFromRoot) {
    if (visited.has(fnId)) return;
    visited.add(fnId);
    const pathIncludingThis = new Set(pathFromRoot);
    pathIncludingThis.add(fnId);
    ordered.push(fnId);
    const childEdges = payload.edges
      .filter((e) => e.callerId === fnId)
      .sort((a, b) => a.callIndex - b.callIndex);
    for (const e of childEdges) {
      if (pathIncludingThis.has(e.calleeId)) continue;
      visit(e.calleeId, pathIncludingThis);
    }
  }
  visit(rootId, new Set());
  return ordered;
}

/**
 * Pick host function/class for module-context lines for one file under one selected flow.
 * Mirrors the same ladder used by code view host selection.
 * @returns {string | null}
 */
function pickModuleContextHostFunctionId({
  filePath,
  payload,
  selectedFlow,
  flowFnIdsByFlowId,
  sourceLinesByFile
}) {
  const fileMeta = (payload.files || []).find((f) => f.path === filePath);
  if (!fileMeta?.moduleChangedRanges?.length) return null;
  const candidates = Object.values(payload.functionsById).filter(
    (f) =>
      f &&
      f.file === filePath &&
      ['function', 'method', 'class'].includes(f.kind || 'function') &&
      f.changeType !== 'deleted'
  );
  if (!candidates.length) return null;

  const refSymbols = collectModuleRefSymbolsForScoring(
    fileMeta.moduleChangedRanges,
    sourceLinesByFile[filePath] || [],
    fileMeta.moduleChangedSymbols || []
  );
  let bestScore = -1;
  const scores = new Map();
  for (const fn of candidates) {
    const sc = refSymbols.length
      ? countModuleSymbolRefsInBody(fn, refSymbols, sourceLinesByFile[filePath] || [])
      : 0;
    scores.set(fn.id, sc);
    if (sc > bestScore) bestScore = sc;
  }
  const tied = new Set(candidates.filter((fn) => scores.get(fn.id) === bestScore).map((fn) => fn.id));

  const qualifying = [];
  for (let i = 0; i < (payload.flows || []).length; i++) {
    const flow = payload.flows[i];
    const flowIds = flowFnIdsByFlowId.get(flow.id);
    if (!flow?.rootId || !flowIds) continue;
    let hit = false;
    for (const id of tied) {
      if (flowIds.has(id)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    qualifying.push({ flow, size: flowIds.size, index: i });
  }
  if (qualifying.length) {
    const maxSize = Math.max(...qualifying.map((q) => q.size));
    const largest = qualifying.filter((q) => q.size === maxSize).sort((a, b) => a.index - b.index);
    const ordered = collectFlowFunctionOrderIds(largest[0].flow.rootId, payload);
    for (const id of ordered) {
      if (tied.has(id)) return id;
    }
  }
  if (selectedFlow?.rootId) {
    const ordered = collectFlowFunctionOrderIds(selectedFlow.rootId, payload);
    for (const id of ordered) {
      if (tied.has(id)) return id;
    }
  }
  const fallback = candidates
    .filter((fn) => tied.has(fn.id))
    .sort((a, b) => a.startLine - b.startLine || String(a.id).localeCompare(String(b.id)));
  return fallback[0]?.id ?? null;
}

/**
 * GitHub-style +/- line totals for a rhizome (union of files touched by flow nodes).
 * @param {Set<string>} flowFnIds
 * @param {import('../flowSchema.js').FlowPayload} payload
 */
function getRhizomeLineDiffStats(flowFnIds, payload, selectedFlow, flowFnIdsByFlowId, sourceLinesByFile) {
  /** @type {Map<string, { start: number, end: number }[]>} */
  const rangesByFile = new Map();
  /** @type {Map<string, Set<number>>} */
  const explicitLinesByFile = new Map();
  for (const id of flowFnIds) {
    const fn = payload.functionsById[id];
    if (!fn?.file) continue;
    const start = Number(fn.startLine);
    const end = Number(fn.endLine);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const list = rangesByFile.get(fn.file) || [];
    list.push({ start, end });
    rangesByFile.set(fn.file, list);
  }
  // Add class-definition slices that are rendered above method bodies in code view.
  for (const id of flowFnIds) {
    const methodFn = payload.functionsById[id];
    if (!methodFn || methodFn.kind !== 'method' || !payload.classDefAboveMethod) continue;
    const classId = payload.classDefAboveMethod[methodFn.id];
    const classMeta = classId ? payload.functionsById[classId] : null;
    if (!classMeta || classMeta.file !== methodFn.file) continue;
    const rStart = Number(classMeta.startLine);
    const rEnd = Number(methodFn.startLine) - 1;
    if (!Number.isFinite(rStart) || !Number.isFinite(rEnd) || rEnd < rStart) continue;
    const explicit = explicitLinesByFile.get(methodFn.file) || new Set();
    for (let ln = rStart; ln <= rEnd; ln++) explicit.add(ln);
    // Mirror mountEnclosingClassDefinitionInBody: remove earlier method bodies in same class.
    for (const f of Object.values(payload.functionsById)) {
      if (!f || f.kind !== 'method') continue;
      if (f.id === methodFn.id) continue;
      if (f.file !== methodFn.file || f.className !== methodFn.className) continue;
      if (Number(f.startLine) < Number(methodFn.startLine)) {
        for (let ln = Number(f.startLine); ln <= Number(f.endLine); ln++) explicit.delete(ln);
      }
    }
    explicitLinesByFile.set(methodFn.file, explicit);
  }
  // Add module-level ranges only for files whose host function belongs to this rhizome.
  for (const file of payload.files || []) {
    if (!file.path || !file.moduleChangedRanges?.length) continue;
    const hostId = pickModuleContextHostFunctionId({
      filePath: file.path,
      payload,
      selectedFlow,
      flowFnIdsByFlowId,
      sourceLinesByFile
    });
    if (!hostId || !flowFnIds.has(hostId)) continue;
    const list = rangesByFile.get(file.path) || [];
    for (const r of file.moduleChangedRanges) {
      if (Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start) {
        list.push({ start: r.start, end: r.end });
      }
    }
    rangesByFile.set(file.path, list);
  }

  const addKeys = new Set();
  const delKeys = new Set();
  const inRanges = (lineNo, ranges, explicit) =>
    ranges.some((r) => lineNo >= r.start && lineNo <= r.end) || explicit?.has(lineNo);

  for (const file of payload.files || []) {
    const ranges = rangesByFile.get(file.path);
    const explicit = explicitLinesByFile.get(file.path);
    if (!ranges?.length && !explicit?.size) continue;
    for (const h of file.hunks || []) {
      let oldLine = h.oldStart;
      let newLine = h.newStart;
      for (const line of h.lines || []) {
        if (line.startsWith('+')) {
          if (inRanges(newLine, ranges || [], explicit)) addKeys.add(`${file.path}:${newLine}`);
          newLine += 1;
          continue;
        }
        if (line.startsWith('-')) {
          const anchorInRange = inRanges(newLine, ranges || [], explicit);
          const oldInRange = inRanges(oldLine, ranges || [], explicit);
          if (anchorInRange || oldInRange) delKeys.add(`${file.path}:${oldLine}:${newLine}`);
          oldLine += 1;
          continue;
        }
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return { added: addKeys.size, deleted: delKeys.size };
}

/**
 * @param {HTMLElement} container
 */
export function renderFlowTree(container) {
  const { flowPayload, uiState } = getState();
  container.innerHTML = '';
  const standaloneClassIds = (flowPayload.standaloneClassIds || []).filter((id) => flowPayload.functionsById[id]);

  if (!flowPayload.flows?.length && standaloneClassIds.length === 0) {
    container.textContent = 'No flows.';
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'flow-tree-wrapper';
  const sourceLinesByFile = Object.fromEntries((flowPayload.files || []).map((f) => [f.path, f.sourceLines || []]));
  const flowFnIdsByFlowId = new Map();
  for (const f of flowPayload.flows || []) {
    const ids = new Set([f.rootId]);
    let added = true;
    while (added) {
      added = false;
      for (const e of flowPayload.edges || []) {
        if (ids.has(e.callerId) && !ids.has(e.calleeId)) {
          ids.add(e.calleeId);
          added = true;
        }
      }
    }
    flowFnIdsByFlowId.set(f.id, ids);
  }

  const totalFlowCount = flowPayload.flows?.length || 0;
  const selectedNodeCount = selectedFlowNodeCount(uiState.selectedFlowId, flowFnIdsByFlowId);
  const compactByFlowCount = totalFlowCount >= FLOW_TREE_COMPACT_FLOW_COUNT_THRESHOLD;
  const compactByNodeCount = selectedNodeCount >= FLOW_TREE_COMPACT_FLOW_NODE_THRESHOLD;
  const useCompactTree = compactByFlowCount || compactByNodeCount;
  if (useCompactTree) wrapper.classList.add('flow-tree-wrapper--compact');

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

    const flowFnIds = new Set(flowFnIdsByFlowId.get(flow.id) || [flow.rootId]);
    const singleClassName = singleClassNameForFlow(flowFnIds, flowPayload);
    if (singleClassName) section.classList.add('flow-tree-flow-section--single-class');
    const singleClassTone = classToneForFlow(flowFnIds, flowPayload, singleClassName);
    const changedClassAnchor = changedClassAnchorMethodForFlow(flowFnIds, flowPayload, singleClassName);
    const labelMode = { compactMethodLabels: Boolean(singleClassName) };
    const flowEdges = (flowPayload.edges || []).filter(
      (e) => flowFnIds.has(e.callerId) && flowFnIds.has(e.calleeId)
    );
    const isClassMembershipRhizome =
      flowEdges.length > 0 && flowEdges.every((e) => e.relationType === 'class');
    const rootHasCallChildren = (flowPayload.edges || []).some(
      (e) => e.callerId === root.id && e.relationType === 'call'
    );
    const hasExpandableFlowTree = flowFnIds.size > 2;
    const showInlineStatsOnRoot = flowFnIds.size === 1 && !singleClassName;
    if (!hasExpandableFlowTree) section.classList.add('flow-tree-flow-section--single-node');
    const diffStats = getRhizomeLineDiffStats(
      flowFnIds,
      flowPayload,
      flow,
      flowFnIdsByFlowId,
      sourceLinesByFile
    );

    const tree = document.createElement('div');
    tree.className = 'flow-tree';
    const pathFromRoot = new Set([root.id]);
    const pathKeysById = new Map([[root.id, rootKey]]);
    renderNode(
      tree,
      flowPayload,
      root,
      false,
      rootKey,
      pathFromRoot,
      pathKeysById,
      flow.id,
      flow.rootId,
      isClassMembershipRhizome,
      0,
      'call',
      labelMode
    );

    const flowSelectKey = `flow:${flow.id}`;
    const rhizomeHeaderActive = uiState.activeTreeNodeKey === flowSelectKey;
    const sectionCollapsed = uiState.flowTreeSectionCollapsedIds?.has(flow.id);
    const useHeaderCaret = Boolean(singleClassName);
    if (!showInlineStatsOnRoot) {
      const header = document.createElement('div');
      header.className =
        'flow-tree-flow-header' + (rhizomeHeaderActive ? ' flow-tree-flow-header--active' : '');
      if (useHeaderCaret) {
        const classHead = document.createElement('div');
        classHead.className = 'flow-tree-flow-class-head';
        const caret = document.createElement('button');
        caret.type = 'button';
        caret.className = 'flow-tree-node-caret flow-tree-flow-section-caret' + (sectionCollapsed ? ' is-collapsed' : '');
        caret.setAttribute('aria-expanded', sectionCollapsed ? 'false' : 'true');
        caret.setAttribute('aria-label', sectionCollapsed ? 'Expand class flow' : 'Collapse class flow');
        caret.textContent = sectionCollapsed ? '›' : '⌄';
        caret.title = sectionCollapsed ? 'Expand flow' : 'Collapse flow';
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleFlowTreeSectionCollapsed(flow.id);
        });
        classHead.appendChild(caret);
        const classTitle = document.createElement('div');
        classTitle.className = 'flow-tree-flow-class-title';
        classTitle.innerHTML = `<span class="flow-tree-class-def-badge flow-tree-class-def-badge-${singleClassTone}" aria-hidden="true"></span>Class ${escapeHtml(singleClassName)}`;
        if (changedClassAnchor) {
          classTitle.classList.add('flow-tree-flow-class-title-clickable');
          classTitle.title = 'Open class change context';
          classTitle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (uiState.selectedFlowId !== flow.id) setSelectedFlow(flow.id, flow.rootId);
            restoreCallSiteReturnTreeNode(rootKey);
            setActiveFunction(changedClassAnchor.methodId, rootKey);
          });
        }
        classHead.appendChild(classTitle);
        header.appendChild(classHead);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'flow-tree-flow-section-caret-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        header.appendChild(spacer);
      }
      const stats = document.createElement('div');
      stats.className = 'flow-tree-flow-diffstats';
      stats.innerHTML = `<span class="flow-tree-flow-diffstats-add">+${diffStats.added}</span><span class="flow-tree-flow-diffstats-del">-${diffStats.deleted}</span>`;
      header.appendChild(stats);
      section.appendChild(header);
    }

    function mountSectionCaretOnRow(rowEl) {
      if (!rowEl) return;
      const caret = document.createElement('button');
      caret.type = 'button';
      caret.className = 'flow-tree-node-caret flow-tree-flow-section-caret' + (sectionCollapsed ? ' is-collapsed' : '');
      caret.setAttribute('aria-expanded', sectionCollapsed ? 'false' : 'true');
      caret.setAttribute('aria-label', sectionCollapsed ? 'Expand class-membership flow' : 'Collapse class-membership flow');
      caret.textContent = sectionCollapsed ? '›' : '⌄';
      caret.title = sectionCollapsed ? 'Expand flow' : 'Collapse flow';
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFlowTreeSectionCollapsed(flow.id);
      });
      rowEl.prepend(caret);
    }

    if (useHeaderCaret) {
      if (!sectionCollapsed) {
        const bodyWrap = document.createElement('div');
        bodyWrap.className = 'flow-tree-flow-body';
        bodyWrap.appendChild(tree);
        section.appendChild(bodyWrap);
      }
    } else if (isClassMembershipRhizome) {
      if (sectionCollapsed) {
        // Keep class-membership rhizomes scannable while collapsed by showing
        // the first method row instead of an empty body.
        const previewWrap = document.createElement('div');
        previewWrap.className = 'flow-tree-flow-body';
        const previewTree = document.createElement('div');
        previewTree.className = 'flow-tree';
        const previewItem = document.createElement('div');
        previewItem.className = 'flow-tree-item flow-tree-item-last';
        previewItem.style.setProperty('--tree-indent', `${flowTreeIndentPx(0)}px`);
        const previewRow = document.createElement('div');
        const previewIsActive = uiState.activeTreeNodeKey === rootKey;
        const previewFunctionMatchActive = uiState.activeFunctionId === root.id && !previewIsActive;
        const previewIsRead = uiState.readFunctionIds?.has?.(root.id);
        previewRow.className =
          'flow-tree-node flow-tree-node-root' +
          (previewIsActive ? ' active' : '') +
          (previewFunctionMatchActive ? ' function-match-active' : '') +
          (previewIsRead ? ' read' : '');
        previewRow.style.paddingLeft = `${flowTreeIndentPx(0)}px`;
        const previewIcon = flowTreeCallMarkerHtml(root, 0, 'class');
        const previewChangeHint = previewIcon ? '' : flowTreeChangeHintHtml(root);
        previewRow.innerHTML = `<span class="flow-tree-icon">${previewIcon}${previewChangeHint}</span><span class="flow-tree-label">${flowTreeLabelHtml(root, flowPayload, labelMode)}</span>`;
        previewRow.dataset.functionId = root.id;
        previewRow.dataset.treeNodeKey = rootKey;
        previewRow.addEventListener('click', (e) => {
          e.stopPropagation();
          if (uiState.selectedFlowId !== flow.id) setSelectedFlow(flow.id, flow.rootId);
          restoreCallSiteReturnTreeNode(rootKey);
          setActiveFunction(root.id, rootKey);
        });
        if (rootHasCallChildren) mountSectionCaretOnRow(previewRow);
        previewItem.appendChild(previewRow);
        previewTree.appendChild(previewItem);
        previewWrap.appendChild(previewTree);
        section.appendChild(previewWrap);
      } else {
        const bodyWrap = document.createElement('div');
        bodyWrap.className = 'flow-tree-flow-body';
        bodyWrap.appendChild(tree);
        section.appendChild(bodyWrap);
        const rootRow = tree.querySelector(`[data-tree-node-key="${CSS.escape(rootKey)}"]`);
        if (rootHasCallChildren) mountSectionCaretOnRow(rootRow);
      }
    } else {
      section.appendChild(tree);
    }
    if (showInlineStatsOnRoot) {
      const rootRow = tree.querySelector(`[data-tree-node-key="${CSS.escape(rootKey)}"]`);
      if (rootRow) {
        const stats = document.createElement('span');
        stats.className = 'flow-tree-node-inline-diffstats';
        stats.innerHTML = `<span class="flow-tree-flow-diffstats-add">+${diffStats.added}</span><span class="flow-tree-flow-diffstats-del">-${diffStats.deleted}</span>`;
        rootRow.appendChild(stats);
      }
    }
    wrapper.appendChild(section);

    if (idx < flowPayload.flows.length - 1) {
      const sep = document.createElement('div');
      sep.className = 'flow-tree-flow-separator';
      wrapper.appendChild(sep);
    }
  }

  if (standaloneClassIds.length > 0) {
    if (flowPayload.flows.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'flow-tree-flow-separator';
      wrapper.appendChild(sep);
    }
    const title = document.createElement('div');
    title.className = 'flow-tree-pane-title';
    title.textContent = 'CLASSES WITHOUT FLOWS';
    wrapper.appendChild(title);
    const section = document.createElement('section');
    section.className = 'flow-tree-flow-section';
    for (const classId of standaloneClassIds) {
      const cls = flowPayload.functionsById[classId];
      if (!cls) continue;
      const row = document.createElement('div');
      const isActive = uiState.selectedStandaloneClassId === classId;
      row.className = `flow-tree-node flow-tree-node-root${isActive ? ' active' : ''}`;
      row.style.paddingLeft = '16px';
      const classChangeHint = flowTreeChangeHintHtml(cls);
      row.innerHTML = `<span class="flow-tree-icon">${classChangeHint}</span><span class="flow-tree-label">${flowTreeLabelHtml(cls, flowPayload)}</span>`;
      row.dataset.functionId = cls.id;
      row.dataset.treeNodeKey = `standalone-class:${cls.id}`;
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        setSelectedStandaloneClass(cls.id);
        restoreCallSiteReturnTreeNode(`standalone-class:${cls.id}`);
      });
      section.appendChild(row);
    }
    wrapper.appendChild(section);
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
  callDepth = 0,
  incomingRelation = 'call',
  labelMode = null
) {
  const { uiState } = getState();
  const expanded = forceExpanded || uiState.flowTreeExpandedIds.has(treeNodeKey);
  const isActive = uiState.activeTreeNodeKey === treeNodeKey;
  const allChildEdges = payload.edges
    .filter((e) => e.callerId === fn.id)
    .sort((a, b) => a.callIndex - b.callIndex);
  const callChildEdges = allChildEdges.filter((e) => e.relationType === 'call');
  const classChildEdges = allChildEdges.filter((e) => e.relationType === 'class');
  // Keep class-membership edges only for class-only nodes. If a node has real call children,
  // render just the call chain to avoid misplacing class siblings under methods.
  // Exception: on flow roots, keep class-membership siblings visible so disconnected methods
  // in a merged class rhizome still appear in the flow.
  const childEdges = callChildEdges.length > 0
    ? (callDepth === 0 ? [...callChildEdges, ...classChildEdges] : callChildEdges)
    : allChildEdges;
  const children = childEdges.map((e) => payload.functionsById[e.calleeId]).filter(Boolean);

  const item = document.createElement('div');
  item.className = 'flow-tree-item' + (isLast ? ' flow-tree-item-last' : '');
  item.style.setProperty('--tree-indent', `${flowTreeIndentPx(callDepth)}px`);

  const isInView = uiState.inViewTreeNodeKey === treeNodeKey;
  const isCallHover = uiState.hoveredTreeNodeKey === treeNodeKey;
  const isRead = uiState.readFunctionIds?.has?.(fn.id);
  const isFunctionMatchActive = uiState.activeFunctionId === fn.id && !isActive;
  const hasChildren = children.length > 0;
  const parentOfActive = parentTreeNodeKey(uiState.activeTreeNodeKey);
  const callerHighlightKey = uiState.callSiteCallerTreeNodeKey ?? parentOfActive;
  const isCallerOfActive = Boolean(callerHighlightKey && callerHighlightKey === treeNodeKey);
  const row = document.createElement('div');
  row.className =
    'flow-tree-node' +
    (isCallerOfActive ? ' flow-tree-node-caller-of-active' : '') +
    (isActive ? ' active' : '') +
    (isFunctionMatchActive ? ' function-match-active' : '') +
    (isInView ? ' in-view' : '') +
    (isCallHover ? ' call-hover-target' : '') +
    (isRead ? ' read' : '');
  const leadingIcon = flowTreeCallMarkerHtml(fn, callDepth, incomingRelation);
  const changeHint = leadingIcon ? '' : flowTreeChangeHintHtml(fn);
  const labelHtml = flowTreeLabelHtml(fn, payload, labelMode);
  row.classList.add(callDepth === 0 ? 'flow-tree-node-root' : 'flow-tree-node-child');
  row.style.paddingLeft = `${flowTreeIndentPx(callDepth)}px`;
  row.innerHTML = `<span class="flow-tree-icon">${leadingIcon}${changeHint}</span><span class="flow-tree-label">${labelHtml}</span>`;
  const hasCallChildren = childEdges.some((e) => e.relationType === 'call');
  const showCaret = !forceExpanded && hasCallChildren;
  const needsCaretSlot = Boolean(labelMode?.compactMethodLabels && callDepth === 0);
  if (showCaret) {
    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'flow-tree-node-caret';
    caret.textContent = expanded ? '⌄' : '›';
    caret.title = expanded ? 'Collapse subtree' : 'Expand subtree';
    caret.setAttribute('aria-label', caret.title);
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExpandedTreeNode(treeNodeKey);
    });
    row.prepend(caret);
  } else if (needsCaretSlot) {
    const spacer = document.createElement('span');
    spacer.className = 'flow-tree-node-caret-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    row.prepend(spacer);
  }
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

  item.appendChild(row);

  if (hasChildren && expanded) {
    const branch = document.createElement('div');
    const classSiblingBranch =
      childEdges.length > 0 && childEdges.every((e) => e.relationType === 'class');
    branch.className = classSiblingBranch
      ? 'flow-tree-branch flow-tree-branch--class-siblings'
      : 'flow-tree-branch';
    const childEntries = childEdges.map((e, idx) => ({ edge: e, child: children[idx] })).filter((x) => x.child);
    if (classSiblingBranch) {
      childEntries.sort((a, b) => {
        const aHasCalls = (payload.edges || []).some(
          (e) => e.callerId === a.child.id && e.relationType === 'call'
        );
        const bHasCalls = (payload.edges || []).some(
          (e) => e.callerId === b.child.id && e.relationType === 'call'
        );
        if (aHasCalls !== bHasCalls) return aHasCalls ? 1 : -1;
        const aStart = Number(a.child.startLine) || Number.POSITIVE_INFINITY;
        const bStart = Number(b.child.startLine) || Number.POSITIVE_INFINITY;
        if (aStart !== bStart) return aStart - bStart;
        return String(a.child.id).localeCompare(String(b.child.id));
      });
    }
    const pathIncludingThis = new Set(pathFromRoot);
    pathIncludingThis.add(fn.id);
    const pathKeysIncludingThis = new Map(pathKeysById);
    pathKeysIncludingThis.set(fn.id, treeNodeKey);
    for (let i = 0; i < childEntries.length; i++) {
      const e = childEntries[i].edge;
      const childKey = `${treeNodeKey}/e:${e.callerId}:${e.callIndex}:${e.calleeId}`;
      const child = childEntries[i].child;
      const rel = e.relationType === 'call' ? 'call' : 'class';
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
        const recIsActive = uiState.activeTreeNodeKey === originalKey;
        const recFunctionMatchActive = uiState.activeFunctionId === child.id && !recIsActive;
        recRow.className =
          'flow-tree-node flow-tree-node-recursive' +
          (recIsActive ? ' active' : '') +
          (recFunctionMatchActive ? ' function-match-active' : '') +
          (recInView ? ' in-view' : '') +
          (recCallHover ? ' call-hover-target' : '') +
          (recIsRead ? ' read' : '');
        recRow.classList.add('flow-tree-node-child');
        const recDepth = callDepth + (rel === 'call' ? 1 : 0);
        recItem.style.setProperty('--tree-indent', `${flowTreeIndentPx(recDepth)}px`);
        recRow.style.paddingLeft = `${flowTreeIndentPx(recDepth)}px`;
        const recIcon = flowTreeCallMarkerHtml(child, recDepth, rel);
        const recChangeHint = recIcon ? '' : flowTreeChangeHintHtml(child);
        recRow.innerHTML = `<span class="flow-tree-icon">${recIcon}${recChangeHint}</span><span class="flow-tree-label">${flowTreeLabelHtml(child, payload, labelMode)}</span>`;
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
          i === childEntries.length - 1,
          childKey,
          pathIncludingThis,
          pathKeysIncludingThis,
          flowId,
          flowRootId,
          forceExpanded,
          callDepth + (rel === 'call' ? 1 : 0),
          rel,
          labelMode
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
 * @param {import('../flowSchema.js').FlowPayload | null} [payload] when set, method rows can show a class-def hint
 */
function flowTreeLabelHtml(fn, payload = null, labelMode = null) {
  const classDefId =
    payload?.classDefAboveMethod && fn.id ? payload.classDefAboveMethod[fn.id] : null;
  const classDefMeta = classDefId ? payload?.functionsById?.[classDefId] : null;
  let classDefTone = 'neutral';
  if (classDefMeta?.changeType === 'added') classDefTone = 'added';
  else if (classDefMeta?.changeType === 'modified') classDefTone = 'modified';
  else if (classDefMeta?.changeType === 'deleted') classDefTone = 'deleted';
  const hasEnclosingClassDef = Boolean(classDefId);
  const classDefBadge = hasEnclosingClassDef
    ? `<span class="flow-tree-class-def-badge flow-tree-class-def-badge-${classDefTone}" title="This method’s class definition is included above the method in the code view" aria-label="Class definition included above in code"></span>`
    : '';
  const deletedPrefix = fn.changeType === 'deleted'
    ? '<span class="flow-tree-deleted-tag" title="Deleted function">Deleted</span>'
    : '';
  if (fn.kind === 'method' && fn.className) {
    const nm = escapeHtml(fn.name);
    if (labelMode?.compactMethodLabels) {
      const title = fn.changeType === 'deleted' ? `Deleted method ${nm}` : `Method ${nm}`;
      return `${deletedPrefix}<span class="flow-tree-method${fn.changeType === 'deleted' ? ' flow-tree-method-deleted' : ''}" title="${title}"><span class="flow-tree-method-name">${nm}</span></span>`;
    }
    const cls = escapeHtml(fn.className);
    const title = fn.changeType === 'deleted' ? `Deleted method of class ${cls}` : `Method of class ${cls}`;
    return `${deletedPrefix}<span class="flow-tree-method${fn.changeType === 'deleted' ? ' flow-tree-method-deleted' : ''}" title="${title}"><span class="flow-tree-class-name">${cls}</span><span class="flow-tree-method-dot">.</span><span class="flow-tree-method-name">${nm}</span></span>`;
  }
  if (fn.kind === 'class') {
    const label = escapeHtml(fn.className || fn.name || getFunctionDisplayName(fn));
    return `${deletedPrefix}<span class="${fn.changeType === 'deleted' ? 'flow-tree-name-deleted' : ''}">class ${label}</span>`;
  }
  const label = escapeHtml(getFunctionDisplayName(fn));
  return `${deletedPrefix}<span class="${fn.changeType === 'deleted' ? 'flow-tree-name-deleted' : ''}">${label}</span>`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Updates `in-view` / `call-hover-target` on existing rows without a full tree rebuild.
 * @param {HTMLElement | null} container
 */
export function patchFlowTreePointerUi(container) {
  if (!container) return;
  const { uiState } = getState();
  const hk = uiState.hoveredTreeNodeKey;
  const iv = uiState.inViewTreeNodeKey;
  for (const row of container.querySelectorAll('.flow-tree-node[data-tree-node-key]')) {
    const key = row.dataset.treeNodeKey;
    if (!key) continue;
    row.classList.toggle('in-view', iv === key);
    row.classList.toggle('call-hover-target', hk === key);
  }
}

/**
 * When the call-depth column is empty (e.g. rhizome root), one dot: green = newly added, brown = modified.
 * @param {import('../flowSchema.js').FunctionMeta} fn
 */
function flowTreeChangeHintHtml(fn) {
  if (fn.changeType === 'added') {
    return '<span class="flow-tree-change-hint flow-tree-change-hint--added" title="Newly added" aria-hidden="true"></span>';
  }
  if (fn.changeType === 'modified') {
    return '<span class="flow-tree-change-hint flow-tree-change-hint--modified" title="Modified" aria-hidden="true"></span>';
  }
  return '';
}

/**
 * @param {import('../flowSchema.js').FunctionMeta} fn
 * @param {number} callDepth
 * @param {'call' | 'class'} incomingRelation
 */
function flowTreeCallMarkerHtml(fn, callDepth, incomingRelation) {
  // Call roots (depth 0) stay unmarked. Class membership edges are not “call depth” — at the same
  // callDepth as a flat group, do not mark (keeps column aligned with the rhizome root).
  if (incomingRelation === 'call' && callDepth <= 0) return '';
  if (incomingRelation === 'class' && callDepth <= 0) return '';
  const tone = fn.changeType === 'added'
    ? 'added'
    : fn.changeType === 'deleted'
      ? 'deleted'
      : 'modified';
  return `<span class="flow-tree-call-marker flow-tree-call-marker-${tone}" aria-hidden="true"></span>`;
}
