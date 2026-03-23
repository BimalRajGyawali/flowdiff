/**
 * Code view pane: shows all functions of the selected flow in flow-tree order.
 * No inline expansion; call-site and flow-tree clicks navigate (scroll to + highlight) the function block.
 */

import { getState, setActiveFunction, setInViewTreeNodeKey, setFunctionReadState, setFunctionCollapsedState } from '../state/store.js';
import { normalizeMergedPatchDiffLines } from '../parser/mergeDiffArtifacts.js';

let lastScrolledToActiveKey = null;
let scrollRAF = null;
let moduleContextExpandedKeys = new Set();
/** Expanded "unchanged lines" collapse toggles; survives scroll-driven re-renders. */
let ctxCollapseExpandedKeys = new Set();
let moduleContextFlowId = null;

function updateInViewFromScroll(container) {
  const blocks = container.querySelectorAll('.function-block[data-tree-node-key]');
  if (blocks.length === 0) {
    setInViewTreeNodeKey(null);
    return;
  }

  // If everything fits in the visible viewport (no vertical scroll),
  // there is no meaningful "you are here" position.
  if (container.scrollHeight <= container.clientHeight + 1) {
    setInViewTreeNodeKey(null);
    return;
  }
  const cRect = container.getBoundingClientRect();
  const centerY = cRect.top + cRect.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    const elCenter = r.top + r.height / 2;
    const dist = Math.abs(elCenter - centerY);
    if (dist < bestDist) {
      bestDist = dist;
      best = el;
    }
  }
  const key = best?.dataset?.treeNodeKey ?? null;
  setInViewTreeNodeKey(key);
}

function isElementInView(container, el) {
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const padding = 40;
  return eRect.top >= cRect.top - padding && eRect.bottom <= cRect.bottom + padding;
}

function scrollToVerticalCenter(container, el) {
  if (!el) return;

  // The code pane (`container`) is the vertical scroll container.
  const scroller = container;

  // Compute element's offsetTop relative to the scroll container,
  // walking up through offsetParents until we reach the container.
  let offsetTop = 0;
  /** @type {HTMLElement | null} */
  let node = /** @type {HTMLElement | null} */ (el);
  while (node && node !== scroller && node.offsetParent) {
    offsetTop += node.offsetTop;
    node = /** @type {HTMLElement | null} */ (node.offsetParent);
  }

  const elCenter = offsetTop + el.offsetHeight / 2;
  const targetTop = Math.max(0, elCenter - scroller.clientHeight / 2);

  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top: targetTop, behavior: 'smooth' });
  } else {
    scroller.scrollTop = targetTop;
  }
}

function getFunctionIdFromTreeNodeKey(treeNodeKey) {
  if (!treeNodeKey) return null;
  const parts = treeNodeKey.split('/');
  const last = parts[parts.length - 1];
  if (last.startsWith('e:')) {
    const p = last.split(':');
    if (p.length >= 4) return p[3];
  }
  if (treeNodeKey.startsWith('root:')) return treeNodeKey.slice(5);
  return null;
}

/**
 * Returns callerId for a tree node key (from last segment e:callerId:callIndex:calleeId), or null for root.
 */
function getCallerFromTreeNodeKey(treeNodeKey) {
  if (!treeNodeKey) return null;
  const parts = treeNodeKey.split('/');
  const last = parts[parts.length - 1];
  if (last.startsWith('e:')) {
    const p = last.split(':');
    if (p.length >= 4) return p[1];
  }
  return null;
}

/**
 * Returns parent tree node key (prefix without last segment), or null for root.
 */
function getParentTreeNodeKey(treeNodeKey) {
  if (!treeNodeKey) return null;
  const idx = treeNodeKey.lastIndexOf('/');
  return idx > 0 ? treeNodeKey.slice(0, idx) : null;
}

/**
 * @param {{ callerId: string, parentTreeNodeKey: string | null, callerName: string }} info
 */
function createCallSiteBackButton(info) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'function-block-caller-link function-block-callsite-back';
  link.textContent = 'Return to call site';
  link.title = `Go to ${info.callerName}()`;
  link.addEventListener('click', (e) => {
    e.stopPropagation();
    setActiveFunction(info.callerId, info.parentTreeNodeKey);
  });
  return link;
}

/**
 * When this function was opened via a call-site click, show a back control in a header if possible;
 * otherwise a slim bar at the top of the block body.
 * @param {HTMLElement} container - function-block-content
 * @param {{ callerId: string, parentTreeNodeKey: string | null, callerName: string } | null} callSiteReturn
 */
function mountCallSiteReturnBarIfNeeded(container, callSiteReturn) {
  if (!callSiteReturn || container.querySelector('.function-block-callsite-back')) return;
  const bar = document.createElement('div');
  bar.className = 'function-block-callsite-bar';
  bar.appendChild(createCallSiteBackButton(callSiteReturn));
  container.insertBefore(bar, container.firstChild);
}

// Breadcrumb support was removed based on UI feedback.

// Focus dimming has been disabled based on UI feedback.

function makePlaceholder(index) {
  return `__flowdiff_ph_${index}__`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightPython(code) {
  if (typeof window.Prism === 'undefined') return escapeHtml(code);
  return window.Prism.highlight(code, window.Prism.languages.python, 'python');
}

function getCommonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function getCommonSuffixLength(a, b, prefixLen = 0) {
  const max = Math.min(a.length, b.length) - prefixLen;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function computeIntralineRange(oldText, newText) {
  const prefix = getCommonPrefixLength(oldText, newText);
  const suffix = getCommonSuffixLength(oldText, newText, prefix);
  const oldEnd = Math.max(prefix, oldText.length - suffix);
  const newEnd = Math.max(prefix, newText.length - suffix);
  return {
    old: { start: prefix, end: oldEnd },
    new: { start: prefix, end: newEnd }
  };
}

function applyIntralineHighlight(text, range, cls) {
  if (!range || range.end <= range.start) return escapeHtml(text);
  const a = escapeHtml(text.slice(0, range.start));
  const b = escapeHtml(text.slice(range.start, range.end));
  const c = escapeHtml(text.slice(range.end));
  return `${a}<span class="${cls}">${b}</span>${c}`;
}

/** True when diff pairing produced a non-empty replace span (vs whole-line add/del). */
function hasMeaningfulIntraline(range) {
  return !!(range && range.end > range.start);
}

/** Minimum consecutive unchanged (`ctx`) lines before collapsing the middle (GitHub-style). */
const CTX_COLLAPSE_MIN_RUN = 10;
/** Lines of context kept visible above / below a collapsed block. */
const CTX_COLLAPSE_HEAD_LINES = 3;
const CTX_COLLAPSE_TAIL_LINES = 3;

/**
 * Split long runs of context rows: show head/tail, collapse the middle behind a toggle.
 * @param {any[]} rows
 * @returns {any[]}
 */
function expandContextCollapseRows(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type !== 'ctx') {
      out.push(row);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].type === 'ctx') j++;
    const run = rows.slice(i, j);
    if (run.length < CTX_COLLAPSE_MIN_RUN) {
      out.push(...run);
    } else {
      const h = CTX_COLLAPSE_HEAD_LINES;
      const t = CTX_COLLAPSE_TAIL_LINES;
      if (run.length <= h + t) {
        out.push(...run);
      } else {
        const head = run.slice(0, h);
        const tail = run.slice(-t);
        const hidden = run.slice(h, run.length - t);
        out.push(...head);
        out.push({
          type: 'ctx-collapse',
          hiddenRows: hidden,
          lineCount: hidden.length,
          startLine: hidden[0]?.newLineNumber ?? hidden[0]?.oldLineNumber,
          endLine: hidden[hidden.length - 1]?.newLineNumber ?? hidden[hidden.length - 1]?.oldLineNumber
        });
        out.push(...tail);
      }
    }
    i = j;
  }
  return out;
}

function ctxCollapseHoverText(n, startLine, endLine, expanded) {
  const range =
    startLine != null && endLine != null ? ` (lines ${startLine}–${endLine})` : '';
  const noun = n === 1 ? 'line' : 'lines';
  return expanded
    ? `Hide ${n} unchanged ${noun}${range}`
    : `Show ${n} unchanged ${noun}${range}`;
}

function ctxCollapseAriaLabel(n, startLine, endLine, expanded) {
  const range =
    startLine != null && endLine != null ? ` Lines ${startLine} to ${endLine}.` : '';
  const noun = n === 1 ? 'line' : 'lines';
  return expanded
    ? `Collapse ${n} unchanged ${noun}.${range}`
    : `Expand ${n} unchanged ${noun}.${range}`;
}

/**
 * Minimal visible label; full wording only in title / aria (easier to read past).
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} body
 * @param {{ lineCount: number, startLine?: number, endLine?: number }} rowData
 * @param {string | null} persistenceKey - if null, toggle is not remembered across re-renders
 */
function setupCtxCollapseToggle(btn, body, rowData, persistenceKey) {
  const n = rowData.lineCount;
  const { startLine, endLine } = rowData;

  function applyView(expanded) {
    body.hidden = !expanded;
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.textContent = expanded ? '▲' : `⋯ ${n}`;
    btn.title = ctxCollapseHoverText(n, startLine, endLine, expanded);
    btn.setAttribute('aria-label', ctxCollapseAriaLabel(n, startLine, endLine, expanded));
  }

  const expanded = !!(persistenceKey && ctxCollapseExpandedKeys.has(persistenceKey));
  applyView(expanded);

  btn.addEventListener('click', () => {
    const isOpen = btn.getAttribute('aria-expanded') === 'true';
    const next = !isOpen;
    applyView(next);
    if (persistenceKey) {
      if (next) ctxCollapseExpandedKeys.add(persistenceKey);
      else ctxCollapseExpandedKeys.delete(persistenceKey);
    }
  });
}

/**
 * Assigns call-site indices in source order so collapsed context does not steal indices from later lines.
 * Mutates rows with `_sites` (empty for `del`).
 * @param {any[]} rows
 * @param {{ calleeId: string, callIndex: number }[]} calleesWithIndex
 * @param {{ calleeId: string, name: string }[]} calleesForFind
 */
function attachCallSitesToRows(rows, calleesWithIndex, calleesForFind) {
  const remainingByCallee = new Map();
  for (const { calleeId, callIndex } of calleesWithIndex) {
    if (!remainingByCallee.has(calleeId)) remainingByCallee.set(calleeId, []);
    remainingByCallee.get(calleeId).push(callIndex);
  }
  for (const rowData of rows) {
    if (rowData.type === 'del') {
      rowData._sites = [];
      continue;
    }
    const line = rowData.content;
    const sites = findCallSitesInLine(line, calleesForFind);
    for (const site of sites) {
      const indices = remainingByCallee.get(site.calleeId);
      if (indices?.length) site.callIndex = indices.shift();
    }
    rowData._sites = sites;
  }
}

function buildDiffLines(hunks) {
  let diffLines = [];

  for (const hunk of hunks || []) {
    let oldLineNumber = hunk.oldStart;
    let newLineNumber = hunk.newStart;

    for (const rawLine of hunk.lines || []) {
      if (rawLine.startsWith('+')) {
        diffLines.push({
          type: 'add',
          oldLineNumber: null,
          newLineNumber,
          anchorNewLineNumber: newLineNumber,
          content: rawLine.slice(1)
        });
        newLineNumber += 1;
        continue;
      }

      if (rawLine.startsWith('-')) {
        diffLines.push({
          type: 'del',
          oldLineNumber,
          newLineNumber: null,
          anchorNewLineNumber: newLineNumber,
          content: rawLine.slice(1)
        });
        oldLineNumber += 1;
        continue;
      }

      diffLines.push({
        type: 'ctx',
        oldLineNumber,
        newLineNumber,
        anchorNewLineNumber: newLineNumber,
        content: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
      });
      oldLineNumber += 1;
      newLineNumber += 1;
    }
  }

  diffLines = normalizeMergedPatchDiffLines(diffLines);

  // GitHub-style intraline highlighting for "replace" blocks (runs of - then +).
  // We only attempt a simple prefix/suffix based range per paired line.
  let i = 0;
  while (i < diffLines.length) {
    if (diffLines[i].type !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < diffLines.length && diffLines[i].type === 'del') i++;
    const delEnd = i;
    const addStart = i;
    while (i < diffLines.length && diffLines[i].type === 'add') i++;
    const addEnd = i;
    if (addStart === addEnd) continue;

    const pairCount = Math.min(delEnd - delStart, addEnd - addStart);
    for (let k = 0; k < pairCount; k++) {
      const delRow = diffLines[delStart + k];
      const addRow = diffLines[addStart + k];
      const r = computeIntralineRange(delRow.content || '', addRow.content || '');
      delRow.intraline = r.old;
      addRow.intraline = r.new;
    }
  }

  return diffLines;
}

function buildFunctionDisplayRows(fn, sourceLines, diffLines) {
  const relevantDiffLines = diffLines.filter((row) => {
    if (row.type === 'del') {
      const anchor = row.anchorNewLineNumber ?? (fn.endLine + 1);
      return anchor >= fn.startLine && anchor <= fn.endLine + 1;
    }
    return row.newLineNumber != null && row.newLineNumber >= fn.startLine && row.newLineNumber <= fn.endLine;
  });

  const changeBlocksByAnchor = new Map();
  let currentBlock = [];

  function flushBlock() {
    if (currentBlock.length === 0) return;
    const anchors = currentBlock
      .map((row) => (row.type === 'del' ? row.anchorNewLineNumber : row.newLineNumber))
      .filter((value) => value != null);
    const anchor = anchors.length > 0 ? Math.min(...anchors) : fn.endLine + 1;
    const blocks = changeBlocksByAnchor.get(anchor) || [];
    blocks.push({
      deleted: currentBlock.filter((row) => row.type === 'del'),
      added: currentBlock.filter((row) => row.type === 'add')
    });
    changeBlocksByAnchor.set(anchor, blocks);
    currentBlock = [];
  }

  for (const row of relevantDiffLines) {
    if (row.type === 'ctx') {
      flushBlock();
      continue;
    }
    currentBlock.push(row);
  }
  flushBlock();

  const addedLineNumbers = new Set(
    [...changeBlocksByAnchor.values()]
      .flat()
      .flatMap((block) => block.added)
      .map((row) => row.newLineNumber)
      .filter((value) => value != null)
  );

  const rows = [];
  for (let lineNumber = fn.startLine; lineNumber <= fn.endLine; lineNumber++) {
    const blocks = changeBlocksByAnchor.get(lineNumber) || [];
    for (const block of blocks) {
      rows.push(...block.deleted);
      rows.push(...block.added);
    }

    if (addedLineNumbers.has(lineNumber)) {
      continue;
    }

    rows.push({
      type: 'ctx',
      oldLineNumber: '',
      newLineNumber: lineNumber,
      content: sourceLines[lineNumber - 1] ?? ''
    });
  }

  const trailingBlocks = changeBlocksByAnchor.get(fn.endLine + 1) || [];
  for (const block of trailingBlocks) {
    rows.push(...block.deleted);
    rows.push(...block.added);
  }

  return rows;
}

function buildRangeDisplayRows(ranges, sourceLines, diffLines, excludedLineNumbers = new Set()) {
  if (!ranges?.length) return [];
  const inRange = (n) => ranges.some((r) => n >= r.start && n <= r.end);

  const relevantDiffLines = diffLines.filter((row) => {
    if (row.type === 'del') {
      const anchor = row.anchorNewLineNumber ?? 0;
      return inRange(anchor) && !excludedLineNumbers.has(anchor);
    }
    return row.newLineNumber != null && inRange(row.newLineNumber) && !excludedLineNumbers.has(row.newLineNumber);
  });

  const rows = [];
  for (const r of ranges) {
    // Only del/add from the patch; context comes from sourceLines below. Including raw `ctx`
    // rows here duplicated every unchanged line (ctx row + synthetic ctx for the same number).
    for (const row of relevantDiffLines) {
      if (row.type === 'ctx') continue;
      const anchor = row.type === 'del' ? (row.anchorNewLineNumber ?? 0) : (row.newLineNumber ?? 0);
      if (anchor >= r.start && anchor <= r.end) rows.push(row);
    }
    // Add context lines for the current source in the range (skip ones already added as '+' lines).
    const addedNums = new Set(rows.filter((x) => x.type === 'add').map((x) => x.newLineNumber).filter((n) => n != null));
    for (let ln = r.start; ln <= r.end; ln++) {
      if (excludedLineNumbers.has(ln)) continue;
      if (addedNums.has(ln)) continue;
      rows.push({ type: 'ctx', oldLineNumber: '', newLineNumber: ln, content: sourceLines[ln - 1] ?? '' });
    }
  }

  // Sort by anchor/new line to keep stable ordering.
  const key = (row) => (row.type === 'del' ? (row.anchorNewLineNumber ?? 0) : (row.newLineNumber ?? 0));
  return rows.sort((a, b) => key(a) - key(b));
}

/**
 * One diff row for module-context / plain views (no call-site links).
 * @param {HTMLElement} container
 */
function appendPlainDiffRow(container, rowData) {
  const line = rowData.content;
  const lineHtml =
    rowData.type === 'add'
      ? hasMeaningfulIntraline(rowData.intraline)
        ? applyIntralineHighlight(line, rowData.intraline, 'intraline intraline-add')
        : highlightPython(line)
      : rowData.type === 'del'
        ? hasMeaningfulIntraline(rowData.intraline)
          ? applyIntralineHighlight(line, rowData.intraline, 'intraline intraline-del')
          : highlightPython(line)
        : highlightPython(line);

  const oldNumHtml = rowData.oldLineNumber != null && rowData.oldLineNumber !== '' ? String(rowData.oldLineNumber) : '';
  const newNumHtml = rowData.newLineNumber != null ? String(rowData.newLineNumber) : '';

  const row = document.createElement('div');
  row.className = `diff-line diff-line-${rowData.type}`;
  row.innerHTML = `
    <span class="diff-num diff-num-${rowData.type}">${oldNumHtml}</span>
    <span class="diff-num diff-num-${rowData.type}">${newNumHtml}</span>
    <span class="diff-sign diff-sign-${rowData.type}">${rowData.type === 'add' ? '+' : rowData.type === 'del' ? '-' : ''}</span>
    <pre class="diff-code diff-code-${rowData.type}"><code class="language-python">${lineHtml}</code></pre>
  `;
  container.appendChild(row);
}

/**
 * @param {string | null} [collapseScopeKey] - prefix for persisting expand state (e.g. module-context scope)
 */
function renderDiffRows(container, filePath, rows, prContext, collapseScopeKey = null) {
  const toRender = expandContextCollapseRows(rows);
  for (const rowData of toRender) {
    if (rowData.type === 'ctx-collapse') {
      const wrap = document.createElement('div');
      wrap.className = 'diff-ctx-collapse';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'diff-ctx-collapse-btn';
      const body = document.createElement('div');
      body.className = 'diff-ctx-collapse-body';
      for (const hr of rowData.hiddenRows) {
        appendPlainDiffRow(body, hr);
      }
      const persistenceKey =
        collapseScopeKey != null && collapseScopeKey !== ''
          ? `${collapseScopeKey}::ctx::${rowData.startLine}-${rowData.endLine}-${rowData.lineCount}`
          : null;
      setupCtxCollapseToggle(btn, body, rowData, persistenceKey);
      wrap.appendChild(btn);
      wrap.appendChild(body);
      container.appendChild(wrap);
      continue;
    }
    appendPlainDiffRow(container, rowData);
  }
}

/**
 * Collects all function IDs in the flow (root + all descendants via edges).
 */
function getFlowFunctionIds(flow, payload) {
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
  return ids;
}

/**
 * Returns functions in flow order (DFS from root, first occurrence). One entry per function ID.
 * @param {string} rootId
 * @param {import('../flowSchema.js').FlowPayload} payload
 * @returns {{ treeNodeKey: string, functionId: string }[]}
 */
function collectFlowOrder(rootId, payload) {
  const rootKey = `root:${rootId}`;
  const list = [];
  const visited = new Set();

  function visit(fnId, treeNodeKey, pathFromRoot) {
    if (visited.has(fnId)) return;
    visited.add(fnId);
    const pathIncludingThis = new Set(pathFromRoot);
    pathIncludingThis.add(fnId);
    list.push({ treeNodeKey, functionId: fnId });

    const childEdges = payload.edges
      .filter((e) => e.callerId === fnId)
      .sort((a, b) => a.callIndex - b.callIndex);
    for (const e of childEdges) {
      if (pathIncludingThis.has(e.calleeId)) continue;
      const childKey = `${treeNodeKey}/e:${e.callerId}:${e.callIndex}:${e.calleeId}`;
      visit(e.calleeId, childKey, pathIncludingThis);
    }
  }

  visit(rootId, rootKey, new Set());
  return list;
}

/**
 * Finds the end index of a call starting at openParen (exclusive).
 */
function findCallEnd(text, openParen) {
  let depth = 1;
  for (let i = openParen + 1; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    if (depth === 0) return i + 1;
  }
  return text.length;
}

/**
 * Returns the set of function IDs on the path from root to the current node (pathPrefix).
 * Used to detect recursion: if a callee is in this set (already above), we treat it as
 * recursive — not just immediate self-call (A→A), but any cycle (e.g. A→C→A).
 */
function getPathFunctionIds(pathPrefix) {
  const parts = pathPrefix.split('/');
  const ids = new Set();
  if (parts[0].startsWith('root:')) ids.add(parts[0].slice(5));
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (seg.startsWith('e:')) {
      const p = seg.split(':');
      if (p.length >= 4) ids.add(p[3]);
    }
  }
  return ids;
}

/**
 * Finds call sites in a line for the given callees.
 * @returns {{ start: number, end: number, calleeId: string }[]}
 */
function findCallSitesInLine(line, callees) {
  const sites = [];
  for (const { calleeId, name } of callees) {
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(line)) !== null) {
      const start = m.index;
      const openParen = line.indexOf('(', start);
      const end = findCallEnd(line, openParen);
      sites.push({ start, end, calleeId });
    }
  }
  return sites.sort((a, b) => a.start - b.start);
}

/**
 * Renders one diff row in a function body (syntax highlight + optional call-site links).
 * @param {HTMLElement} container
 */
function appendFunctionBodyDiffLine(
  container,
  rowData,
  indent,
  pathPrefix,
  fn,
  payload,
  uiState,
  pathFunctionIds,
  calleesForFind
) {
  const line = rowData.content;
  const sites =
    rowData.type === 'del'
      ? []
      : (rowData._sites ?? findCallSitesInLine(line, calleesForFind));

  let lineHtml;
  const placeholders = [];

  // Call-site links on added lines too (previously only context lines used the placeholder path).
  if (rowData.type !== 'del' && sites.length > 0) {
    let lineWithPlaceholders = '';
    let lastEnd = 0;
    for (let si = 0; si < sites.length; si++) {
      const site = sites[si];
      lineWithPlaceholders += (lastEnd === 0 ? indent : '') + line.slice(lastEnd, site.start);
      const ph = makePlaceholder(si);
      lineWithPlaceholders += ph;
      const treeNodeKey = site.callIndex !== undefined ? `${pathPrefix}/e:${fn.id}:${site.callIndex}:${site.calleeId}` : '';
      placeholders.push({ ...site, placeholder: ph, treeNodeKey });
      lastEnd = site.end;
    }
    lineWithPlaceholders += line.slice(lastEnd);
    lineHtml = highlightPython(lineWithPlaceholders);

    for (let pi = 0; pi < placeholders.length; pi++) {
      const { placeholder, calleeId, start, end, treeNodeKey } = placeholders[pi];
      const callText = line.slice(start, end);
      const isRecursive = pathFunctionIds.has(calleeId);
      const dataKey = treeNodeKey && !isRecursive ? ` data-tree-node-key="${escapeHtml(treeNodeKey)}"` : '';
      const recClass = isRecursive ? ' call-site-recursive' : '';
      const title = isRecursive ? 'Recursive call — already shown in the path above' : 'Click to expand';
      const fnName = payload.functionsById[calleeId]?.name || calleeId;
      const recContent = isRecursive
        ? `<span class="call-site-recursive-icon" aria-hidden="true">↻</span> ${escapeHtml(fnName)} <span class="call-site-recursive-hint">(recursive already above)</span>`
        : escapeHtml(callText);
      const callSpanHtml = `<span class="call-site${recClass}" data-callee-id="${escapeHtml(calleeId)}" data-recursive="${isRecursive}"${dataKey} title="${escapeHtml(title)}">${recContent}</span>`;
      lineHtml = lineHtml.replace(new RegExp(escapeRegex(placeholder), 'g'), callSpanHtml);
    }
  } else if (rowData.type === 'add') {
    lineHtml = hasMeaningfulIntraline(rowData.intraline)
      ? applyIntralineHighlight(indent + line, rowData.intraline, 'intraline intraline-add')
      : highlightPython(indent + line);
  } else if (rowData.type === 'del') {
    lineHtml = hasMeaningfulIntraline(rowData.intraline)
      ? applyIntralineHighlight(indent + line, rowData.intraline, 'intraline intraline-del')
      : highlightPython(indent + line);
  } else {
    lineHtml = highlightPython(indent + line);
  }

  const oldNumHtml = rowData.oldLineNumber != null && rowData.oldLineNumber !== '' ? String(rowData.oldLineNumber) : '';
  const newNumHtml = rowData.newLineNumber != null ? String(rowData.newLineNumber) : '';
  const row = document.createElement('div');
  row.className = `diff-line diff-line-${rowData.type}`;
  row.innerHTML = `
    <span class="diff-num diff-num-${rowData.type}">${oldNumHtml}</span>
    <span class="diff-num diff-num-${rowData.type}">${newNumHtml}</span>
    <span class="diff-sign diff-sign-${rowData.type}">${rowData.type === 'add' ? '+' : rowData.type === 'del' ? '-' : ''}</span>
    <pre class="diff-code diff-code-${rowData.type}"><code class="language-python">${lineHtml}</code></pre>
  `;

  row.querySelectorAll('.call-site').forEach((el) => {
    const calleeId = el.dataset.calleeId;
    const treeNodeKey = el.dataset.treeNodeKey;
    const isRecursive = el.dataset.recursive === 'true';
    const callee = payload.functionsById[calleeId];
    const isActive =
      uiState.activeFunctionId === calleeId || (treeNodeKey && uiState.activeTreeNodeKey === treeNodeKey);
    if (isRecursive) {
      el.title = `Go to ${callee?.name || calleeId} (recursive, already above)`;
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setActiveFunction(calleeId, null);
      });
      return;
    }
    if (isActive) el.classList.add('active');
    el.title = `Go to ${callee?.name || calleeId}`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveFunction(calleeId, treeNodeKey);
    });
  });

  container.appendChild(row);
}

/**
 * Module-scope changed line ranges strictly before `startLine` (1-based def line).
 * @param {{ start: number, end: number }[]} ranges
 * @param {number} startLine
 */
function moduleRangesBeforeFunction(ranges, startLine) {
  const out = [];
  for (const r of ranges) {
    if (r.end < startLine) out.push({ start: r.start, end: r.end });
    else if (r.start < startLine) out.push({ start: r.start, end: startLine - 1 });
  }
  return out.filter((x) => x.start <= x.end);
}

/**
 * Module-scope ranges strictly after `endLine` (1-based last line of function body).
 */
function moduleRangesAfterFunction(ranges, endLine) {
  const out = [];
  for (const r of ranges) {
    if (r.start > endLine) out.push({ start: r.start, end: r.end });
    else if (r.end > endLine) out.push({ start: endLine + 1, end: r.end });
  }
  return out.filter((x) => x.start <= x.end);
}

function moduleSymbolsInRanges(symbols, sourceLines, ranges) {
  if (!symbols?.length || !ranges?.length) return [];
  const hit = new Set();
  for (const r of ranges) {
    for (let ln = r.start; ln <= r.end; ln++) {
      const text = sourceLines[ln - 1] ?? '';
      if (/^\s+/.test(text)) continue;
      const m = text.match(/^\s*([A-Za-z_]\w*)\s*=/);
      if (m && symbols.includes(m[1])) hit.add(m[1]);
    }
  }
  return [...hit].sort();
}

/**
 * @param {'start' | 'end'} where - insert at start of container or append at end
 * @param {{ callerId: string, parentTreeNodeKey: string | null, callerName: string } | null} [callSiteReturn]
 */
function mountModuleContextSection(
  container,
  where,
  fileMeta,
  ranges,
  fn,
  sourceLinesByFile,
  diffLinesByFile,
  pathPrefix,
  prContext,
  slot,
  buttonLabel,
  titleText,
  callSiteReturn
) {
  if (!ranges?.length) return;
  const expandedKey = `${pathPrefix}::${fn.file}::module-${slot}::${fn.id}`;
  const ctxId = `module-ctx-${slot}-${String(fn.id).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 96)}`;
  const baseName = fn.file.replace(/^.*\//, '');
  const sourceLines = sourceLinesByFile[fn.file] || [];
  const syms = moduleSymbolsInRanges(fileMeta.moduleChangedSymbols || [], sourceLines, ranges);
  const symText = syms.slice(0, 8).join(', ');
  const more = syms.length > 8 ? ` (+${syms.length - 8} more)` : '';

  const ctx = document.createElement('div');
  ctx.className = `module-context module-context--${slot}`;
  ctx.dataset.moduleContextSection = `${fn.file}::${fn.id}::${slot}`;
  ctx.innerHTML = `
    <div class="module-context-header">
      <button type="button" class="module-context-toggle" aria-expanded="false" aria-controls="${escapeHtml(ctxId)}" title="${escapeHtml(titleText)}">${escapeHtml(buttonLabel)}</button>
      <span class="module-context-file">${escapeHtml(baseName)}</span>
      ${symText ? `<span class="module-context-syms" title="${escapeHtml(syms.join(', '))}">${escapeHtml(symText)}${escapeHtml(more)}</span>` : ''}
    </div>
    <div class="module-context-body" id="${escapeHtml(ctxId)}" hidden></div>
  `;
  const body = ctx.querySelector('.module-context-body');
  const toggle = ctx.querySelector('.module-context-toggle');
  const headerRow = ctx.querySelector('.module-context-header');
  // Only the top "before" panel gets the link; "after" sits below the body so a second link would be easy to miss.
  if (callSiteReturn && headerRow && slot === 'before') {
    headerRow.appendChild(createCallSiteBackButton(callSiteReturn));
  }

  const ensureModuleContextBodyPopulated = () => {
    if (!body) return;
    if (body.childElementCount > 0) return;
    const rows = buildRangeDisplayRows(
      ranges,
      sourceLines,
      diffLinesByFile[fn.file] || [],
      new Set(fileMeta.moduleExcludedLineNumbers || [])
    );
    const lines = document.createElement('div');
    lines.className = 'module-context-lines';
    renderDiffRows(lines, fn.file, rows, prContext, expandedKey);
    body.appendChild(lines);
  };

  const isInitiallyExpanded = moduleContextExpandedKeys.has(expandedKey);
  toggle?.setAttribute('aria-expanded', isInitiallyExpanded ? 'true' : 'false');
  if (body) body.hidden = !isInitiallyExpanded;
  if (isInitiallyExpanded) ensureModuleContextBodyPopulated();

  toggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    const next = !expanded;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (body) body.hidden = !next;
    if (next) ensureModuleContextBodyPopulated();
    if (next) moduleContextExpandedKeys.add(expandedKey);
    else moduleContextExpandedKeys.delete(expandedKey);
  });

  if (where === 'start') container.insertBefore(ctx, container.firstChild);
  else container.appendChild(ctx);
}

/**
 * Renders a function body with clickable call sites and inline expansion.
 * @param {string} pathPrefix - path-based tree key for this block (root:rootId or parentPath/e:caller:idx:callee)
 * @param {Record<string, string[]>} sourceLinesByFile - file path -> full current source lines
 * @param {Record<string, { type: string, oldLineNumber: number | null, newLineNumber: number | null, content: string }[]>} diffLinesByFile
 * @param {Set<string>} filesWithModuleContext - file paths that have module-scope changes
 * @param {Map<string, { moduleChangedRanges?: { start: number, end: number }[], moduleChangedSymbols?: string[] }>} moduleMetaByFile
 * @param {{ callerId: string, parentTreeNodeKey: string | null, callerName: string } | null} [callSiteReturn]
 */
function renderFunctionBody(
  container,
  payload,
  uiState,
  fn,
  sourceLinesByFile,
  diffLinesByFile,
  filesWithModuleContext,
  moduleMetaByFile,
  calleesByCaller,
  indent,
  pathPrefix,
  prContext,
  callSiteReturn
) {
  const fileBlock = container.closest('[data-file]') || container;

  const fileMeta = moduleMetaByFile.get(fn.file);
  const rangesBefore =
    filesWithModuleContext.has(fn.file) && fileMeta?.moduleChangedRanges?.length
      ? moduleRangesBeforeFunction(fileMeta.moduleChangedRanges, fn.startLine)
      : [];
  const rangesAfter =
    filesWithModuleContext.has(fn.file) && fileMeta?.moduleChangedRanges?.length
      ? moduleRangesAfterFunction(fileMeta.moduleChangedRanges, fn.endLine)
      : [];

  // Show file name when this file has no module panels in this block (panels include the file name).
  const hasModulePanelHere = rangesBefore.length > 0 || rangesAfter.length > 0;
  const hasFileHeader = fileBlock.querySelector?.('.file-name-header, [data-module-context-section]');
  if (!hasFileHeader && !hasModulePanelHere && !filesWithModuleContext.has(fn.file) && fileBlock.dataset?.file === fn.file) {
    const fileHeader = document.createElement('div');
    fileHeader.className = 'file-name-header';
    const baseName = fn.file.replace(/^.*\//, '');
    const label = document.createElement('span');
    label.className = 'file-name-header-label';
    label.textContent = baseName;
    fileHeader.appendChild(label);
    if (callSiteReturn) {
      fileHeader.appendChild(createCallSiteBackButton(callSiteReturn));
    }
    fileBlock.prepend(fileHeader);
  }

  if (rangesBefore.length && fileMeta) {
    mountModuleContextSection(
      container,
      'start',
      fileMeta,
      rangesBefore,
      fn,
      sourceLinesByFile,
      diffLinesByFile,
      pathPrefix,
      prContext,
      'before',
      'Module changes',
      'Edits outside any function from the start of the file up to this function',
      callSiteReturn
    );
  }

  const pathFunctionIds = getPathFunctionIds(pathPrefix);
  const sourceLines = sourceLinesByFile[fn.file] || [];

  // If we don't have any source or diff lines for this file/function (e.g. it wasn't in the git diff),
  // still show at least a best-effort function definition line so the block is never empty.
  if (!sourceLines.length && !(diffLinesByFile[fn.file] || []).length) {
    const body = document.createElement('div');
    body.className = 'function-body';
    const sigSource = fn.snippet || `def ${fn.name}(`;
    const sigHtml = highlightPython(sigSource);
    body.innerHTML = `<pre class="code-line"><code class="language-python">${sigHtml}</code></pre>`;
    container.appendChild(body);
    if (rangesAfter.length && fileMeta) {
      mountModuleContextSection(
        container,
        'end',
        fileMeta,
        rangesAfter,
        fn,
        sourceLinesByFile,
        diffLinesByFile,
        pathPrefix,
        prContext,
        'after',
        'Module changes',
        'Edits outside any function from after this function through the end of the file',
        callSiteReturn
      );
    }
    mountCallSiteReturnBarIfNeeded(container, callSiteReturn);
    return;
  }

  const fnDiffLines = buildFunctionDisplayRows(fn, sourceLines, diffLinesByFile[fn.file] || []);
  const calleesWithIndex = (calleesByCaller.get(fn.id) || []).sort((a, b) => a.callIndex - b.callIndex);
  const calleesForFind = [...new Map(calleesWithIndex.map((e) => [e.calleeId, { calleeId: e.calleeId, name: payload.functionsById[e.calleeId]?.name }])).values()].filter((x) => x.name);
  attachCallSitesToRows(fnDiffLines, calleesWithIndex, calleesForFind);
  const rowsToRender = expandContextCollapseRows(fnDiffLines);

  for (const rowData of rowsToRender) {
    if (rowData.type === 'ctx-collapse') {
      const wrap = document.createElement('div');
      wrap.className = 'diff-ctx-collapse';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'diff-ctx-collapse-btn';
      const body = document.createElement('div');
      body.className = 'diff-ctx-collapse-body';
      for (const hr of rowData.hiddenRows) {
        appendFunctionBodyDiffLine(
          body,
          hr,
          indent,
          pathPrefix,
          fn,
          payload,
          uiState,
          pathFunctionIds,
          calleesForFind
        );
      }
      const persistenceKey = `${pathPrefix}::${fn.id}::ctx::${rowData.startLine}-${rowData.endLine}-${rowData.lineCount}`;
      setupCtxCollapseToggle(btn, body, rowData, persistenceKey);
      wrap.appendChild(btn);
      wrap.appendChild(body);
      container.appendChild(wrap);
      continue;
    }
    appendFunctionBodyDiffLine(
      container,
      rowData,
      indent,
      pathPrefix,
      fn,
      payload,
      uiState,
      pathFunctionIds,
      calleesForFind
    );
  }

  if (rangesAfter.length && fileMeta) {
    mountModuleContextSection(
      container,
      'end',
      fileMeta,
      rangesAfter,
      fn,
      sourceLinesByFile,
      diffLinesByFile,
      pathPrefix,
      prContext,
      'after',
      'Module changes',
      'Edits outside any function from after this function through the end of the file',
      callSiteReturn
    );
  }

  mountCallSiteReturnBarIfNeeded(container, callSiteReturn);
}

export function renderCodeView(container) {
  const { flowPayload, uiState, prContext } = getState();
  container.innerHTML = '';

  if (!flowPayload.files?.length) {
    container.textContent = 'Enter a PR URL and click Go.';
    return;
  }

  const selectedFlow = flowPayload.flows?.find((f) => f.id === uiState.selectedFlowId);
  const flowFnIds = selectedFlow ? getFlowFunctionIds(selectedFlow, flowPayload) : new Set();
  if (selectedFlow?.id !== moduleContextFlowId) {
    moduleContextFlowId = selectedFlow?.id ?? null;
    moduleContextExpandedKeys = new Set();
    ctxCollapseExpandedKeys = new Set();
  }

  if (flowFnIds.size === 0) {
    container.textContent = 'Select a flow.';
    return;
  }

  const calleesByCaller = new Map();
  for (const e of flowPayload.edges) {
    if (!flowFnIds.has(e.callerId) || !flowFnIds.has(e.calleeId)) continue;
    const list = calleesByCaller.get(e.callerId) || [];
    list.push({ calleeId: e.calleeId, callIndex: e.callIndex });
    calleesByCaller.set(e.callerId, list);
  }

  const sourceLinesByFile = {};
  const diffLinesByFile = {};
  const filesWithModuleContext = new Set();
  const moduleMetaByFile = new Map();
  for (const file of flowPayload.files) {
    sourceLinesByFile[file.path] = file.sourceLines || [];
    diffLinesByFile[file.path] = buildDiffLines(file.hunks || []);
    if (file.moduleChangedRanges?.length) filesWithModuleContext.add(file.path);
    moduleMetaByFile.set(file.path, {
      moduleChangedRanges: file.moduleChangedRanges,
      moduleChangedSymbols: file.moduleChangedSymbols,
      moduleExcludedLineNumbers: file.moduleExcludedLineNumbers
    });
  }

  const root = flowPayload.functionsById[selectedFlow.rootId];
  if (!root) return;

  const flowOrder = collectFlowOrder(selectedFlow.rootId, flowPayload);
  const fileSection = document.createElement('div');
  fileSection.className = 'file-section';

  for (const { treeNodeKey, functionId } of flowOrder) {
    const fn = flowPayload.functionsById[functionId];
    if (!fn) continue;
    const block = document.createElement('div');
    block.className = 'function-block' + (functionId === root.id ? ' root' : '');
    block.dataset.functionId = functionId;
    block.dataset.treeNodeKey = treeNodeKey;
    block.dataset.file = fn.file;
    if (fn.changeType) block.dataset.changeType = fn.changeType;
    const isActive =
      uiState.activeFunctionId === functionId ||
      uiState.activeTreeNodeKey === treeNodeKey;
    const isRead = uiState.readFunctionIds?.has?.(functionId);
    const isCollapsed = uiState.collapsedFunctionIds?.has?.(functionId);
    if (isActive) block.classList.add('active');
    if (isRead) block.classList.add('read');
    if (isCollapsed) block.classList.add('collapsed');

    // Collapsible content wrapper (function body and caller info).
    const content = document.createElement('div');
    content.className = 'function-block-content' + (isCollapsed ? ' collapsed' : '');
    block.appendChild(content);

    // Title shown only when collapsed, as a one-line function "signature" with syntax highlighting.
    const titleRow = document.createElement('div');
    titleRow.className = 'function-block-title';
    const sigSource = fn.snippet || `def ${fn.name}(`;
    const sigHtml = highlightPython(sigSource);
    // Use the highlighted HTML directly (Prism returns span-based markup, no box).
    titleRow.innerHTML = sigHtml;
    block.appendChild(titleRow);

    // Prefer the currently active path-key when it points at this function
    // (e.g. arrived via call-site click from a specific caller occurrence).
    // Fall back to this block's canonical flow-order key.
    const activePathForThisFn =
      uiState.activeTreeNodeKey &&
      getFunctionIdFromTreeNodeKey(uiState.activeTreeNodeKey) === functionId
        ? uiState.activeTreeNodeKey
        : null;
    const callSiteSourceKey = activePathForThisFn || treeNodeKey;

    const callerId = getCallerFromTreeNodeKey(callSiteSourceKey);
    const callSiteReturn =
      callerId != null
        ? {
            callerId,
            parentTreeNodeKey: getParentTreeNodeKey(callSiteSourceKey),
            callerName: flowPayload.functionsById[callerId]?.name || callerId
          }
        : null;

    renderFunctionBody(
      content,
      flowPayload,
      uiState,
      fn,
      sourceLinesByFile,
      diffLinesByFile,
      filesWithModuleContext,
      moduleMetaByFile,
      calleesByCaller,
      '',
      treeNodeKey,
      prContext,
      callSiteReturn
    );

    // Attach checkbox-style "done/read" control into the existing header inside this block:
    // prefer module-context header if present, otherwise file-name header.
    const headerEl =
      block.querySelector('.module-context-header') ||
      block.querySelector('.file-name-header');
    if (headerEl) {
      const controls = document.createElement('div');
      controls.className = 'function-block-header-controls';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'function-block-toggle-btn';
      const updateToggleLabel = () => {
        const nowCollapsed = uiState.collapsedFunctionIds?.has?.(functionId);
        toggleBtn.textContent = nowCollapsed ? '+' : '–';
        toggleBtn.title = nowCollapsed ? 'Expand function body' : 'Collapse function body';
        toggleBtn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      };
      updateToggleLabel();
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFunctionCollapsedState(functionId);
      });

      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.className = 'function-block-done-btn';
      doneBtn.textContent = '✓';
      const updateDoneLabel = () => {
        const nowRead = uiState.readFunctionIds?.has?.(functionId);
        if (nowRead) {
          doneBtn.classList.add('checked');
          doneBtn.title = 'Marked as done (click to mark as not done)';
          doneBtn.setAttribute('aria-pressed', 'true');
        } else {
          doneBtn.classList.remove('checked');
          doneBtn.title = 'Mark this function as done/read';
          doneBtn.setAttribute('aria-pressed', 'false');
        }
      };
      updateDoneLabel();
      doneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFunctionReadState(functionId);
      });

      controls.appendChild(toggleBtn);
      controls.appendChild(doneBtn);
      headerEl.appendChild(controls);
    }
    fileSection.appendChild(block);
  }
  container.appendChild(fileSection);

  // Determine the current active code block, preferring the specific tree-node path
  // when available so different occurrences of the same function scroll independently.
  const activeTreeNodeKey = uiState.activeTreeNodeKey || null;
  const activeFunctionId =
    getFunctionIdFromTreeNodeKey(activeTreeNodeKey) || uiState.activeFunctionId;

  // Build a stable key that distinguishes different occurrences of the same function.
  const activeScrollKey = activeTreeNodeKey || (activeFunctionId ? `fn:${activeFunctionId}` : null);

  // Only auto-center when the active target changes, so manual scrolling isn't
  // constantly overridden on every store update (e.g., when updating "you are here").
  if (activeScrollKey && activeScrollKey !== lastScrolledToActiveKey) {
    let el = null;
    if (activeTreeNodeKey) {
      el = container.querySelector(
        `.function-block[data-tree-node-key="${CSS.escape(activeTreeNodeKey)}"]`
      );
    }
    if (!el && activeFunctionId) {
      el = container.querySelector(
        `.function-block[data-function-id="${CSS.escape(activeFunctionId)}"]`
      );
    }
    if (el) {
      lastScrolledToActiveKey = activeScrollKey;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToVerticalCenter(container, el));
      });
    }
  }
  if (!activeScrollKey) lastScrolledToActiveKey = null;

  // Explicitly mark the "you are here" function block in the code view,
  // based on the function ID derived from the tree's inViewTreeNodeKey.
  const inViewFnId =
    getFunctionIdFromTreeNodeKey(uiState.inViewTreeNodeKey) || null;
  if (inViewFnId) {
    const inViewBlock = container.querySelector(
      `.function-block[data-function-id="${CSS.escape(inViewFnId)}"]`
    );
    if (inViewBlock) inViewBlock.classList.add('in-view');
  }

  if (!container.dataset.scrollLinked) {
    container.dataset.scrollLinked = '1';
    container.addEventListener('scroll', () => {
      if (scrollRAF) return;
      scrollRAF = requestAnimationFrame(() => {
        scrollRAF = null;
        updateInViewFromScroll(container);
      });
    });
  }
  updateInViewFromScroll(container);
}
