/**
 * Code view pane: one selected rhizome (flow) at a time — functions in DFS order, single scroll.
 * Left rail lists those functions; the middle rhizome tree stays in sync via scroll + selection.
 */

import {
  getState,
  setActiveFunction,
  setActiveFunctionFromInlineCallSite,
  returnFromCallSiteToCaller,
  restoreCallSiteReturnTreeNode,
  clearCallSiteReturnScrollTarget,
  setInViewTreeNodeKey,
  setSelectedFileInFlow,
  setCodePaneOutsideDiffPath,
  setFunctionReadState,
  setFunctionCollapsedState,
  setHoveredTreeNodeKey
} from '../state/store.js';
import { normalizeMergedPatchDiffLines } from '../parser/mergeDiffArtifacts.js';
import { getFunctionDisplayName } from '../parser/functionDisplayName.js';

let lastScrolledToActiveKey = null;
let scrollRAF = null;
/** Expanded "unchanged lines" collapse toggles; survives scroll-driven re-renders. */
let ctxCollapseExpandedKeys = new Set();
let filesNavWidthPx = 260;
const FILES_NAV_WIDTH_MIN = 190;
const FILES_NAV_WIDTH_MAX = 520;
let filesNavFolderOpenState = new Map();
let filesNavFolderStateInitialized = false;
let collapsedFilePaths = new Set();
let filesNavCollapsed = false;
let savedFilesNavWidthPx = filesNavWidthPx;
let suppressAutoScrollUntil = 0;
const AUTO_SCROLL_SUPPRESS_MS = 450;
let preferSmoothScrollForNextActiveSelection = false;
let codePaneScrollTop = 0;
let codePaneScrollLeft = 0;
/** When PR head or selected rhizome changes, reset scroll + scroll-to-active bookkeeping. */
let lastRhizomeCodeViewKey = '';

/**
 * Return-to-call-site highlight must survive `innerHTML` rebuilds (scroll / in-view updates re-render).
 * @type {null | { callerTreeNodeKey: string, scrollLine: number, lineKind: string, calleeId: string, calleeOrdinalOnLine: number, expireAt: number }}
 */
let callSiteReturnHighlightSpec = null;
let callSiteReturnHighlightTimer = 0;
/** Progressive reveal state for file ranges omitted from diff hunks (GitHub-style expand). */
let ctxGapRevealByKey = new Map();

function clearCtxGapRevealStateByPrefix(prefix) {
  if (!prefix) return false;
  let changed = false;
  for (const key of [...ctxGapRevealByKey.keys()]) {
    if (!key.startsWith(prefix)) continue;
    ctxGapRevealByKey.delete(key);
    changed = true;
  }
  return changed;
}

function hasCtxGapRevealStateByPrefix(prefix) {
  if (!prefix) return false;
  for (const key of ctxGapRevealByKey.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function clearCallSiteReturnHighlightTimer() {
  if (callSiteReturnHighlightTimer) {
    window.clearTimeout(callSiteReturnHighlightTimer);
    callSiteReturnHighlightTimer = 0;
  }
}

function clearPersistentCallSiteReturnHighlight() {
  clearCallSiteReturnHighlightTimer();
  callSiteReturnHighlightSpec = null;
  if (typeof document !== 'undefined') {
    document.getElementById('code-pane')?.querySelectorAll?.('.call-site-return-highlight')?.forEach((n) => {
      n.classList.remove('call-site-return-highlight');
    });
  }
}

function scheduleCallSiteReturnHighlightExpiry(scrollContainer) {
  clearCallSiteReturnHighlightTimer();
  callSiteReturnHighlightTimer = window.setTimeout(() => {
    callSiteReturnHighlightTimer = 0;
    callSiteReturnHighlightSpec = null;
    const pane =
      scrollContainer ||
      (typeof document !== 'undefined' ? document.getElementById('code-pane') : null);
    pane?.querySelectorAll?.('.call-site-return-highlight')?.forEach((n) => {
      n.classList.remove('call-site-return-highlight');
    });
  }, 4500);
}

function findDiffRowForReturnScroll(block, t) {
  if (t.lineKind === 'new') {
    const r = block.querySelector(`.diff-line[data-flowdiff-new-line="${t.scrollLine}"]`);
    if (r) return r;
  } else if (t.lineKind === 'anchor') {
    const r = block.querySelector(`.diff-line[data-flowdiff-anchor-new="${t.scrollLine}"]`);
    if (r) return r;
  } else {
    const r = block.querySelector(`.diff-line[data-flowdiff-old-line="${t.scrollLine}"]`);
    if (r) return r;
  }
  return (
    block.querySelector(`.diff-line[data-flowdiff-new-line="${t.scrollLine}"]`) ||
    block.querySelector(`.diff-line[data-flowdiff-anchor-new="${t.scrollLine}"]`) ||
    block.querySelector(`.diff-line[data-flowdiff-old-line="${t.scrollLine}"]`)
  );
}

function findCallSiteReturnElementInBlock(block, t) {
  const row = findDiffRowForReturnScroll(block, t);
  if (!row) return null;
  let el = row.querySelector(
    `.call-site[data-callee-id="${CSS.escape(t.calleeId)}"][data-fd-callee-ord="${t.calleeOrdinalOnLine}"]`
  );
  if (!el) {
    const matches = row.querySelectorAll(`.call-site[data-callee-id="${CSS.escape(t.calleeId)}"]`);
    el = matches[t.calleeOrdinalOnLine] || matches[0];
  }
  return el || null;
}

function reapplyCallSiteReturnHighlight(container) {
  const spec = callSiteReturnHighlightSpec;
  if (!spec) return;
  if (Date.now() > spec.expireAt) {
    clearPersistentCallSiteReturnHighlight();
    return;
  }
  const { uiState } = getState();
  if (uiState.activeTreeNodeKey !== spec.callerTreeNodeKey) return;
  const block = container.querySelector(
    `.function-block[data-tree-node-key="${CSS.escape(spec.callerTreeNodeKey)}"]`
  );
  if (!block) return;
  const el = findCallSiteReturnElementInBlock(block, spec);
  if (el) el.classList.add('call-site-return-highlight');
}

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

  // When several rhizome cards are visible in one file (e.g. class membership methods), do not
  // let “closest to center” pick the wrong one — prefer the selected function if its block is on screen.
  const { uiState } = getState();
  const activeKey = uiState.activeTreeNodeKey;
  if (activeKey) {
    const activeBlock = container.querySelector(
      `.function-block[data-tree-node-key="${CSS.escape(activeKey)}"]`
    );
    if (activeBlock && blockIntersectsScrollport(container, activeBlock)) {
      setInViewTreeNodeKey(activeKey);
      return;
    }
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

/** True if any part of `el` is visible in `container`’s scrollport (for matching tree “in view” to the selected card). */
function blockIntersectsScrollport(container, el) {
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  return eRect.bottom > cRect.top + 0.5 && eRect.top < cRect.bottom - 0.5;
}

/**
 * @param {{ newLineNumber?: number | null, anchorNewLineNumber?: number | null, oldLineNumber?: number | string | null }} rowData
 * @returns {{ lineKind: 'new' | 'anchor' | 'old', scrollLine: number } | null}
 */
function diffLineScrollMeta(rowData) {
  if (rowData.newLineNumber != null) return { lineKind: 'new', scrollLine: rowData.newLineNumber };
  if (rowData.anchorNewLineNumber != null) return { lineKind: 'anchor', scrollLine: rowData.anchorNewLineNumber };
  if (rowData.oldLineNumber != null && rowData.oldLineNumber !== '')
    return { lineKind: 'old', scrollLine: Number(rowData.oldLineNumber) };
  return null;
}

function navigateFromInlineCallSite(calleeId, calleeNavKey, callerPathPrefix, rowData, calleeOrdinalOnLine) {
  clearPersistentCallSiteReturnHighlight();
  // Inline call-site clicks should always re-center the callee card, even when clicking
  // the same callee repeatedly (e.g. A -> B, C, B).
  lastScrolledToActiveKey = null;
  preferSmoothScrollForNextActiveSelection = true;
  let resolvedNavKey = calleeNavKey;
  if (!resolvedNavKey && typeof document !== 'undefined') {
    const card = document.querySelector(
      `#code-pane .function-block[data-function-id="${CSS.escape(String(calleeId || ''))}"]`
    );
    resolvedNavKey = card?.dataset?.treeNodeKey || null;
  }
  if (resolvedNavKey) restoreCallSiteReturnTreeNode(resolvedNavKey);
  const meta = diffLineScrollMeta(rowData);
  const returnScroll =
    meta && callerPathPrefix ? { ...meta, calleeId, calleeOrdinalOnLine } : null;
  setActiveFunctionFromInlineCallSite(calleeId, resolvedNavKey || null, callerPathPrefix, returnScroll);
}

/**
 * @param {HTMLElement} container - code pane scroll container
 * @param {{ callerTreeNodeKey: string, scrollLine: number, lineKind: 'new' | 'anchor' | 'old', calleeId: string, calleeOrdinalOnLine: number }} t
 */
function applyCallSiteReturnScroll(container, t) {
  const block = container.querySelector(
    `.function-block[data-tree-node-key="${CSS.escape(t.callerTreeNodeKey)}"]`
  );
  if (!block) return false;
  const el = findCallSiteReturnElementInBlock(block, t);
  if (!el) return false;
  callSiteReturnHighlightSpec = {
    callerTreeNodeKey: t.callerTreeNodeKey,
    scrollLine: t.scrollLine,
    lineKind: t.lineKind,
    calleeId: t.calleeId,
    calleeOrdinalOnLine: t.calleeOrdinalOnLine,
    expireAt: Date.now() + 4500
  };
  el.classList.add('call-site-return-highlight');
  scheduleCallSiteReturnHighlightExpiry(container);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth', inline: 'nearest' });
    });
  });
  return true;
}

/**
 * @param {{ behavior?: 'auto' | 'smooth' }} [opts] - use `auto` when scrolling to a selected function so the first in-view sync sees the target in the scrollport
 */
function scrollToVerticalCenter(container, el, opts = {}) {
  if (!el) return;

  // The code pane (`container`) is the vertical scroll container.
  const scroller = container;
  const behavior = opts.behavior === 'smooth' ? 'smooth' : 'auto';

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
    scroller.scrollTo({ top: targetTop, behavior });
  } else {
    scroller.scrollTop = targetTop;
  }
}

function elementOffsetTopInScroller(scroller, el) {
  let offsetTop = 0;
  /** @type {HTMLElement | null} */
  let node = /** @type {HTMLElement | null} */ (el);
  while (node && node !== scroller && node.offsetParent) {
    offsetTop += node.offsetTop;
    node = /** @type {HTMLElement | null} */ (node.offsetParent);
  }
  return offsetTop;
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
 * @param {{ callerId: string, parentTreeNodeKey: string | null, callerName: string, calleeTreeNodeKey: string }} info
 */
function createCallSiteBackButton(info) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'function-block-caller-link function-block-callsite-back';
  link.textContent = 'Return to call site';
  link.title = `Go to ${info.callerName}()`;
  link.addEventListener('click', (e) => {
    e.stopPropagation();
    returnFromCallSiteToCaller(info.calleeTreeNodeKey, info.callerId, info.parentTreeNodeKey);
  });
  return link;
}

/**
 * When this function was opened via a call-site click, show a back control in a header if possible;
 * otherwise a slim bar at the top of the block body.
 * @param {HTMLElement} container - function-block-content
 * @param {{ callerId: string, parentTreeNodeKey: string | null, callerName: string, calleeTreeNodeKey: string } | null} callSiteReturn
 */
function mountCallSiteReturnBarIfNeeded(container, callSiteReturn) {
  if (!callSiteReturn) return;
  // File header prepends the back control on `.function-block`, not inside content; search the whole card.
  const block = container.closest('.function-block');
  if (block?.querySelector('.function-block-callsite-back')) return;
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

  // Ensure decorators are consistently highlighted in the code pane.
  const decMatch = code.match(/^(\s*)@([A-Za-z_][\w.]*)(.*)$/);
  if (decMatch) {
    const [, indent, decName, tail] = decMatch;
    const tailHtml = window.Prism.highlight(tail, window.Prism.languages.python, 'python');
    return (
      escapeHtml(indent) +
      '<span class="token decorator-at">@</span>' +
      `<span class="token decorator-name">${escapeHtml(decName)}</span>` +
      tailHtml
    );
  }

  return window.Prism.highlight(code, window.Prism.languages.python, 'python');
}

function getPythonSignatureName(line) {
  if (!line) return null;
  const m = String(line).match(/^\s*(?:async\s+def|def)\s+([A-Za-z_]\w*)\s*\(|^\s*class\s+([A-Za-z_]\w*)\s*(?:\(|:)/);
  if (!m) return null;
  return m[1] || m[2] || null;
}

function isPythonCommentLine(line) {
  return /^\s*#/.test(String(line ?? ''));
}

function countToken(text, token) {
  let count = 0;
  let idx = 0;
  while (idx < text.length) {
    const hit = text.indexOf(token, idx);
    if (hit === -1) break;
    count += 1;
    idx = hit + token.length;
  }
  return count;
}

function markDocstringLineOnRow(rowData, state) {
  if (!rowData || rowData.type === 'ctx-gap') return;
  if (rowData.type === 'ctx-collapse') {
    for (const hr of rowData.hiddenRows || []) markDocstringLineOnRow(hr, state);
    return;
  }
  const line = String(rowData.content ?? '');
  let isDocstringLine = !!state.inDocstring;
  if (!state.inDocstring) {
    const start = line.match(/^\s*(?:[rRuUbBfF]{0,2})?("""|''')/);
    if (start) {
      const quote = start[1];
      isDocstringLine = true;
      const occurrences = countToken(line, quote);
      if (occurrences % 2 === 1) {
        state.inDocstring = true;
        state.quote = quote;
      } else {
        state.inDocstring = false;
        state.quote = null;
      }
    }
  } else {
    const quote = state.quote || (line.includes('"""') ? '"""' : (line.includes("'''") ? "'''" : null));
    if (quote) {
      const occurrences = countToken(line, quote);
      if (occurrences % 2 === 1) {
        state.inDocstring = false;
        state.quote = null;
      }
    }
  }
  rowData._isDocstringLine = isDocstringLine;
}

function markDocstringLines(rows) {
  const state = { inDocstring: false, quote: null };
  for (const rowData of rows || []) markDocstringLineOnRow(rowData, state);
}

function emphasizeSignatureNameInHtml(line, lineHtml) {
  const fnName = getPythonSignatureName(line);
  if (!fnName) return lineHtml;
  const escaped = escapeHtml(fnName);
  const tokenWrapped = `<span class="token function">${escaped}</span>`;
  if (lineHtml.includes(tokenWrapped)) {
    return lineHtml.replace(
      tokenWrapped,
      `<span class="token function flowdiff-signature-name">${escaped}</span>`
    );
  }
  return lineHtml.replace(
    new RegExp(`\\b${escapeRegex(escaped)}\\b`),
    `<span class="flowdiff-signature-name">${escaped}</span>`
  );
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
const CTX_GAP_INITIAL_EDGE_LINES = 3;
const CTX_GAP_REVEAL_CHUNK_LINES = 20;
const CTX_GAP_EXPANDER_HEIGHT_PX = 34;
const CTX_GAP_EXPANDER_HEIGHT_MINIMAL_PX = 26;

function clampToInt(n, min, max) {
  const v = Number.isFinite(Number(n)) ? Number(n) : min;
  return Math.max(min, Math.min(max, v));
}

function rowDisplayAnchorLine(row) {
  if (!row) return null;
  if (row.type === 'del') {
    const anchor = row.anchorNewLineNumber ?? row.newLineNumber;
    return anchor != null && Number.isFinite(Number(anchor)) ? Number(anchor) : null;
  }
  const n = row.newLineNumber ?? row.anchorNewLineNumber;
  return n != null && Number.isFinite(Number(n)) ? Number(n) : null;
}

/** True if new-file line 1 appears in `toRender[0..idx-1]` (patch rows only; skips gap rows). */
function newFileLineOneShownBeforeRowIndex(toRender, idx) {
  for (let i = 0; i < idx; i++) {
    const rd = toRender[i];
    if (!rd || rd.type === 'ctx-gap' || rd.type === 'ctx-collapse') continue;
    if (rd.type === 'ctx' || rd.type === 'add') {
      if (Number(rd.newLineNumber) === 1) return true;
    }
    if (rd.type === 'del') {
      const a = Number(rd.anchorNewLineNumber);
      const nw = rd.newLineNumber != null ? Number(rd.newLineNumber) : null;
      if (a === 1 || nw === 1) return true;
    }
  }
  return false;
}

/**
 * Stable sort by new-file anchor so `injectProgressiveContextGaps` sees monotonic line numbers.
 * Merged hunks or other reordering can otherwise place a row with anchor > 1 before line-1
 * `+`/`-` rows, inserting a bogus leading `ctx-gap` (and stacked expanders) above line 1.
 * @param {any[]} rows
 * @returns {any[]}
 */
function sortDiffRowsByNewFileAnchor(rows) {
  if (!Array.isArray(rows) || rows.length <= 1) return rows;
  const indexed = rows.map((row, i) => ({ row, i }));
  indexed.sort((a, b) => {
    const la = rowDisplayAnchorLine(a.row);
    const lb = rowDisplayAnchorLine(b.row);
    const na = la != null && Number.isFinite(la) ? la : Infinity;
    const nb = lb != null && Number.isFinite(lb) ? lb : Infinity;
    if (na !== nb) return na - nb;
    return a.i - b.i;
  });
  return indexed.map((x) => x.row);
}

function buildCtxRowFromSourceLine(sourceLines, lineNumber) {
  return {
    type: 'ctx',
    oldLineNumber: '',
    newLineNumber: lineNumber,
    anchorNewLineNumber: lineNumber,
    content: sourceLines[lineNumber - 1] ?? ''
  };
}

function setGapIcon(button, direction) {
  const up = direction === 'up';
  button.innerHTML = up
    ? `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 2.5 3.5 7h9L8 2.5Z"/><rect x="7.25" y="7" width="1.5" height="6.5" rx=".75" fill="currentColor"/></svg>`
    : `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><rect x="7.25" y="2.5" width="1.5" height="6.5" rx=".75" fill="currentColor"/><path fill="currentColor" d="m8 13.5 4.5-4.5h-9L8 13.5Z"/></svg>`;
}

function setGapCaretIcon(button, direction) {
  const up = direction === 'up';
  button.innerHTML = up
    ? `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 3.5 3.5 8h9L8 3.5Z"/></svg>`
    : `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="m8 12.5 4.5-4.5h-9L8 12.5Z"/></svg>`;
}

/**
 * Inserts `ctx-gap` rows for source lines omitted from patch hunks so the user can reveal them progressively.
 * @param {any[]} rows
 * @param {string[]} sourceLines
 * @param {{ startLine?: number, endLine?: number, implicitContextBeforeFirstAnchor?: boolean }} [opts]
 *   When `implicitContextBeforeFirstAnchor` is true, callers removed patch `ctx` rows but unchanged
 *   lines still exist in the file — seed `prevLine` to `min(anchor)-1` so a bogus leading gap is not
 *   inserted before the first `+`/`-` (e.g. expander between lines 8 and 9 instead of below line 9).
 * @returns {any[]}
 */
function injectProgressiveContextGaps(rows, sourceLines, opts = {}) {
  if (!Array.isArray(rows) || !Array.isArray(sourceLines) || sourceLines.length === 0) return rows;
  const startLine = clampToInt(opts.startLine ?? 1, 1, sourceLines.length);
  const endLine = clampToInt(opts.endLine ?? sourceLines.length, startLine, sourceLines.length);
  if (startLine > endLine) return rows;

  const out = [];
  let prevLine = startLine - 1;
  if (opts.implicitContextBeforeFirstAnchor === true && Array.isArray(rows) && rows.length > 0) {
    const inBand = rows
      .map(rowDisplayAnchorLine)
      .filter((n) => n != null && Number.isFinite(n) && n >= startLine && n <= endLine);
    if (inBand.length) {
      prevLine = Math.max(prevLine, Math.min(...inBand) - 1);
    }
  }
  for (const row of rows) {
    const line = rowDisplayAnchorLine(row);
    if (line != null && line >= startLine && line <= endLine && line > prevLine + 1) {
      out.push({
        type: 'ctx-gap',
        startLine: prevLine + 1,
        endLine: line - 1,
        position:
          prevLine + 1 <= startLine
            ? 'start'
            : line - 1 >= endLine
              ? 'end'
              : 'middle'
      });
    }
    out.push(row);
    if (line != null && line >= startLine && line <= endLine) {
      prevLine = Math.max(prevLine, line);
    }
  }
  if (prevLine < endLine) {
    out.push({
      type: 'ctx-gap',
      startLine: prevLine + 1,
      endLine,
      position: prevLine + 1 <= startLine ? 'start' : 'end'
    });
  }
  return out;
}

/**
 * Split long runs of context rows: show head/tail, collapse the middle behind a toggle.
 * @param {any[]} rows
 * @returns {any[]}
 */
function expandContextCollapseRows(rows, preserveNewLines = null) {
  const preserved = preserveNewLines instanceof Set ? preserveNewLines : null;

  function flushContextRun(run, outRows) {
    if (run.length < CTX_COLLAPSE_MIN_RUN) {
      outRows.push(...run);
      return;
    }
    const h = CTX_COLLAPSE_HEAD_LINES;
    const t = CTX_COLLAPSE_TAIL_LINES;
    if (run.length <= h + t) {
      outRows.push(...run);
      return;
    }
    const head = run.slice(0, h);
    const tail = run.slice(-t);
    const hidden = run.slice(h, run.length - t);
    outRows.push(...head);
    outRows.push({
      type: 'ctx-collapse',
      hiddenRows: hidden,
      lineCount: hidden.length,
      startLine: hidden[0]?.newLineNumber ?? hidden[0]?.oldLineNumber,
      endLine: hidden[hidden.length - 1]?.newLineNumber ?? hidden[hidden.length - 1]?.oldLineNumber
    });
    outRows.push(...tail);
  }

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
    if (!preserved || preserved.size === 0) {
      flushContextRun(run, out);
    } else {
      let segment = [];
      for (const ctxRow of run) {
        const n = ctxRow?.newLineNumber != null ? Number(ctxRow.newLineNumber) : null;
        const keepVisible = n != null && preserved.has(n);
        if (keepVisible) {
          if (segment.length) {
            flushContextRun(segment, out);
            segment = [];
          }
          out.push(ctxRow);
          continue;
        }
        segment.push(ctxRow);
      }
      if (segment.length) {
        flushContextRun(segment, out);
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
 * Names to scan for in each line: only direct edge callees for this caller.
 * This keeps call-site links precise so clicking a call always navigates to
 * the intended card instead of a same-name function elsewhere in the flow.
 * @param {{ calleeId: string, callIndex: number }[]} calleesWithIndex
 * @param {Record<string, import('../flowSchema.js').FunctionMeta>} functionsById
 */
function buildCalleesForFind(calleesWithIndex, functionsById) {
  const map = new Map();
  for (const { calleeId } of calleesWithIndex) {
    const meta = functionsById[calleeId];
    if (meta?.name) map.set(calleeId, { calleeId, name: meta.name });
  }
  return [...map.values()];
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

  // Rows keep absolute file line numbers from the walk above. Do not renumber after this:
  // normalize may drop duplicate ctx rows; survivors still have correct gutters.
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

/**
 * @param {{ type: string }[]} diffLines
 * @returns {{ added: number, deleted: number }}
 */
function diffLineAddDelCounts(diffLines) {
  let added = 0;
  let deleted = 0;
  for (const row of diffLines || []) {
    if (row.type === 'add') added += 1;
    else if (row.type === 'del') deleted += 1;
  }
  return { added, deleted };
}

function buildFunctionDisplayRows(fn, sourceLines, diffLines) {
  const relevantDiffLines = diffLines.filter((row) => {
    if (row.type === 'del') {
      // Consecutive `-` lines share one anchor (new-file insert position). That anchor can sit
      // *before* this function while oldLineNumber still walks through lines inside the body.
      const anchor = row.anchorNewLineNumber ?? (fn.endLine + 1);
      const inByAnchor = anchor >= fn.startLine && anchor <= fn.endLine + 1;
      const oldLn = row.oldLineNumber;
      const inByOld =
        oldLn != null && oldLn !== '' && oldLn >= fn.startLine && oldLn <= fn.endLine;
      return inByAnchor || inByOld;
    }
    return row.newLineNumber != null && row.newLineNumber >= fn.startLine && row.newLineNumber <= fn.endLine;
  });

  // If we only have partial source for this file (e.g. fallback from patch-visible lines),
  // avoid synthesizing blank context rows for out-of-range lines. Show raw diff rows instead.
  if (sourceLines.length < fn.endLine) {
    return relevantDiffLines;
  }

  // When a function is effectively "all deleted" in this range, render the patch
  // rows directly instead of synthesizing from final source lines. This preserves
  // visible '-' rows for fully removed bodies.
  const hasDeleted = relevantDiffLines.some((row) => row.type === 'del');
  const hasAdded = relevantDiffLines.some((row) => row.type === 'add');
  if (hasDeleted && !hasAdded) {
    return relevantDiffLines;
  }

  /** @param {number | null | undefined} n */
  const n1 = (n) => (n == null || Number.isNaN(Number(n)) ? null : Number(n));

  // Bucket patch rows by new-file line number. Anchor-keyed runs used min(anchor) for a whole
  // -/+ group, so lines 2..N of a multi-line replace were still emitted as synthetic HEAD + patch.
  /** @type {Map<number, typeof relevantDiffLines>} */
  const patchRowsByNewLine = new Map();
  for (const row of relevantDiffLines) {
    if (row.type === 'ctx') continue;
    let key = row.type === 'del' ? n1(row.anchorNewLineNumber) : n1(row.newLineNumber);
    if (key == null) continue;
    if (row.type === 'del') {
      const a = n1(row.anchorNewLineNumber);
      const o = n1(row.oldLineNumber);
      if (a != null && o != null) {
        const anchorOutside = a < fn.startLine || a > fn.endLine + 1;
        const oldInside = o >= fn.startLine && o <= fn.endLine;
        if (anchorOutside && oldInside) {
          // Shared anchor can sit just outside the function span while oldLine walks the body.
          key = a < fn.startLine ? fn.startLine : fn.endLine + 1;
        }
      }
    }
    const list = patchRowsByNewLine.get(key) ?? [];
    list.push(row);
    patchRowsByNewLine.set(key, list);
  }

  const rows = [];
  for (let lineNumber = fn.startLine; lineNumber <= fn.endLine + 1; lineNumber++) {
    const patchRows = patchRowsByNewLine.get(lineNumber);
    if (patchRows?.length) {
      rows.push(...patchRows);
      continue;
    }
    if (lineNumber <= fn.endLine) {
      rows.push({
        type: 'ctx',
        oldLineNumber: '',
        newLineNumber: lineNumber,
        content: sourceLines[lineNumber - 1] ?? ''
      });
    }
  }

  return stripSyntheticCtxDuplicateOfFollowingPatch(rows);
}

/** Trailing whitespace ignored — patch `+` often matches HEAD after a replace. */
function normalizeDiffLineText(s) {
  return (s ?? '').replace(/\s+$/, '');
}

/**
 * Drops a synthesized context row when it duplicates the next patch `+` (same text as HEAD).
 * Skips any `-` rows in between so we handle both `ctx,-,+` and insert-only `ctx,+` (e.g. new
 * `@deprecated` line added above `def` with no `-` on that same line).
 * @param {any[]} rows
 */
function stripSyntheticCtxDuplicateOfFollowingPatch(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row?.type === 'ctx' && row.oldLineNumber === '') {
      let k = i + 1;
      while (k < rows.length && rows[k]?.type === 'del') k++;
      if (
        rows[k]?.type === 'add' &&
        normalizeDiffLineText(row.content) === normalizeDiffLineText(rows[k].content)
      ) {
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

/**
 * Merge overlapping / touching line ranges so each line is covered once (e.g. module ranges).
 * @param {{ start: number, end: number }[]} ranges
 * @returns {{ start: number, end: number }[]}
 */
function mergeLineRanges(ranges) {
  const sorted = [...(ranges || [])]
    .map((r) => ({ start: Number(r.start), end: Number(r.end) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!sorted.length) return [];
  const out = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n.start <= cur.end) {
      cur.end = Math.max(cur.end, n.end);
    } else {
      out.push(cur);
      cur = { ...n };
    }
  }
  out.push(cur);
  return out;
}

/** True if merged `ranges` cover new-file line 1 (for deciding gap controls above line 1). */
function rangesOverlapNewFileLineOne(ranges) {
  return mergeLineRanges(ranges || []).some((r) => r.start <= 1 && r.end >= 1);
}

function buildRangeDisplayRows(ranges, sourceLines, diffLines, excludedLineNumbers = new Set()) {
  if (!ranges?.length) return [];
  const mergedRanges = mergeLineRanges(ranges);
  if (!mergedRanges.length) return [];
  const inRange = (n) => mergedRanges.some((r) => n >= r.start && n <= r.end);

  const relevantDiffLines = diffLines.filter((row) => {
    if (row.type === 'del') {
      const anchor = row.anchorNewLineNumber ?? 0;
      const oldLn = row.oldLineNumber;
      const byAnchor = inRange(anchor) && !excludedLineNumbers.has(anchor);
      const byOld =
        oldLn != null &&
        oldLn !== '' &&
        inRange(oldLn) &&
        !excludedLineNumbers.has(oldLn);
      return byAnchor || byOld;
    }
    return row.newLineNumber != null && inRange(row.newLineNumber) && !excludedLineNumbers.has(row.newLineNumber);
  });

  const rows = [];
  for (const r of mergedRanges) {
    // Only del/add from the patch; context comes from sourceLines below. Including raw `ctx`
    // rows here duplicated every unchanged line (ctx row + synthetic ctx for the same number).
    for (const row of relevantDiffLines) {
      if (row.type === 'ctx') continue;
      if (row.type === 'del') {
        const anchor = row.anchorNewLineNumber ?? 0;
        const oldLn = row.oldLineNumber;
        const inByAnchor =
          anchor >= r.start && anchor <= r.end && !excludedLineNumbers.has(anchor);
        const inByOld =
          oldLn != null &&
          oldLn !== '' &&
          oldLn >= r.start &&
          oldLn <= r.end &&
          !excludedLineNumbers.has(oldLn);
        if (inByAnchor || inByOld) rows.push(row);
      } else {
        const n = row.newLineNumber ?? 0;
        if (n >= r.start && n <= r.end && !excludedLineNumbers.has(n)) rows.push(row);
      }
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
  const skipGenericCallParsing = !!rowData._isDocstringLine;
  let lineHtml =
    rowData.type === 'add'
      ? hasMeaningfulIntraline(rowData.intraline)
        ? applyIntralineHighlight(line, rowData.intraline, 'intraline intraline-add')
        : highlightPythonWithGenericCalls(line, [], { skipGenericCallParsing })
      : rowData.type === 'del'
        ? hasMeaningfulIntraline(rowData.intraline)
          ? applyIntralineHighlight(line, rowData.intraline, 'intraline intraline-del')
          : highlightPythonWithGenericCalls(line, [], { skipGenericCallParsing })
        : highlightPythonWithGenericCalls(line, [], { skipGenericCallParsing });
  if (rowData.type === 'add') {
    lineHtml = emphasizeSignatureNameInHtml(line, lineHtml);
  }

  const oldNumHtml = rowData.oldLineNumber != null && rowData.oldLineNumber !== '' ? String(rowData.oldLineNumber) : '';
  const newNumHtml = rowData.newLineNumber != null ? String(rowData.newLineNumber) : '';

  const row = document.createElement('div');
  row.className = `diff-line diff-line-${rowData.type}`;
  const isSig = !!getPythonSignatureName(line);
  if (isSig && rowData.type === 'add') row.classList.add('diff-line-signature-change');
  if (isPythonCommentLine(line)) row.classList.add('diff-line-comment');
  if (rowData._isDocstringLine) row.classList.add('diff-line-docstring');
  if (rowData.newLineNumber != null) row.dataset.flowdiffNewLine = String(rowData.newLineNumber);
  if (rowData.anchorNewLineNumber != null) row.dataset.flowdiffAnchorNew = String(rowData.anchorNewLineNumber);
  if (rowData.oldLineNumber != null && rowData.oldLineNumber !== '')
    row.dataset.flowdiffOldLine = String(rowData.oldLineNumber);
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
 * @param {boolean} [fileLineOneVisibleAbove] - sibling blocks above this mount already showed new-file line 1
 * @param {boolean} [implicitContextBeforeFirstAnchor] - pass true when patch `ctx` rows were removed before render (see `injectProgressiveContextGaps`)
 */
function renderDiffRows(
  container,
  filePath,
  rows,
  prContext,
  collapseScopeKey = null,
  preserveNewLines = null,
  sourceLines = null,
  gapRange = null,
  gapInitialEdgeLines = CTX_GAP_INITIAL_EDGE_LINES,
  showCountLabel = true,
  fileLineOneVisibleAbove = false,
  implicitContextBeforeFirstAnchor = false
) {
  const rowsForGaps =
    Array.isArray(rows) && rows.length > 0 ? sortDiffRowsByNewFileAnchor(rows) : rows;
  const withGaps =
    Array.isArray(sourceLines) && sourceLines.length > 0
      ? injectProgressiveContextGaps(rowsForGaps, sourceLines, {
          startLine: gapRange?.startLine,
          endLine: gapRange?.endLine,
          implicitContextBeforeFirstAnchor
        })
      : rowsForGaps;
  const toRender = expandContextCollapseRows(withGaps, preserveNewLines);
  markDocstringLines(toRender);
  for (let ri = 0; ri < toRender.length; ri++) {
    const rowData = toRender[ri];
    const lineOneSeenAbove =
      fileLineOneVisibleAbove || newFileLineOneShownBeforeRowIndex(toRender, ri);
    if (rowData.type === 'ctx-gap') {
      const gapStart = Number(rowData.startLine);
      const gapEnd = Number(rowData.endLine);
      if (!Number.isFinite(gapStart) || !Number.isFinite(gapEnd) || gapEnd < gapStart) continue;
      const lineCount = gapEnd - gapStart + 1;
      const position = rowData.position || 'middle';
      const scope = collapseScopeKey || filePath || 'file';
      const stateKey = `${scope}::ctx-gap::${gapStart}-${gapEnd}`;
      const saved = ctxGapRevealByKey.get(stateKey) || {};
      let defaultEdge = Math.min(Math.max(0, Number(gapInitialEdgeLines) || 0), lineCount);
      // Gap flush to file line 1: never use 0 edge lines — that leaves only an expander with no
      // source above it (nothing exists before line 1). Always show a few real lines first.
      if (gapStart === 1 && position === 'start' && defaultEdge === 0 && lineCount > 0) {
        defaultEdge = Math.min(CTX_GAP_INITIAL_EDGE_LINES, lineCount);
      }
      let head = clampToInt(saved.head ?? defaultEdge, 0, lineCount);
      let tail = clampToInt(saved.tail ?? defaultEdge, 0, lineCount);
      if (head + tail > lineCount) {
        if (head >= lineCount) {
          head = lineCount;
          tail = 0;
        } else {
          tail = Math.max(0, lineCount - head);
        }
      }
      if (gapStart === 1 && position === 'start' && lineCount > 1 && head === 0 && tail === 0) {
        head = Math.min(CTX_GAP_INITIAL_EDGE_LINES, lineCount);
        if (head + tail > lineCount) {
          tail = Math.max(0, lineCount - head);
        }
      }
      // Short preamble at file line 1: show all lines as plain context (no expander row). Avoids
      // stacked gutter controls above the first real diff (e.g. imports on line 1, unchanged 2–5).
      const forcedFullTopPreamble =
        gapStart === 1 &&
        position === 'start' &&
        lineCount >= 1 &&
        lineCount <= CTX_COLLAPSE_MIN_RUN;
      if (forcedFullTopPreamble) {
        head = lineCount;
        tail = 0;
      }
      const hiddenCount = Math.max(0, lineCount - head - tail);
      const hasExpanded =
        !forcedFullTopPreamble && (head !== defaultEdge || tail !== defaultEdge);
      const expanderHeightPx = CTX_GAP_EXPANDER_HEIGHT_MINIMAL_PX;

      const wrap = document.createElement('div');
      wrap.className = 'diff-ctx-gap';
      wrap.dataset.position = position;

      function persistAndRerender(nextHead, nextTail) {
        ctxGapRevealByKey.set(stateKey, {
          head: clampToInt(nextHead, 0, lineCount),
          tail: clampToInt(nextTail, 0, lineCount)
        });
        const codePane = document.getElementById('code-pane');
        if (codePane) renderCodeView(codePane);
      }

      const body = document.createElement('div');
      body.className = 'diff-ctx-gap-body';
      if (head + tail >= lineCount) {
        for (let ln = gapStart; ln <= gapEnd; ln++) {
          appendPlainDiffRow(body, buildCtxRowFromSourceLine(sourceLines || [], ln));
        }
      } else {
        for (let ln = gapStart; ln < gapStart + head; ln++) {
          appendPlainDiffRow(body, buildCtxRowFromSourceLine(sourceLines || [], ln));
        }

        const expanderRow = document.createElement('div');
        expanderRow.className = 'diff-line diff-line-ctx-gap-expander';
        expanderRow.classList.add('diff-line-ctx-gap-expander-minimal');
        expanderRow.style.minHeight = `${expanderHeightPx}px`;
        const gutterA = document.createElement('span');
        gutterA.className = 'diff-num diff-num-ctx diff-num-gap-controls';
        const inlineControls = document.createElement('span');
        inlineControls.className = 'diff-ctx-gap-controls-inline';
        const resetView = document.createElement('button');
        resetView.type = 'button';
        resetView.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--reset';
        resetView.textContent = '↺';
        resetView.title = 'Reset to original view';
        resetView.setAttribute('aria-label', resetView.title);
        resetView.addEventListener('click', () => {
          persistAndRerender(defaultEdge, defaultEdge);
        });
        const gutterB = document.createElement('span');
        gutterB.className = 'diff-num diff-num-ctx';
        gutterB.textContent = '';
        const sign = document.createElement('span');
        sign.className = 'diff-sign diff-sign-ctx';
        sign.textContent = '';
        const meta = document.createElement('pre');
        meta.className = 'diff-code diff-code-ctx diff-code-gap-meta';
        const metaCode = document.createElement('code');
        metaCode.className = 'language-python';

        if (hiddenCount > 0) {
          const showAbove = document.createElement('button');
          showAbove.type = 'button';
          showAbove.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--up';
          setGapCaretIcon(showAbove, 'up');
          showAbove.title = `Show ${Math.min(CTX_GAP_REVEAL_CHUNK_LINES, hiddenCount)} above`;
          showAbove.setAttribute('aria-label', showAbove.title);
          showAbove.addEventListener('click', () => {
            const n = Math.min(CTX_GAP_REVEAL_CHUNK_LINES, hiddenCount);
            // "Above" should reveal from the bottom boundary upward.
            persistAndRerender(head, tail + n);
          });
          // No up/down carets when the gap touches file line 1 and the view already includes line 1
          // (this mount starts at line 1, or a prior row / sibling block showed it) — nothing to
          // expand toward above line 1; keep only "show all" (⋯) when needed.
          const suppressDirectionalCarets =
            gapStart === 1 && (position === 'start' || lineOneSeenAbove);
          const canShowAbove =
            !suppressDirectionalCarets && (position === 'middle' || position === 'end');

          const showBelow = document.createElement('button');
          showBelow.type = 'button';
          showBelow.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--down';
          setGapCaretIcon(showBelow, 'down');
          showBelow.title = `Show ${Math.min(CTX_GAP_REVEAL_CHUNK_LINES, hiddenCount)} below`;
          showBelow.setAttribute('aria-label', showBelow.title);
          showBelow.addEventListener('click', () => {
            const n = Math.min(CTX_GAP_REVEAL_CHUNK_LINES, hiddenCount);
            // "Below" should reveal from the top boundary downward.
            persistAndRerender(head + n, tail);
          });
          const canShowBelow =
            !suppressDirectionalCarets && (position === 'middle' || position === 'start');
          const showAll = document.createElement('button');
          showAll.type = 'button';
          showAll.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--all';
          showAll.textContent = '⋯';
          showAll.title = `Show all ${hiddenCount} lines`;
          showAll.setAttribute('aria-label', showAll.title);
          showAll.addEventListener('click', () => {
            persistAndRerender(lineCount, 0);
          });

          // GitHub-like vertical gutter controls: down (top), all (middle), up (bottom).
          const canExpandBothWays = canShowAbove && canShowBelow;
          if (suppressDirectionalCarets) {
            inlineControls.appendChild(showAll);
          } else if (canExpandBothWays) {
            inlineControls.appendChild(showAbove);
            if (hiddenCount > CTX_GAP_REVEAL_CHUNK_LINES) inlineControls.appendChild(showAll);
            inlineControls.appendChild(showBelow);
          } else if (canShowAbove) {
            inlineControls.appendChild(showAbove);
          } else if (canShowBelow) {
            inlineControls.appendChild(showBelow);
          }
        }
        if (hasExpanded) inlineControls.appendChild(resetView);
        meta.classList.add('diff-code-gap-meta-minimal', 'diff-code-gap-meta-minimal-inline');
        metaCode.textContent = '';
        gutterA.appendChild(inlineControls);
        meta.appendChild(metaCode);
        expanderRow.appendChild(gutterA);
        expanderRow.appendChild(gutterB);
        expanderRow.appendChild(sign);
        expanderRow.appendChild(meta);
        body.appendChild(expanderRow);

        for (let ln = gapEnd - tail + 1; ln <= gapEnd; ln++) {
          appendPlainDiffRow(body, buildCtxRowFromSourceLine(sourceLines || [], ln));
        }
      }
      wrap.appendChild(body);
      container.appendChild(wrap);
      continue;
    }
    if (rowData.type === 'ctx-collapse') {
      const hiddenRows = rowData.hiddenRows || [];
      const hiddenCount = Number(rowData.lineCount || hiddenRows.length || 0);
      const startLine = Number(rowData.startLine || hiddenRows[0]?.newLineNumber || 0);
      const endLine = Number(rowData.endLine || hiddenRows[hiddenRows.length - 1]?.newLineNumber || 0);
      const scope = collapseScopeKey || filePath || 'file';
      const stateKey = `${scope}::ctx-collapse::${startLine}-${endLine}`;
      const saved = ctxGapRevealByKey.get(stateKey) || {};
      let head = clampToInt(saved.head ?? 0, 0, hiddenCount);
      let tail = clampToInt(saved.tail ?? 0, 0, hiddenCount);
      if (head + tail > hiddenCount) {
        if (head >= hiddenCount) {
          head = hiddenCount;
          tail = 0;
        } else {
          tail = Math.max(0, hiddenCount - head);
        }
      }
      const remain = Math.max(0, hiddenCount - head - tail);
      const hasExpanded = head > 0 || tail > 0;

      function persistAndRerender(nextHead, nextTail) {
        ctxGapRevealByKey.set(stateKey, {
          head: clampToInt(nextHead, 0, hiddenCount),
          tail: clampToInt(nextTail, 0, hiddenCount)
        });
        const codePane = document.getElementById('code-pane');
        if (codePane) renderCodeView(codePane);
      }

      const revealHeadRows = hiddenRows.slice(0, head);
      const revealTailRows = hiddenRows.slice(Math.max(head, hiddenRows.length - tail));
      for (const hr of revealHeadRows) {
        appendPlainDiffRow(container, hr);
      }

      if (remain > 0) {
        const expanderHeightPx = CTX_GAP_EXPANDER_HEIGHT_MINIMAL_PX;
        const expanderRow = document.createElement('div');
        expanderRow.className = 'diff-line diff-line-ctx-gap-expander';
        expanderRow.classList.add('diff-line-ctx-gap-expander-minimal');
        expanderRow.style.minHeight = `${expanderHeightPx}px`;
        const gutterA = document.createElement('span');
        gutterA.className = 'diff-num diff-num-ctx diff-num-gap-controls';
        const inlineControls = document.createElement('span');
        inlineControls.className = 'diff-ctx-gap-controls-inline';
        const resetView = document.createElement('button');
        resetView.type = 'button';
        resetView.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--reset';
        resetView.textContent = '↺';
        resetView.title = 'Reset to original view';
        resetView.setAttribute('aria-label', resetView.title);
        resetView.addEventListener('click', () => {
          persistAndRerender(0, 0);
        });
        const gutterB = document.createElement('span');
        gutterB.className = 'diff-num diff-num-ctx';
        const sign = document.createElement('span');
        sign.className = 'diff-sign diff-sign-ctx';
        const meta = document.createElement('pre');
        meta.className = 'diff-code diff-code-ctx diff-code-gap-meta';
        const metaCode = document.createElement('code');
        metaCode.className = 'language-python';

        const showAbove = document.createElement('button');
        showAbove.type = 'button';
        showAbove.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--up';
        setGapCaretIcon(showAbove, 'up');
        showAbove.title = `Show ${Math.min(CTX_GAP_REVEAL_CHUNK_LINES, remain)} above`;
        showAbove.setAttribute('aria-label', showAbove.title);
        showAbove.addEventListener('click', () => {
          const n = Math.min(CTX_GAP_REVEAL_CHUNK_LINES, remain);
          persistAndRerender(head, tail + n);
        });

        const showBelow = document.createElement('button');
        showBelow.type = 'button';
        showBelow.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--down';
        setGapCaretIcon(showBelow, 'down');
        showBelow.title = `Show ${Math.min(CTX_GAP_REVEAL_CHUNK_LINES, remain)} below`;
        showBelow.setAttribute('aria-label', showBelow.title);
        showBelow.addEventListener('click', () => {
          const n = Math.min(CTX_GAP_REVEAL_CHUNK_LINES, remain);
          persistAndRerender(head + n, tail);
        });

        const showAll = document.createElement('button');
        showAll.type = 'button';
        showAll.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--all';
        showAll.textContent = '⋯';
        showAll.title = `Show all ${remain} lines`;
        showAll.setAttribute('aria-label', showAll.title);
        showAll.addEventListener('click', () => {
          persistAndRerender(hiddenCount, 0);
        });

        const hiddenFirstLn = Number(hiddenRows[0]?.newLineNumber);
        const sliceStartsAtFileLineOne = !gapRange || Number(gapRange?.startLine ?? 1) <= 1;
        const suppressCollapseShowAbove =
          Number.isFinite(hiddenFirstLn) &&
          hiddenFirstLn <= 1 &&
          (lineOneSeenAbove || sliceStartsAtFileLineOne);
        if (!suppressCollapseShowAbove) {
          inlineControls.appendChild(showAbove);
        }
        if (remain > CTX_GAP_REVEAL_CHUNK_LINES) inlineControls.appendChild(showAll);
        inlineControls.appendChild(showBelow);
        if (hasExpanded) inlineControls.appendChild(resetView);
        meta.classList.add('diff-code-gap-meta-minimal', 'diff-code-gap-meta-minimal-inline');
        metaCode.textContent = '';
        gutterA.appendChild(inlineControls);
        meta.appendChild(metaCode);
        expanderRow.appendChild(gutterA);
        expanderRow.appendChild(gutterB);
        expanderRow.appendChild(sign);
        expanderRow.appendChild(meta);
        container.appendChild(expanderRow);
      }

      for (const hr of revealTailRows) {
        appendPlainDiffRow(container, hr);
      }
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

/** Every function/class id that participates in **any** flow (union across `payload.flows`). */
function collectUnionFlowFunctionIds(payload) {
  const ids = new Set();
  for (const flow of payload.flows || []) {
    if (!flow?.rootId || !payload.functionsById[flow.rootId]) continue;
    for (const id of getFlowFunctionIds(flow, payload)) ids.add(id);
  }
  return ids;
}

/**
 * Ensure changed function definitions are visible in file diffs.
 * If a changed function body appears but its `def` line is outside patch context,
 * inject context rows from the definition down to first touched line; long runs are
 * subsequently collapsed by existing context-collapse rendering.
 * @param {string} filePath
 * @param {any[]} rows
 * @param {Record<string, import('../flowSchema.js').FunctionMeta>} functionsById
 * @param {string[]} sourceLines
 * @returns {any[]}
 */
function includeChangedFunctionDefinitions(filePath, rows, functionsById, sourceLines) {
  if (!sourceLines?.length) return rows;
  const fns = Object.values(functionsById)
    .filter((fn) => fn?.file === filePath && fn?.changed && fn.changeType !== 'deleted')
    .sort((a, b) => a.startLine - b.startLine);
  if (fns.length === 0) return rows;

  const out = [...rows];
  const existingByNewLine = new Set(
    out
      .map((r) =>
        r?.newLineNumber != null
          ? Number(r.newLineNumber)
          : r?.anchorNewLineNumber != null
            ? Number(r.anchorNewLineNumber)
            : null
      )
      .filter((n) => Number.isFinite(n))
  );

  for (const fn of fns) {
    const fnStart = Number(fn.startLine);
    const fnEnd = Number(fn.endLine);
    if (!Number.isFinite(fnStart) || !Number.isFinite(fnEnd) || fnEnd < fnStart) continue;

    const rowsInFn = out.filter((r) => {
      const n = r?.newLineNumber != null
        ? Number(r.newLineNumber)
        : r?.anchorNewLineNumber != null
          ? Number(r.anchorNewLineNumber)
          : null;
      return n != null && n >= fnStart && n <= fnEnd;
    });
    const hasTouchedInFn = rowsInFn.some((r) => r.type === 'add' || r.type === 'del');
    if (!hasTouchedInFn) continue;
    if (existingByNewLine.has(fnStart)) continue;

    const firstTouched = Math.min(
      ...rowsInFn
        .filter((r) => r.type === 'add' || r.type === 'del')
        .map((r) =>
          r?.newLineNumber != null
            ? Number(r.newLineNumber)
            : r?.anchorNewLineNumber != null
              ? Number(r.anchorNewLineNumber)
              : fnStart
        )
    );
    const injectEnd = Number.isFinite(firstTouched) ? Math.max(fnStart, firstTouched - 1) : fnStart;
    for (let ln = fnStart; ln <= injectEnd; ln++) {
      if (existingByNewLine.has(ln)) continue;
      out.push({
        type: 'ctx',
        oldLineNumber: '',
        newLineNumber: ln,
        anchorNewLineNumber: ln,
        content: sourceLines[ln - 1] ?? ''
      });
      existingByNewLine.add(ln);
    }
  }

  const key = (r) =>
    r.type === 'del'
      ? Number(r.anchorNewLineNumber ?? r.newLineNumber ?? 0)
      : Number(r.newLineNumber ?? r.anchorNewLineNumber ?? 0);
  return out.sort((a, b) => key(a) - key(b));
}

function toBaseName(path) {
  return String(path || '').replace(/^.*\//, '');
}

function pathParts(path) {
  return String(path || '').split('/').filter(Boolean);
}

function filePathSort(a, b) {
  return String(a).localeCompare(String(b));
}

/** Align function `file` fields with `flowPayload.files[].path` for nav / outside-diff checks. */
function normalizeNavFilePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * Normalized paths that “belong to the rhizome” in the file outline.
 * Rule: if **any** changed unit that participates in **any** flow (any id in `unionFlowFnIds`)
 * lives in a file, that path counts as a rhizome file for sorting / muting (not tied to the
 * currently selected flow).
 * @param {import('../flowSchema.js').FlowPayload} payload
 * @param {Set<string>} unionFlowFnIds
 * @returns {Set<string>}
 */
function rhizomeParticipatingFilePathNorms(payload, unionFlowFnIds) {
  const paths = new Set();
  for (const fnId of unionFlowFnIds) {
    const p = payload.functionsById[fnId]?.file;
    if (p) paths.add(normalizeNavFilePath(p));
  }
  return paths;
}

function clampFilesNavWidth(widthPx) {
  return Math.max(FILES_NAV_WIDTH_MIN, Math.min(FILES_NAV_WIDTH_MAX, widthPx));
}

function setFileSectionCollapsed(section, isCollapsed) {
  const body = section.querySelector('.file-content');
  const toggle = section.querySelector('.file-header-collapse-btn');
  if (body) body.hidden = isCollapsed;
  section.classList.toggle('file-section-collapsed', isCollapsed);
  if (toggle) {
    toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    toggle.textContent = isCollapsed ? '▸' : '▾';
    toggle.title = isCollapsed ? 'Expand file' : 'Collapse file';
  }
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
 * Keep nested Python defs inside parent cards only.
 * Hard guard: if a function/method node's span is fully contained by an ancestor
 * class/function/method span from its tree-node path in the same file, suppress it as a separate card.
 * Keeps the node in the rhizome tree, but avoids duplicate code cards.
 * @param {{ treeNodeKey: string, functionId: string }[]} order
 * @param {import('../flowSchema.js').FlowPayload} payload
 * @returns {{ treeNodeKey: string, functionId: string }[]}
 */
function filterNestedFunctionCards(order, payload) {
  /**
   * Sequence of function ids along this tree path, in order from root to current node.
   * root:RID => [RID]
   * root:RID/e:RID:0:C1/e:C1:2:C2 => [RID, C1, C2]
   * @param {string} treeNodeKey
   * @returns {string[]}
   */
  function functionPathIdsFromTreeNodeKey(treeNodeKey) {
    if (!treeNodeKey) return [];
    const ids = [];
    for (const seg of String(treeNodeKey).split('/')) {
      if (seg.startsWith('root:')) {
        ids.push(seg.slice(5));
        continue;
      }
      if (seg.startsWith('e:')) {
        const p = seg.split(':');
        if (p.length >= 4) ids.push(p[3]);
      }
    }
    return ids;
  }

  const kept = [];
  for (const item of order) {
    const fn = payload.functionsById[item.functionId];
    if (!fn) continue;
    const fnStart = Number(fn.startLine);
    const fnEnd = Number(fn.endLine);
    if (!Number.isFinite(fnStart) || !Number.isFinite(fnEnd) || fnEnd < fnStart) {
      kept.push(item);
      continue;
    }
    // Keep class cards as top-level structural cards; nested methods/functions render in-body.
    const fnKind = fn.kind || 'function';
    if (fnKind === 'class') {
      kept.push(item);
      continue;
    }
    const pathIds = functionPathIdsFromTreeNodeKey(item.treeNodeKey);
    const ancestorIds = pathIds.slice(0, -1);
    const nestedUnderAncestor = ancestorIds.some((ancestorId) => {
      const parentFn = payload.functionsById[ancestorId];
      if (!parentFn || parentFn.file !== fn.file) return false;
      const parentStart = Number(parentFn.startLine);
      const parentEnd = Number(parentFn.endLine);
      if (!Number.isFinite(parentStart) || !Number.isFinite(parentEnd) || parentEnd < parentStart) {
        return false;
      }
      const parentKind = parentFn.kind || 'function';
      if (!['class', 'function', 'method'].includes(parentKind)) return false;
      return fnStart >= parentStart && fnEnd <= parentEnd;
    });
    if (!nestedUnderAncestor) kept.push(item);
  }
  return kept;
}

/**
 * Assignment symbols from the parser plus best-effort import names from module-level changed lines.
 * Used to score which function body references module edits most (word-boundary matches).
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
 * Picks the single function/class id on a file that should show module-level (non-body) diff strips.
 * Primary: max references to module symbols; tie: largest participating flow (by node count),
 * then stable flow order, then first in that flow's DFS order among tied ids.
 * @param {object} opts
 * @param {import('../flowSchema.js').FunctionMeta[]} opts.candidates
 * @param {{ start: number, end: number }[]} opts.moduleChangedRanges
 * @param {string[]} opts.moduleChangedSymbols
 * @param {string[]} opts.sourceLines
 * @param {import('../flowSchema.js').FlowPayload} opts.payload
 * @param {import('../flowSchema.js').Flow[]} opts.flows
 * @param {import('../flowSchema.js').Flow | null} opts.selectedFlow
 * @returns {string | null}
 */
function pickModuleContextHostFunctionId({
  candidates,
  moduleChangedRanges,
  moduleChangedSymbols,
  sourceLines,
  payload,
  flows,
  selectedFlow
}) {
  if (!candidates?.length) return null;
  const refSymbols = collectModuleRefSymbolsForScoring(
    moduleChangedRanges,
    sourceLines,
    moduleChangedSymbols
  );
  let bestScore = -1;
  /** @type {Map<string, number>} */
  const scores = new Map();
  for (const fn of candidates) {
    const sc = refSymbols.length ? countModuleSymbolRefsInBody(fn, refSymbols, sourceLines) : 0;
    scores.set(fn.id, sc);
    if (sc > bestScore) bestScore = sc;
  }
  const T = new Set(candidates.filter((fn) => scores.get(fn.id) === bestScore).map((fn) => fn.id));

  /** @type {{ flow: import('../flowSchema.js').Flow, size: number, index: number }[]} */
  const qualifyingFlows = [];
  const flowList = flows || [];
  for (let i = 0; i < flowList.length; i++) {
    const flow = flowList[i];
    if (!flow?.rootId || !payload.functionsById[flow.rootId]) continue;
    const flowIds = getFlowFunctionIds(flow, payload);
    let hit = false;
    for (const id of T) {
      if (flowIds.has(id)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    qualifyingFlows.push({ flow, size: flowIds.size, index: i });
  }

  /** @param {string} rootId */
  function dfsFirstInSet(rootId) {
    const order = collectFlowOrder(rootId, payload);
    for (const { functionId } of order) {
      if (T.has(functionId)) return functionId;
    }
    return null;
  }

  if (qualifyingFlows.length) {
    const maxSize = Math.max(...qualifyingFlows.map((q) => q.size));
    const largest = qualifyingFlows.filter((q) => q.size === maxSize);
    largest.sort((a, b) => a.index - b.index);
    const id = dfsFirstInSet(largest[0].flow.rootId);
    if (id) return id;
  }

  if (selectedFlow?.rootId && payload.functionsById[selectedFlow.rootId]) {
    const id = dfsFirstInSet(selectedFlow.rootId);
    if (id) return id;
  }

  const metas = candidates.filter((fn) => T.has(fn.id));
  metas.sort((a, b) => a.startLine - b.startLine || String(a.id).localeCompare(String(b.id)));
  return metas[0]?.id ?? null;
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
  /** Same source range must not be claimed by multiple callees that share a short `name`. */
  const claimed = new Set();
  const trimmed = String(line || '').trimStart();
  const isDefinitionLine = /^(?:async\s+def|def|class)\b/.test(trimmed);
  for (const { calleeId, name } of callees) {
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(line)) !== null) {
      const start = m.index;
      // Never treat declarations (def/class signatures) as call sites.
      if (isDefinitionLine) continue;
      const openParen = line.indexOf('(', start);
      const end = findCallEnd(line, openParen);
      const key = `${start}:${end}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      sites.push({ start, end, calleeId });
    }
  }
  return sites.sort((a, b) => a.start - b.start);
}

function findGenericCallNameSites(line, blockedRanges = []) {
  const out = [];
  const trimmed = String(line || '').trimStart();
  if (/^(?:async\s+def|def|class)\b/.test(trimmed)) return out;
  const re = /\b([A-Za-z_]\w*)\b(?=\s*\()/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const name = m[1];
    const start = m.index;
    const end = start + name.length;
    const blocked = blockedRanges.some((r) => start >= r.start && start < r.end);
    if (blocked) continue;
    out.push({ start, end, name });
  }
  return out;
}

function highlightPythonWithGenericCalls(line, blockedRanges = [], opts = {}) {
  if (isPythonCommentLine(line) || opts.skipGenericCallParsing) return highlightPython(line);
  const genericSites = findGenericCallNameSites(line, blockedRanges);
  if (!genericSites.length) return highlightPython(line);
  let composed = '';
  let last = 0;
  const placeholders = [];
  for (let i = 0; i < genericSites.length; i++) {
    const s = genericSites[i];
    composed += line.slice(last, s.start);
    const ph = `__flowdiff_generic_call_${i}__`;
    composed += ph;
    placeholders.push({ ph, name: s.name });
    last = s.end;
  }
  composed += line.slice(last);
  let html = highlightPython(composed);
  for (const { ph, name } of placeholders) {
    html = html.replace(
      new RegExp(escapeRegex(ph), 'g'),
      `<span class="flowdiff-generic-call">${escapeHtml(name)}</span>`
    );
  }
  return html;
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
  calleesForFind,
  canonicalKeyByFunctionId
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
      placeholders.push({ ...site, placeholder: ph });
      lastEnd = site.end;
    }
    lineWithPlaceholders += line.slice(lastEnd);
    lineHtml = highlightPythonWithGenericCalls(lineWithPlaceholders, sites, {
      skipGenericCallParsing: !!rowData._isDocstringLine
    });

    for (let pi = 0; pi < placeholders.length; pi++) {
      const { placeholder, calleeId, start, end } = placeholders[pi];
      let calleeOrdinalOnLine = 0;
      for (let j = 0; j < pi; j++) {
        if (placeholders[j].calleeId === calleeId) calleeOrdinalOnLine++;
      }
      const callText = line.slice(start, end);
      const isRecursive = pathFunctionIds.has(calleeId);
      const navKey = canonicalKeyByFunctionId.get(calleeId) ?? '';
      const dataKey = navKey ? ` data-tree-node-key="${escapeHtml(navKey)}"` : '';
      const ordAttr = ` data-fd-callee-ord="${calleeOrdinalOnLine}"`;
      const recClass = isRecursive ? ' call-site-recursive' : '';
      const title = isRecursive ? 'Jump to definition (already shown above in this flow)' : 'Go to function';
      const fnName = getFunctionDisplayName(payload.functionsById[calleeId]) || calleeId;
      const recContent = isRecursive
        ? `<span class="call-site-recursive-icon" aria-hidden="true">↻</span> ${escapeHtml(fnName)} <span class="call-site-recursive-hint">(already above)</span>`
        : escapeHtml(callText);
      const callSpanHtml = `<span class="call-site${recClass}" data-callee-id="${escapeHtml(calleeId)}" data-recursive="${isRecursive}"${ordAttr}${dataKey} title="${escapeHtml(title)}">${recContent}</span>`;
      lineHtml = lineHtml.replace(new RegExp(escapeRegex(placeholder), 'g'), callSpanHtml);
    }
  } else if (rowData.type === 'add') {
    lineHtml = hasMeaningfulIntraline(rowData.intraline)
      ? applyIntralineHighlight(indent + line, rowData.intraline, 'intraline intraline-add')
      : highlightPythonWithGenericCalls(indent + line, [], {
          skipGenericCallParsing: !!rowData._isDocstringLine
        });
  } else if (rowData.type === 'del') {
    lineHtml = hasMeaningfulIntraline(rowData.intraline)
      ? applyIntralineHighlight(indent + line, rowData.intraline, 'intraline intraline-del')
      : highlightPythonWithGenericCalls(indent + line, [], {
          skipGenericCallParsing: !!rowData._isDocstringLine
        });
  } else {
    lineHtml = highlightPythonWithGenericCalls(indent + line, [], {
      skipGenericCallParsing: !!rowData._isDocstringLine
    });
  }
  if (rowData.type === 'add') {
    lineHtml = emphasizeSignatureNameInHtml(line, lineHtml);
  }

  const oldNumHtml = rowData.oldLineNumber != null && rowData.oldLineNumber !== '' ? String(rowData.oldLineNumber) : '';
  const newNumHtml = rowData.newLineNumber != null ? String(rowData.newLineNumber) : '';
  const row = document.createElement('div');
  row.className = `diff-line diff-line-${rowData.type}`;
  const isSig = !!getPythonSignatureName(line);
  if (isSig && rowData.type === 'add') row.classList.add('diff-line-signature-change');
  if (isPythonCommentLine(line)) row.classList.add('diff-line-comment');
  if (rowData._isDocstringLine) row.classList.add('diff-line-docstring');
  if (rowData.newLineNumber != null) row.dataset.flowdiffNewLine = String(rowData.newLineNumber);
  if (rowData.anchorNewLineNumber != null) row.dataset.flowdiffAnchorNew = String(rowData.anchorNewLineNumber);
  if (rowData.oldLineNumber != null && rowData.oldLineNumber !== '')
    row.dataset.flowdiffOldLine = String(rowData.oldLineNumber);
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
      uiState.activeFunctionId === calleeId &&
      (!treeNodeKey || !uiState.activeTreeNodeKey || uiState.activeTreeNodeKey === treeNodeKey);
    if (isRecursive) {
      el.title = `Go to ${getFunctionDisplayName(callee) || calleeId} (already shown above)`;
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ord = el.dataset.fdCalleeOrd != null ? Number(el.dataset.fdCalleeOrd) : 0;
        navigateFromInlineCallSite(calleeId, treeNodeKey || null, pathPrefix, rowData, ord);
      });
      el.addEventListener('mouseenter', () => {
        if (treeNodeKey) setHoveredTreeNodeKey(treeNodeKey);
      });
      el.addEventListener('mouseleave', () => {
        setHoveredTreeNodeKey(null);
      });
      if (isActive) el.classList.add('active');
      return;
    }
    if (isActive) el.classList.add('active');
    el.title = `Go to ${getFunctionDisplayName(callee) || calleeId}`;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ord = el.dataset.fdCalleeOrd != null ? Number(el.dataset.fdCalleeOrd) : 0;
      navigateFromInlineCallSite(calleeId, treeNodeKey || null, pathPrefix, rowData, ord);
    });
    el.addEventListener('mouseenter', () => {
      if (treeNodeKey) setHoveredTreeNodeKey(treeNodeKey);
    });
    el.addEventListener('mouseleave', () => {
      setHoveredTreeNodeKey(null);
    });
  });

  // Hovering a function/class definition line should also spotlight its node in the rhizome tree.
  if (isSig && pathPrefix) {
    row.addEventListener('mouseenter', () => {
      setHoveredTreeNodeKey(pathPrefix);
    });
    row.addEventListener('mouseleave', () => {
      setHoveredTreeNodeKey(null);
    });
  }

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

/**
 * Remove [cutStart, cutEnd] (inclusive) from a list of line ranges. Used to avoid
 * duplicating a class block in the module-level inline strip.
 * @param {{ start: number, end: number }[] | null | undefined} ranges
 * @param {number} cutStart
 * @param {number} cutEnd
 */
function subtractIntervalFromModuleRanges(ranges, cutStart, cutEnd) {
  if (!ranges?.length) return [];
  if (cutStart > cutEnd) return ranges;
  const out = [];
  for (const r of ranges) {
    if (cutEnd < r.start || cutStart > r.end) {
      out.push(r);
      continue;
    }
    if (cutStart <= r.start && cutEnd >= r.end) {
      continue;
    }
    if (cutStart > r.start) {
      out.push({ start: r.start, end: Math.min(r.end, cutStart - 1) });
    }
    if (cutEnd < r.end) {
      out.push({ start: Math.max(r.start, cutEnd + 1), end: r.end });
    }
  }
  return out.filter((x) => x.start <= x.end);
}

/**
 * Line range of the enclosing class header (above a method def), for subtracting from module
 * "before" ranges without mounting the class block.
 * @param {import('../flowSchema.js').FlowPayload} payload
 * @param {import('../flowSchema.js').FunctionMeta} methodFn
 * @param {boolean} collapsedMode
 * @returns {{ cut: { start: number, end: number } | null, classMeta: import('../flowSchema.js').FunctionMeta | null }}
 */
function getEnclosingClassContextForMethod(payload, methodFn, collapsedMode) {
  if (collapsedMode || methodFn.kind !== 'method' || !payload.classDefAboveMethod) {
    return { cut: null, classMeta: null };
  }
  const cId = payload.classDefAboveMethod[methodFn.id];
  const cMeta = cId ? payload.functionsById[cId] : null;
  if (!cMeta) return { cut: null, classMeta: null };
  const rStart = cMeta.startLine;
  const rEnd = methodFn.startLine - 1;
  if (rEnd < rStart) return { cut: null, classMeta: null };
  return { cut: { start: rStart, end: rEnd }, classMeta: cMeta };
}

/**
 * Renders a changed `class` (lines above the current `def`, excluding earlier methods' bodies)
 * inline in the method card—same block as the method diff, not a separate framed section.
 * @returns {{ start: number, end: number } | null} line range removed from the module "before" panel
 */
function mountEnclosingClassDefinitionInBody(
  container,
  payload,
  classMeta,
  methodFn,
  sourceLinesByFile,
  diffLinesByFile,
  prContext,
  pathPrefix,
  fileLineOneVisibleAbove = false
) {
  const rStart = classMeta.startLine;
  const rEnd = methodFn.startLine - 1;
  if (rEnd < rStart) return null;

  const excludedLineNumbers = new Set();
  for (const fn of Object.values(payload.functionsById)) {
    if (fn?.kind !== 'method' || fn.file !== methodFn.file || fn.className !== methodFn.className) continue;
    if (fn.id === methodFn.id) continue;
    if (fn.startLine < methodFn.startLine) {
      for (let ln = fn.startLine; ln <= fn.endLine; ln++) excludedLineNumbers.add(ln);
    }
  }
  const sourceLines = sourceLinesByFile[methodFn.file] || [];
  const rows = buildRangeDisplayRows(
    [{ start: rStart, end: rEnd }],
    sourceLines,
    diffLinesByFile[methodFn.file] || [],
    excludedLineNumbers
  );
  if (!rows.length) {
    return { start: rStart, end: rEnd };
  }
  // In rhizome method context, keep only changed rows and let progressive gaps handle unchanged spans.
  const rowsForRender = rows.filter((r) => r.type !== 'ctx');

  const wrap = document.createElement('div');
  wrap.className = 'class-definition-above';
  const expandedKey = `${pathPrefix}::enclosing-class::${classMeta.id}`;
  renderDiffRows(
    wrap,
    methodFn.file,
    rowsForRender,
    prContext,
    expandedKey,
    null,
    sourceLines,
    { startLine: rStart, endLine: rEnd },
    rStart === 1 ? CTX_GAP_INITIAL_EDGE_LINES : 0,
    false,
    fileLineOneVisibleAbove,
    true
  );
  container.appendChild(wrap);
  return { start: rStart, end: rEnd };
}

/**
 * Module-level diff lines in the same scrolling block as the function body (not card chrome).
 * @param {'before' | 'after'} slot
 */
function mountModuleContextInline(
  container,
  fileMeta,
  ranges,
  fn,
  sourceLinesByFile,
  diffLinesByFile,
  pathPrefix,
  prContext,
  slot,
  showCountLabel = true,
  fileLineOneVisibleAbove = false
) {
  if (!ranges?.length) return;
  const sourceLines = sourceLinesByFile[fn.file] || [];
  const rows = buildRangeDisplayRows(
    ranges,
    sourceLines,
    diffLinesByFile[fn.file] || [],
    new Set(fileMeta.moduleExcludedLineNumbers || [])
  );
  if (!rows.length) return;
  // For rhizome contexts, render changed rows and let gaps provide progressive expansion.
  const rowsForRender = showCountLabel ? rows : rows.filter((r) => r.type !== 'ctx');
  const wrap = document.createElement('div');
  wrap.className = `module-context-inline module-context-inline--${slot}`;
  const expandedKey = `${pathPrefix}::${fn.file}::module-inline-${slot}::${fn.id}`;
  const moduleStart = Math.min(...ranges.map((r) => Number(r.start)).filter((n) => Number.isFinite(n)));
  const moduleEnd = Math.max(...ranges.map((r) => Number(r.end)).filter((n) => Number.isFinite(n)));
  const rangeStart =
    slot === 'before'
      ? moduleStart
      : Number(fn.endLine) + 1;
  const rangeEnd =
    slot === 'before'
      ? Number(fn.startLine) - 1
      : moduleEnd;
  renderDiffRows(
    wrap,
    fn.file,
    rowsForRender,
    prContext,
    expandedKey,
    null,
    sourceLines,
    Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeStart <= rangeEnd
      ? { startLine: rangeStart, endLine: rangeEnd }
      : null,
    showCountLabel ? CTX_GAP_INITIAL_EDGE_LINES : 0,
    showCountLabel,
    fileLineOneVisibleAbove,
    !showCountLabel
  );
  container.appendChild(wrap);
}

/**
 * Mounts expandable file context around a function: everything above its start line
 * and below its end line in the same file. Uses the same progressive expander rows.
 * @param {'before' | 'after'} slot
 * @param {{ beforeSegments?: { start: number, end: number }[], beforeEndLine?: number, afterSegments?: { start: number, end: number }[], fileLineOneVisibleAbove?: boolean }} [opts] -
 *   `beforeSegments`: disjoint line ranges to show as file preamble (omit lines covered by module
 *   `rangesBefore` so imports are not shown once as unchanged and again as a diff). When absent,
 *   `beforeEndLine` (if set) or `fn.startLine - 1` defines a single `[1, end]` range.
 *   `afterSegments`: disjoint tail ranges after `fn.endLine` (omit lines covered by module
 *   `rangesAfter` so trailing file context does not duplicate the module strip).
 */
function mountFileContextAroundFunction(
  container,
  fn,
  sourceLinesByFile,
  pathPrefix,
  prContext,
  slot,
  opts = {}
) {
  const sourceLines = sourceLinesByFile[fn.file] || [];
  if (!sourceLines.length) return;
  const fileEnd = sourceLines.length;
  const methodStart = Math.max(0, Number(fn.startLine) - 1);
  const fileLineOneVA = opts.fileLineOneVisibleAbove === true;

  if (slot === 'after' && Array.isArray(opts.afterSegments)) {
    const merged = mergeLineRanges(
      opts.afterSegments.filter(
        (s) =>
          s &&
          Number.isFinite(Number(s.start)) &&
          Number.isFinite(Number(s.end)) &&
          Number(s.end) >= Number(s.start)
      )
    );
    if (!merged.length) return;
    for (let si = 0; si < merged.length; si++) {
      const seg = merged[si];
      const range = { startLine: seg.start, endLine: seg.end };
      if (range.startLine > range.endLine) continue;
      const wrap = document.createElement('div');
      wrap.className = `function-file-context-inline function-file-context-inline--${slot}`;
      const key = `${pathPrefix}::${fn.id}::file-context-${slot}${merged.length > 1 ? `-seg${si}` : ''}`;
      renderDiffRows(
        wrap,
        fn.file,
        [],
        prContext,
        key,
        null,
        sourceLines,
        range,
        range.startLine === 1 ? CTX_GAP_INITIAL_EDGE_LINES : 0,
        false,
        fileLineOneVA,
        false
      );
      container.appendChild(wrap);
    }
    return;
  }

  if (slot === 'before' && Array.isArray(opts.beforeSegments)) {
    const merged = mergeLineRanges(
      opts.beforeSegments.filter(
        (s) =>
          s &&
          Number.isFinite(Number(s.start)) &&
          Number.isFinite(Number(s.end)) &&
          Number(s.end) >= Number(s.start)
      )
    );
    if (!merged.length) return;
    for (let si = 0; si < merged.length; si++) {
      const seg = merged[si];
      const range = { startLine: seg.start, endLine: seg.end };
      if (range.startLine > range.endLine) continue;
      const wrap = document.createElement('div');
      wrap.className = `function-file-context-inline function-file-context-inline--${slot}`;
      const key = `${pathPrefix}::${fn.id}::file-context-${slot}${merged.length > 1 ? `-seg${si}` : ''}`;
      renderDiffRows(
        wrap,
        fn.file,
        [],
        prContext,
        key,
        null,
        sourceLines,
        range,
        range.startLine === 1 ? CTX_GAP_INITIAL_EDGE_LINES : 0,
        false,
        fileLineOneVA,
        false
      );
      container.appendChild(wrap);
    }
    return;
  }

  const range =
    slot === 'before'
      ? {
          startLine: 1,
          endLine:
            opts.beforeEndLine != null && Number.isFinite(Number(opts.beforeEndLine))
              ? clampToInt(Number(opts.beforeEndLine), 0, methodStart)
              : methodStart
        }
      : { startLine: Number(fn.endLine) + 1, endLine: fileEnd };
  if (!Number.isFinite(range.startLine) || !Number.isFinite(range.endLine)) return;
  if (range.startLine > range.endLine) return;

  const wrap = document.createElement('div');
  wrap.className = `function-file-context-inline function-file-context-inline--${slot}`;
  const key = `${pathPrefix}::${fn.id}::file-context-${slot}`;
  renderDiffRows(
    wrap,
    fn.file,
    [],
    prContext,
    key,
    null,
    sourceLines,
    range,
    slot === 'before' ? CTX_GAP_INITIAL_EDGE_LINES : 0,
    false,
    fileLineOneVA,
    false
  );
  container.appendChild(wrap);
}

/**
 * Renders a function body with clickable call sites and inline expansion.
 * @param {string} pathPrefix - path-based tree key for this block (root:rootId or parentPath/e:caller:idx:callee)
 * @param {Record<string, string[]>} sourceLinesByFile - file path -> full current source lines
 * @param {Record<string, { type: string, oldLineNumber: number | null, newLineNumber: number | null, content: string }[]>} diffLinesByFile
 * @param {Set<string>} filesWithModuleContext - file paths that have module-scope changes
 * @param {Map<string, { moduleChangedRanges?: { start: number, end: number }[], moduleChangedSymbols?: string[] }>} moduleMetaByFile
 * @param {Map<string, string>} moduleContextOwnerByFile - file path -> function id that alone shows module-level strips (empty map ok)
 * @param {{ callerId: string, parentTreeNodeKey: string | null, callerName: string, calleeTreeNodeKey: string } | null} [callSiteReturn]
 * @param {Map<string, string>} canonicalKeyByFunctionId - first DFS tree key per function (matches code cards)
 * @param {Set<string>} flowFnIds - all function ids in the selected flow (for call-site name scan)
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
  moduleContextOwnerByFile,
  calleesByCaller,
  flowFnIds,
  indent,
  pathPrefix,
  prContext,
  callSiteReturn,
  collapsedMode = false,
  canonicalKeyByFunctionId = new Map()
) {
  const { cut: classLineCut, classMeta: enclosingClassMeta } = getEnclosingClassContextForMethod(
    payload,
    fn,
    collapsedMode
  );

  const fileMeta = moduleMetaByFile.get(fn.file);
  const moduleStripHostId = moduleContextOwnerByFile.get(fn.file);
  const showModuleStrips =
    filesWithModuleContext.has(fn.file) &&
    Boolean(fileMeta?.moduleChangedRanges?.length) &&
    moduleStripHostId !== undefined &&
    moduleStripHostId === fn.id;
  let rangesBefore =
    showModuleStrips && fileMeta?.moduleChangedRanges?.length
      ? moduleRangesBeforeFunction(fileMeta.moduleChangedRanges, fn.startLine)
      : [];
  if (classLineCut) {
    rangesBefore = subtractIntervalFromModuleRanges(
      rangesBefore,
      classLineCut.start,
      classLineCut.end
    );
  }
  const rangesAfter =
    showModuleStrips && fileMeta?.moduleChangedRanges?.length
      ? moduleRangesAfterFunction(fileMeta.moduleChangedRanges, fn.endLine)
      : [];

  mountCallSiteReturnBarIfNeeded(container, callSiteReturn);

  /** @type {{ start: number, end: number }[]} */
  let preambleSegs = [];
  /** New-file line 1 already shown in a sibling block above the next mount (gap carets). */
  let fileLineOneVisibleAbove = false;

  if (!collapsedMode) {
    const methodStartMinus1 = Math.max(0, Number(fn.startLine) - 1);
    let preambleEnd = methodStartMinus1;
    if (enclosingClassMeta && fn.kind === 'method') {
      preambleEnd = clampToInt(Number(enclosingClassMeta.startLine) - 1, 0, methodStartMinus1);
    }
    preambleSegs = [];
    if (1 <= preambleEnd) {
      preambleSegs = [{ start: 1, end: preambleEnd }];
      if (rangesBefore.length) {
        for (const m of mergeLineRanges(rangesBefore)) {
          preambleSegs = preambleSegs.flatMap((p) => subtractIntervalFromModuleRanges([p], m.start, m.end));
        }
      }
    }
    mountFileContextAroundFunction(container, fn, sourceLinesByFile, pathPrefix, prContext, 'before', {
      beforeSegments: preambleSegs,
      fileLineOneVisibleAbove
    });
    if (rangesOverlapNewFileLineOne(preambleSegs)) fileLineOneVisibleAbove = true;
  }

  if (rangesBefore.length && fileMeta) {
    mountModuleContextInline(
      container,
      fileMeta,
      rangesBefore,
      fn,
      sourceLinesByFile,
      diffLinesByFile,
      pathPrefix,
      prContext,
      'before',
      false,
      fileLineOneVisibleAbove
    );
    if (rangesOverlapNewFileLineOne(rangesBefore)) fileLineOneVisibleAbove = true;
  }

  if (enclosingClassMeta && fn.kind === 'method' && !collapsedMode) {
    mountEnclosingClassDefinitionInBody(
      container,
      payload,
      enclosingClassMeta,
      fn,
      sourceLinesByFile,
      diffLinesByFile,
      prContext,
      pathPrefix,
      fileLineOneVisibleAbove
    );
    const classStart = Number(enclosingClassMeta.startLine);
    const classEnd = Number(fn.startLine) - 1;
    if (Number.isFinite(classStart) && Number.isFinite(classEnd) && classStart <= 1 && classEnd >= 1) {
      fileLineOneVisibleAbove = true;
    }
  }

  const pathFunctionIds = getPathFunctionIds(pathPrefix);
  const sourceLines = sourceLinesByFile[fn.file] || [];

  if (collapsedMode) {
    const body = document.createElement('div');
    body.className = 'function-body';
    const sigSource = fn.snippet || (fn.kind === 'class' ? `class ${fn.name}:` : `def ${fn.name}(`);
    const sigHtml = highlightPython(sigSource);
    body.innerHTML = `<pre class="code-line"><code class="language-python">${sigHtml}</code></pre>`;
    container.appendChild(body);
    if (rangesAfter.length && fileMeta) {
      mountModuleContextInline(
        container,
        fileMeta,
        rangesAfter,
        fn,
        sourceLinesByFile,
        diffLinesByFile,
        pathPrefix,
        prContext,
        'after',
        false,
        false
      );
    }
    return;
  }

  // If we don't have any source or diff lines for this file/function (e.g. it wasn't in the git diff),
  // still show at least a best-effort function definition line so the block is never empty.
  if (!sourceLines.length && !(diffLinesByFile[fn.file] || []).length) {
    const body = document.createElement('div');
    body.className = 'function-body';
    const sigSource = fn.snippet || (fn.kind === 'class' ? `class ${fn.name}:` : `def ${fn.name}(`);
    const sigHtml = highlightPython(sigSource);
    body.innerHTML = `<pre class="code-line"><code class="language-python">${sigHtml}</code></pre>`;
    container.appendChild(body);
    if (rangesAfter.length && fileMeta) {
      mountModuleContextInline(
        container,
        fileMeta,
        rangesAfter,
        fn,
        sourceLinesByFile,
        diffLinesByFile,
        pathPrefix,
        prContext,
        'after',
        false,
        false
      );
    }
    return;
  }

  const fnDiffLines = buildFunctionDisplayRows(fn, sourceLines, diffLinesByFile[fn.file] || []);
  if (fnDiffLines.length === 0) {
    const body = document.createElement('div');
    body.className = 'function-body';
    const sigSource = fn.snippet || (fn.kind === 'class' ? `class ${fn.name}:` : `def ${fn.name}(`);
    const sigHtml = highlightPython(sigSource);
    body.innerHTML = `<pre class="code-line"><code class="language-python">${sigHtml}</code></pre>`;
    container.appendChild(body);
    if (rangesAfter.length && fileMeta) {
      mountModuleContextInline(
        container,
        fileMeta,
        rangesAfter,
        fn,
        sourceLinesByFile,
        diffLinesByFile,
        pathPrefix,
        prContext,
        'after',
        false,
        false
      );
    }
    return;
  }
  const calleesWithIndex = (calleesByCaller.get(fn.id) || []).sort((a, b) => a.callIndex - b.callIndex);
  const calleesForFind = buildCalleesForFind(calleesWithIndex, payload.functionsById);
  attachCallSitesToRows(fnDiffLines, calleesWithIndex, calleesForFind);
  const rowsToRender = expandContextCollapseRows(
    fnDiffLines,
    fn.changed && fn.changeType !== 'deleted' ? new Set([Number(fn.startLine)]) : null
  );
  markDocstringLines(rowsToRender);

  for (const rowData of rowsToRender) {
    if (rowData.type === 'ctx-collapse') {
      const hiddenRows = rowData.hiddenRows || [];
      const hiddenCount = Number(rowData.lineCount || hiddenRows.length || 0);
      const startLine = Number(rowData.startLine || hiddenRows[0]?.newLineNumber || fn.startLine);
      const endLine = Number(
        rowData.endLine || hiddenRows[hiddenRows.length - 1]?.newLineNumber || fn.endLine
      );
      const scope = `${pathPrefix}::${fn.id}`;
      const stateKey = `${scope}::ctx-gap::${startLine}-${endLine}`;
      const saved = ctxGapRevealByKey.get(stateKey) || {};
      let head = clampToInt(saved.head ?? 0, 0, hiddenCount);
      let tail = clampToInt(saved.tail ?? 0, 0, hiddenCount);
      if (head + tail > hiddenCount) {
        if (head >= hiddenCount) {
          head = hiddenCount;
          tail = 0;
        } else {
          tail = Math.max(0, hiddenCount - head);
        }
      }
      const remain = Math.max(0, hiddenCount - head - tail);
      const hasExpanded = head > 0 || tail > 0;

      function persistAndRerender(nextHead, nextTail) {
        ctxGapRevealByKey.set(stateKey, {
          head: clampToInt(nextHead, 0, hiddenCount),
          tail: clampToInt(nextTail, 0, hiddenCount)
        });
        const codePane = document.getElementById('code-pane');
        if (codePane) renderCodeView(codePane);
      }

      const revealHeadRows = hiddenRows.slice(0, head);
      const revealTailRows = hiddenRows.slice(Math.max(head, hiddenRows.length - tail));
      for (const hr of revealHeadRows) {
        appendFunctionBodyDiffLine(
          container,
          hr,
          indent,
          pathPrefix,
          fn,
          payload,
          uiState,
          pathFunctionIds,
          calleesForFind,
          canonicalKeyByFunctionId
        );
      }

      if (remain > 0) {
        const hiddenStartLine = startLine + head;
        const hiddenEndLine = endLine - tail;
        const expanderHeightPx = CTX_GAP_EXPANDER_HEIGHT_MINIMAL_PX;
        const expanderRow = document.createElement('div');
        expanderRow.className = 'diff-line diff-line-ctx-gap-expander';
        expanderRow.classList.add('diff-line-ctx-gap-expander-minimal');
        expanderRow.style.minHeight = `${expanderHeightPx}px`;
        const gutterA = document.createElement('span');
        gutterA.className = 'diff-num diff-num-ctx diff-num-gap-controls';
        const gutterB = document.createElement('span');
        gutterB.className = 'diff-num diff-num-ctx';
        const sign = document.createElement('span');
        sign.className = 'diff-sign diff-sign-ctx';
        const meta = document.createElement('pre');
        meta.className = 'diff-code diff-code-ctx diff-code-gap-meta';
        const metaCode = document.createElement('code');
        metaCode.className = 'language-python';

        const showAbove = document.createElement('button');
        showAbove.type = 'button';
        showAbove.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--up';
        setGapCaretIcon(showAbove, 'up');
        showAbove.title = `Show ${Math.min(CTX_GAP_REVEAL_CHUNK_LINES, remain)} above`;
        showAbove.setAttribute('aria-label', showAbove.title);
        showAbove.addEventListener('click', () => {
          const n = Math.min(CTX_GAP_REVEAL_CHUNK_LINES, remain);
          persistAndRerender(head, tail + n);
        });

        const showBelow = document.createElement('button');
        showBelow.type = 'button';
        showBelow.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--down';
        setGapCaretIcon(showBelow, 'down');
        showBelow.title = `Show ${Math.min(CTX_GAP_REVEAL_CHUNK_LINES, remain)} below`;
        showBelow.setAttribute('aria-label', showBelow.title);
        showBelow.addEventListener('click', () => {
          const n = Math.min(CTX_GAP_REVEAL_CHUNK_LINES, remain);
          persistAndRerender(head + n, tail);
        });

        const showAll = document.createElement('button');
        showAll.type = 'button';
        showAll.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--all';
        showAll.textContent = '⋯';
        showAll.title = `Show all ${remain} lines`;
        showAll.setAttribute('aria-label', showAll.title);
        showAll.addEventListener('click', () => {
          persistAndRerender(hiddenCount, 0);
        });

        const inlineControls = document.createElement('span');
        inlineControls.className = 'diff-ctx-gap-controls-inline';
        const resetView = document.createElement('button');
        resetView.type = 'button';
        resetView.className = 'diff-ctx-gap-btn diff-ctx-gap-btn--reset';
        resetView.textContent = '↺';
        resetView.title = 'Reset to original view';
        resetView.setAttribute('aria-label', resetView.title);
        resetView.addEventListener('click', () => {
          persistAndRerender(0, 0);
        });
        const hiddenFirstLnBody = Number(hiddenRows[0]?.newLineNumber);
        const suppressBodyCtxCollapseAbove =
          Number.isFinite(hiddenFirstLnBody) &&
          hiddenFirstLnBody <= 1 &&
          (fileLineOneVisibleAbove || Number(fn.startLine) <= 1);
        if (!suppressBodyCtxCollapseAbove) {
          inlineControls.appendChild(showAbove);
        }
        if (remain > CTX_GAP_REVEAL_CHUNK_LINES) inlineControls.appendChild(showAll);
        inlineControls.appendChild(showBelow);
        if (hasExpanded) inlineControls.appendChild(resetView);
        // Rhizome cards: keep this control very minimal — one-line controls + compact count.
        meta.classList.add('diff-code-gap-meta-minimal', 'diff-code-gap-meta-minimal-inline');
        metaCode.textContent = '';
        gutterA.appendChild(inlineControls);
        meta.appendChild(metaCode);
        expanderRow.appendChild(gutterA);
        expanderRow.appendChild(gutterB);
        expanderRow.appendChild(sign);
        expanderRow.appendChild(meta);
        container.appendChild(expanderRow);
      }

      for (const hr of revealTailRows) {
        appendFunctionBodyDiffLine(
          container,
          hr,
          indent,
          pathPrefix,
          fn,
          payload,
          uiState,
          pathFunctionIds,
          calleesForFind,
          canonicalKeyByFunctionId
        );
      }
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
      calleesForFind,
      canonicalKeyByFunctionId
    );
  }

  if (Number(fn.startLine) <= 1 && Number(fn.endLine) >= 1) {
    fileLineOneVisibleAbove = true;
  }

  const fileEndForTail = sourceLines.length;
  const tailStartLine = Number(fn.endLine) + 1;
  /** @type {{ start: number, end: number }[]} */
  let fileAfterSegments = [];
  if (tailStartLine <= fileEndForTail) {
    fileAfterSegments = [{ start: tailStartLine, end: fileEndForTail }];
    if (rangesAfter.length) {
      for (const m of mergeLineRanges(rangesAfter)) {
        fileAfterSegments = fileAfterSegments.flatMap((p) =>
          subtractIntervalFromModuleRanges([p], m.start, m.end)
        );
      }
    }
  }

  const fileLineOneAboveTail = fileLineOneVisibleAbove;

  if (rangesAfter.length && fileMeta) {
    mountModuleContextInline(
      container,
      fileMeta,
      rangesAfter,
      fn,
      sourceLinesByFile,
      diffLinesByFile,
      pathPrefix,
      prContext,
      'after',
      false,
      fileLineOneAboveTail
    );
  }

  if (!collapsedMode) {
    mountFileContextAroundFunction(
      container,
      fn,
      sourceLinesByFile,
      pathPrefix,
      prContext,
      'after',
      { afterSegments: fileAfterSegments, fileLineOneVisibleAbove: fileLineOneAboveTail }
    );
  }
}

/**
 * Indent depth in the rhizome rail (matches flow-tree nesting).
 * @param {string} treeNodeKey
 */
function treeNavDepth(treeNodeKey) {
  if (!treeNodeKey) return 0;
  let d = 0;
  for (const seg of treeNodeKey.split('/')) {
    if (seg.startsWith('e:')) d++;
  }
  return d;
}

/**
 * @param {object} uiState
 * @param {string} calleeTreeNodeKey
 * @param {import('../flowSchema.js').FlowPayload} payload
 */
function callSiteReturnPayloadForCallee(uiState, calleeTreeNodeKey, payload) {
  if (uiState.activeTreeNodeKey !== calleeTreeNodeKey) return null;
  if (!uiState.callSiteCallerTreeNodeKey) return null;
  if (uiState.callSiteReturnConsumedKeys.has(calleeTreeNodeKey)) return null;
  const callerId = getCallerFromTreeNodeKey(calleeTreeNodeKey);
  if (!callerId) return null;
  const callerFn = payload.functionsById[callerId];
  const callerName = getFunctionDisplayName(callerFn) || callerId;
  return {
    callerId,
    parentTreeNodeKey: getParentTreeNodeKey(calleeTreeNodeKey),
    callerName,
    calleeTreeNodeKey
  };
}

/**
 * @param {HTMLElement} block
 * @param {import('../flowSchema.js').FunctionMeta} fn
 * @param {string} treeNodeKey
 */
function mountRhizomeFunctionBlock(
  block,
  fn,
  treeNodeKey,
  payload,
  uiState,
  sourceLinesByFile,
  diffLinesByFile,
  filesWithModuleContext,
  moduleMetaByFile,
  moduleContextOwnerByFile,
  calleesByCaller,
  flowFnIds,
  prContext,
  canonicalKeyByFunctionId,
  collapsedMode
) {
  const changeType = fn.changeType || 'modified';
  const isExactActive = uiState.activeTreeNodeKey === treeNodeKey;
  const isFunctionMatchActive = uiState.activeFunctionId === fn.id && !isExactActive;
  block.className =
    'function-block' +
    (isExactActive ? ' active' : '') +
    (isFunctionMatchActive ? ' function-match-active' : '') +
    (uiState.readFunctionIds?.has(fn.id) ? ' read' : '') +
    (uiState.hoveredTreeNodeKey === treeNodeKey ? ' hovered' : '') +
    (collapsedMode ? ' collapsed' : '');
  block.dataset.treeNodeKey = treeNodeKey;
  block.dataset.functionId = fn.id;
  block.dataset.file = fn.file || '';
  block.dataset.changeType = changeType;

  const header = document.createElement('div');
  header.className = 'function-block-head file-name-header full-file-diff-bar rhizome-file-sticky-header';
  const fileLabel = fn.file || '';

  header.innerHTML = `
    <span class="file-name-header-label full-file-diff-bar-path" title="${escapeHtml(fileLabel)}">${escapeHtml(fileLabel)}</span>
    <span class="function-block-header-controls"></span>
  `;
  const controls = header.querySelector('.function-block-header-controls');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'function-block-toggle-btn';
  toggle.textContent = collapsedMode ? '▸' : '▾';
  toggle.title = collapsedMode ? 'Expand body' : 'Collapse body';
  toggle.setAttribute('aria-expanded', collapsedMode ? 'false' : 'true');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setFunctionCollapsedState(fn.id, !collapsedMode);
  });

  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'function-block-done-btn' + (uiState.readFunctionIds?.has(fn.id) ? ' checked' : '');
  done.textContent = '✓';
  done.title = uiState.readFunctionIds?.has(fn.id) ? 'Mark not done' : 'Mark done';
  done.setAttribute('aria-label', done.title);
  done.addEventListener('click', (e) => {
    e.stopPropagation();
    setFunctionReadState(fn.id);
  });

  const resetView = document.createElement('button');
  resetView.type = 'button';
  resetView.className = 'function-block-reset-view-btn';
  resetView.textContent = '↺';
  resetView.title = 'Reset surrounding view';
  resetView.setAttribute('aria-label', resetView.title);
  resetView.addEventListener('click', (e) => {
    e.stopPropagation();
    const scopePrefix = `${treeNodeKey}::${fn.id}::`;
    const changed = clearCtxGapRevealStateByPrefix(scopePrefix);
    if (changed) {
      const codePane = document.getElementById('code-pane');
      if (codePane) renderCodeView(codePane);
    }
  });

  if (controls) {
    const scopePrefix = `${treeNodeKey}::${fn.id}::`;
    const canResetView = hasCtxGapRevealStateByPrefix(scopePrefix);
    controls.appendChild(toggle);
    if (canResetView) controls.appendChild(resetView);
    controls.appendChild(done);
  }

  const content = document.createElement('div');
  content.className = 'function-block-content';

  block.appendChild(header);

  header.addEventListener('click', () => {
    restoreCallSiteReturnTreeNode(treeNodeKey);
    setActiveFunction(fn.id, treeNodeKey);
  });

  const callReturn = callSiteReturnPayloadForCallee(uiState, treeNodeKey, payload);
  renderFunctionBody(
    content,
    payload,
    uiState,
    fn,
    sourceLinesByFile,
    diffLinesByFile,
    filesWithModuleContext,
    moduleMetaByFile,
    moduleContextOwnerByFile,
    calleesByCaller,
    flowFnIds,
    '',
    treeNodeKey,
    prContext,
    callReturn,
    collapsedMode,
    canonicalKeyByFunctionId
  );
  block.appendChild(content);
}

/**
 * Full-file diff (not split into rhizome function cards) for paths outside the current outline.
 */
function mountFullFileDiffPanel(
  root,
  filePath,
  flowPayload,
  sourceLinesByFile,
  diffLinesByFile,
  prContext
) {
  root.innerHTML = '';
  root.className = 'code-files-root full-file-diff-root';

  const wrap = document.createElement('div');
  wrap.className = 'full-file-diff-wrap';

  const bar = document.createElement('div');
  bar.className = 'full-file-diff-bar';
  const title = document.createElement('div');
  title.className = 'full-file-diff-bar-path';
  title.textContent = filePath;
  title.title = filePath;
  bar.appendChild(title);

  const scopePrefix = `full-file::${filePath}::`;
  if (hasCtxGapRevealStateByPrefix(scopePrefix)) {
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'full-file-diff-reset-view-btn';
    resetBtn.textContent = '↺';
    resetBtn.title = 'Reset surrounding view';
    resetBtn.setAttribute('aria-label', resetBtn.title);
    resetBtn.addEventListener('click', () => {
      const changed = clearCtxGapRevealStateByPrefix(scopePrefix);
      if (!changed) return;
      const codePane = document.getElementById('code-pane');
      if (codePane) renderCodeView(codePane);
    });
    bar.appendChild(resetBtn);
  }

  const body = document.createElement('div');
  body.className = 'full-file-diff-body';
  const sourceLines = sourceLinesByFile[filePath] || [];
  let rows = diffLinesByFile[filePath] || [];
  rows = includeChangedFunctionDefinitions(filePath, rows, flowPayload.functionsById, sourceLines);
  renderDiffRows(
    body,
    filePath,
    rows,
    prContext,
    `full-file::${filePath}`,
    null,
    sourceLines,
    { startLine: 1, endLine: sourceLines.length }
  );

  wrap.appendChild(bar);
  wrap.appendChild(body);
  root.appendChild(wrap);
}

export function renderCodeView(container) {
  const prevScroller = container.querySelector('.code-pane-content');
  if (prevScroller) {
    codePaneScrollTop = prevScroller.scrollTop;
    codePaneScrollLeft = prevScroller.scrollLeft;
  }
  const { flowPayload, uiState, prContext } = getState();
  if (
    callSiteReturnHighlightSpec &&
    uiState.activeTreeNodeKey !== callSiteReturnHighlightSpec.callerTreeNodeKey
  ) {
    clearPersistentCallSiteReturnHighlight();
  }
  container.innerHTML = '';

  if (!flowPayload.files?.length) {
    container.textContent = 'Enter a PR URL and click Go.';
    return;
  }

  const selectedFlow = flowPayload.flows?.find((f) => f.id === uiState.selectedFlowId) || null;
  const standaloneClasses = (flowPayload.standaloneClassIds || [])
    .map((id) => flowPayload.functionsById[id])
    .filter(Boolean)
    .sort((a, b) => {
      const fa = String(a.file || '');
      const fb = String(b.file || '');
      if (fa !== fb) return filePathSort(fa, fb);
      if ((a.startLine || 0) !== (b.startLine || 0)) return (a.startLine || 0) - (b.startLine || 0);
      return String(a.id).localeCompare(String(b.id));
    });
  const showStandaloneClasses = !selectedFlow?.rootId && standaloneClasses.length > 0;
  if ((!selectedFlow?.rootId || !flowPayload.functionsById[selectedFlow.rootId]) && !showStandaloneClasses) {
    container.textContent = 'No flow to show.';
    return;
  }

  const rhizomeViewKey = selectedFlow
    ? `${prContext?.headSha ?? ''}::${selectedFlow.id}`
    : `${prContext?.headSha ?? ''}::standalone-classes`;

  const sourceLinesByFile = {};
  const diffLinesByFile = {};
  for (const file of flowPayload.files) {
    sourceLinesByFile[file.path] = file.sourceLines || [];
    diffLinesByFile[file.path] = buildDiffLines(file.hunks || []);
  }

  const flowFnIds = selectedFlow
    ? getFlowFunctionIds(selectedFlow, flowPayload)
    : new Set(standaloneClasses.map((fn) => fn.id));
  const rhizomeOrderRaw = selectedFlow
    ? collectFlowOrder(selectedFlow.rootId, flowPayload)
    : standaloneClasses.map((fn) => ({
        treeNodeKey: `standalone-class:${fn.id}`,
        functionId: fn.id
      }));
  const rhizomeOrder = filterNestedFunctionCards(rhizomeOrderRaw, flowPayload);
  const canonicalKeyByFunctionId = new Map();
  for (const { treeNodeKey, functionId } of rhizomeOrder) {
    if (!canonicalKeyByFunctionId.has(functionId)) canonicalKeyByFunctionId.set(functionId, treeNodeKey);
  }

  const unionFlowFnIds = collectUnionFlowFunctionIds(flowPayload);
  if (!selectedFlow?.rootId) {
    for (const cls of standaloneClasses) unionFlowFnIds.add(cls.id);
  }
  const rhizomeFilePaths = rhizomeParticipatingFilePathNorms(flowPayload, unionFlowFnIds);
  const selectedFlowFileNorms = rhizomeParticipatingFilePathNorms(flowPayload, flowFnIds);
  const outsideRequested = uiState.codePaneOutsideDiffPath;
  const normRequested = outsideRequested ? normalizeNavFilePath(outsideRequested) : '';
  const fileMetaForOutside =
    normRequested && flowPayload.files?.find((f) => normalizeNavFilePath(f.path) === normRequested);
  // Full-file pane only when the path is not part of the *selected* flow outline (includes
  // “never in any flow” and “in another flow but not this one”).
  const effectiveOutside =
    outsideRequested &&
    fileMetaForOutside &&
    !selectedFlowFileNorms.has(normalizeNavFilePath(fileMetaForOutside.path))
      ? fileMetaForOutside.path
      : null;

  const paneResetKey = `${rhizomeViewKey}::${effectiveOutside ?? ''}`;
  if (paneResetKey !== lastRhizomeCodeViewKey) {
    lastRhizomeCodeViewKey = paneResetKey;
    lastScrolledToActiveKey = null;
    codePaneScrollTop = 0;
    codePaneScrollLeft = 0;
    ctxGapRevealByKey = new Map();
  }

  const calleesByCaller = new Map();
  for (const e of flowPayload.edges || []) {
    if (!flowFnIds.has(e.callerId) || !flowFnIds.has(e.calleeId)) continue;
    const list = calleesByCaller.get(e.callerId) || [];
    list.push({ calleeId: e.calleeId, callIndex: e.callIndex });
    calleesByCaller.set(e.callerId, list);
  }

  const moduleMetaByFile = new Map();
  const filesWithModuleContext = new Set();
  for (const file of flowPayload.files || []) {
    if (file.moduleChangedRanges?.length) {
      filesWithModuleContext.add(file.path);
      moduleMetaByFile.set(file.path, {
        moduleChangedRanges: file.moduleChangedRanges,
        moduleChangedSymbols: file.moduleChangedSymbols || []
      });
    }
  }

  /** @type {Map<string, string>} */
  const moduleContextOwnerByFile = new Map();
  for (const filePath of filesWithModuleContext) {
    const meta = moduleMetaByFile.get(filePath);
    if (!meta?.moduleChangedRanges?.length) continue;
    const lines = sourceLinesByFile[filePath] || [];
    const candidates = Object.values(flowPayload.functionsById).filter(
      (f) =>
        f &&
        f.file === filePath &&
        ['function', 'method', 'class'].includes(f.kind || 'function') &&
        f.changeType !== 'deleted'
    );
    if (!candidates.length) continue;
    const winner = pickModuleContextHostFunctionId({
      candidates,
      moduleChangedRanges: meta.moduleChangedRanges,
      moduleChangedSymbols: meta.moduleChangedSymbols || [],
      sourceLines: lines,
      payload: flowPayload,
      flows: flowPayload.flows || [],
      selectedFlow
    });
    if (winner) moduleContextOwnerByFile.set(filePath, winner);
  }

  const contentShell = document.createElement('div');
  contentShell.className = 'code-pane-shell';
  const filesNav = document.createElement('aside');
  filesNav.className = 'code-files-nav';
  filesNav.style.width = `${clampFilesNavWidth(filesNavWidthPx)}px`;
  const filesNavResizer = document.createElement('div');
  filesNavResizer.className = 'code-files-nav-resizer';
  filesNavResizer.title = 'Drag to resize outline panel';
  filesNavResizer.setAttribute('role', 'separator');
  filesNavResizer.setAttribute('aria-orientation', 'vertical');
  const contentScroller = document.createElement('div');
  contentScroller.className = 'code-pane-content';
  const filesPanelToggleBtn = document.createElement('button');
  filesPanelToggleBtn.type = 'button';
  filesPanelToggleBtn.className = 'code-files-nav-toggle-btn';
  const rhizomeRoot = document.createElement('div');
  rhizomeRoot.className = 'code-files-root rhizome-code-root';

  const navTitle = document.createElement('div');
  navTitle.className = 'code-files-nav-title';
  const activeFnFromSelection = flowPayload.functionsById[uiState.activeFunctionId];
  const allChangedFiles = (flowPayload.files || []).map((f) => f.path).filter(Boolean).sort(filePathSort);
  const otherChangedCount = allChangedFiles.filter((p) => !rhizomeFilePaths.has(normalizeNavFilePath(p))).length;
  const hasOutsideRhizome = otherChangedCount > 0;
  const activeFile = uiState.selectedFileInFlow || activeFnFromSelection?.file || null;
  const navTitleText = document.createElement('div');
  navTitleText.className = 'code-files-nav-rhizome-title';
  navTitleText.innerHTML = `<span class="code-files-nav-rhizome-kicker">Files</span>`;
  const navTitleName = document.createElement('div');
  navTitleName.className = 'code-files-nav-rhizome-name';
  navTitleName.textContent = `${allChangedFiles.length} files`;
  navTitleName.title =
    'Flow files: path touches at least one node in any flow in this PR (sort first). Muted: never in any flow; click for full file diff.';
  const titleStack = document.createElement('div');
  titleStack.className = 'code-files-nav-title-stack';
  titleStack.appendChild(navTitleText);
  titleStack.appendChild(navTitleName);
  navTitle.appendChild(titleStack);
  navTitle.appendChild(filesPanelToggleBtn);
  filesNav.appendChild(navTitle);

  const filterWrap = document.createElement('div');
  filterWrap.className = 'code-files-nav-filter-wrap';
  filterWrap.innerHTML = `
    <span class="code-files-nav-filter-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
        <path d="M10.68 11.74a6 6 0 1 1 1.06-1.06l3.27 3.27a.75.75 0 1 1-1.06 1.06l-3.27-3.27ZM11 7a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0Z"></path>
      </svg>
    </span>
    <input type="search" class="code-files-nav-filter-input" placeholder="Filter files..." aria-label="Filter files" />
  `;
  filesNav.appendChild(filterWrap);
  const navTree = document.createElement('div');
  navTree.className = 'code-files-nav-tree';

  function scrollToFile(filePath) {
    setSelectedFileInFlow(filePath);
    const norm = normalizeNavFilePath(filePath);
    const inSomeRhizome = rhizomeFilePaths.has(norm);
    const firstInSelectedFlow = rhizomeOrder.find(
      ({ functionId }) => normalizeNavFilePath(flowPayload.functionsById[functionId]?.file || '') === norm
    );
    if (inSomeRhizome && firstInSelectedFlow) {
      setCodePaneOutsideDiffPath(null);
      const fn = flowPayload.functionsById[firstInSelectedFlow.functionId];
      if (fn) {
        restoreCallSiteReturnTreeNode(firstInSelectedFlow.treeNodeKey);
        setActiveFunction(fn.id, firstInSelectedFlow.treeNodeKey);
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const scroller = document.querySelector('#code-pane .code-pane-content');
          if (!scroller) return;
          const hit = flowPayload.files?.find((f) => normalizeNavFilePath(f.path) === norm);
          const canonical = hit?.path ?? filePath;
          const target = scroller.querySelector(`.function-block[data-file="${CSS.escape(canonical)}"]`);
          if (target) scrollToVerticalCenter(scroller, target, { behavior: 'smooth' });
        });
      });
    } else {
      const hit = flowPayload.files?.find((f) => normalizeNavFilePath(f.path) === norm);
      setCodePaneOutsideDiffPath(hit?.path ?? filePath);
    }
  }

  const filterInput = filterWrap.querySelector('.code-files-nav-filter-input');

  const rootNode = { folders: new Map(), files: [] };
  for (const filePath of allChangedFiles) {
    const parts = pathParts(filePath);
    if (parts.length === 0) continue;
    let node = rootNode;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push(filePath);
  }

  function hasVisibleDescendant(node, filterText) {
    if (!filterText) return true;
    if (node.files.some((filePath) => filePath.toLowerCase().includes(filterText))) return true;
    return [...node.folders.values()].some((child) => hasVisibleDescendant(child, filterText));
  }

  /** Set in `rerenderNavTree` so file rows can reflect outside-diff vs rhizome selection without a full pane rebuild. */
  let navOutsideDiffPath = null;
  let navActiveMethodFile = null;

  function renderTree(parentEl, node, depth = 0, filterText = '', parentPath = '') {
    const folderEntries = [...node.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [folderName, childNode] of folderEntries) {
      let compactLabel = folderName;
      let folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      let compactNode = childNode;
      while (compactNode.files.length === 0 && compactNode.folders.size === 1) {
        const [nextName, nextNode] = [...compactNode.folders.entries()][0];
        compactLabel += `/${nextName}`;
        folderPath += `/${nextName}`;
        compactNode = nextNode;
      }
      if (!hasVisibleDescendant(compactNode, filterText)) continue;
      const details = document.createElement('details');
      details.className = 'code-files-nav-folder';
      if (!filesNavFolderStateInitialized && !filesNavFolderOpenState.has(folderPath)) {
        filesNavFolderOpenState.set(folderPath, true);
      }
      details.open = filesNavFolderOpenState.get(folderPath) ?? true;
      const summary = document.createElement('summary');
      summary.className = 'code-files-nav-folder-row';
      summary.style.paddingLeft = `${depth * 14 + 8}px`;
      summary.innerHTML = `
        <span class="code-files-nav-folder-caret" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M12.78 5.22a.75.75 0 0 1 0 1.06L8.53 10.53a.75.75 0 0 1-1.06 0L3.22 6.28a.75.75 0 1 1 1.06-1.06L8 8.94l3.72-3.72a.75.75 0 0 1 1.06 0Z"></path></svg>
        </span>
        <span class="code-files-nav-folder-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1.75 2A1.75 1.75 0 0 0 0 3.75v8.5C0 13.216.784 14 1.75 14h12.5A1.75 1.75 0 0 0 16 12.25v-7.5A1.75 1.75 0 0 0 14.25 3H8.06l-.97-1.21A1.75 1.75 0 0 0 5.72 1H1.75ZM1.5 3.75a.25.25 0 0 1 .25-.25h3.97a.25.25 0 0 1 .2.095l1.37 1.71a.75.75 0 0 0 .59.28h6.37a.25.25 0 0 1 .25.25v6.42a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25v-8.5Z"></path></svg>
        </span>
        <span class="code-files-nav-folder-name">${escapeHtml(compactLabel)}</span>
      `;
      details.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'code-files-nav-folder-body';
      renderTree(body, compactNode, depth + 1, filterText, folderPath);
      details.appendChild(body);
      details.addEventListener('toggle', () => {
        filesNavFolderOpenState.set(folderPath, details.open);
      });
      parentEl.appendChild(details);
    }

    const files = [...node.files].sort((a, b) => {
      const aIn = rhizomeFilePaths.has(normalizeNavFilePath(a));
      const bIn = rhizomeFilePaths.has(normalizeNavFilePath(b));
      if (aIn !== bIn) return aIn ? -1 : 1;
      return filePathSort(a, b);
    });
    for (const filePath of files) {
      if (filterText && !filePath.toLowerCase().includes(filterText)) continue;
      const inRhizome = rhizomeFilePaths.has(normalizeNavFilePath(filePath));
      const navItem = document.createElement(inRhizome ? 'div' : 'button');
      if (!inRhizome) navItem.type = 'button';
      navItem.className =
        'code-files-nav-item' +
        (inRhizome ? ' code-files-nav-item--rhizome-readonly' : '') +
        (!inRhizome && hasOutsideRhizome ? ' code-files-nav-item--outside-rhizome' : '');
      const showingOutside = Boolean(navOutsideDiffPath);
      const isShownFileRow =
        showingOutside &&
        navOutsideDiffPath &&
        normalizeNavFilePath(navOutsideDiffPath) === normalizeNavFilePath(filePath);
      const isRhizomeContextRow =
        !showingOutside &&
        inRhizome &&
        activeFile &&
        normalizeNavFilePath(activeFile) === normalizeNavFilePath(filePath);
      if (isShownFileRow || isRhizomeContextRow) navItem.classList.add('active');
      navItem.style.paddingLeft = `${depth * 14 + 30}px`;
      navItem.title = inRhizome
        ? `${filePath} — in this flow (view via flow tree)`
        : `${filePath} — full file diff (not in this outline)`;
      const { added: diffAdded, deleted: diffDeleted } = diffLineAddDelCounts(diffLinesByFile[filePath] || []);
      const diffStatsTitle =
        diffAdded || diffDeleted
          ? `Diff in this file: +${diffAdded} / -${diffDeleted}`
          : '';
      const diffStatsHtml =
        diffAdded || diffDeleted
          ? `<span class="code-files-nav-count" title="${escapeHtml(diffStatsTitle)}">` +
            `<span class="code-files-nav-count-add">+${diffAdded}</span>` +
            `<span class="code-files-nav-count-del">-${diffDeleted}</span>` +
            `</span>`
          : '';
      if (diffStatsTitle) navItem.title = `${navItem.title}. ${diffStatsTitle}`;
      navItem.innerHTML = `
        <span class="code-files-nav-file-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M2.75 1h5.5c.464 0 .909.184 1.237.513l3 3c.329.328.513.773.513 1.237v7.5A1.75 1.75 0 0 1 11.25 15h-8.5A1.75 1.75 0 0 1 1 13.25v-10.5C1 1.784 1.784 1 2.75 1Zm5.5 1.5h-5.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V2.5h.25Zm1.25.31V4.25c0 .138.112.25.25.25h1.44L9.5 2.81Z"></path><path d="M8 8.25a.75.75 0 0 1 .75.75v.75h.75a.75.75 0 0 1 0 1.5h-.75V12a.75.75 0 0 1-1.5 0v-.75H6.5a.75.75 0 0 1 0-1.5h.75V9A.75.75 0 0 1 8 8.25Z"></path></svg>
        </span>
        <span class="code-files-nav-name">${escapeHtml(toBaseName(filePath))}</span>${diffStatsHtml}
      `;
      if (!inRhizome) navItem.addEventListener('click', () => scrollToFile(filePath));
      parentEl.appendChild(navItem);
    }
  }

  function rerenderNavTree() {
    const filterText = (filterInput?.value || '').trim().toLowerCase();
    const u = getState().uiState;
    navOutsideDiffPath = u.codePaneOutsideDiffPath;
    navActiveMethodFile = u.activeFunctionId ? flowPayload.functionsById[u.activeFunctionId]?.file : null;
    navTree.innerHTML = '';
    renderTree(navTree, rootNode, 0, filterText, '');
    if (!navTree.querySelector('.code-files-nav-item')) {
      navTree.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'code-files-nav-empty';
      empty.textContent = 'No matching files';
      navTree.appendChild(empty);
    }
  }
  filterInput?.addEventListener('input', rerenderNavTree);
  rerenderNavTree();
  filesNavFolderStateInitialized = true;
  filesNav.appendChild(navTree);

  filesNavResizer.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const shellRect = contentShell.getBoundingClientRect();
    const shellLeft = shellRect.left;
    const shellWidth = shellRect.width;
    const minW = FILES_NAV_WIDTH_MIN;
    const maxW = Math.min(FILES_NAV_WIDTH_MAX, Math.max(minW, shellWidth - 220));
    document.body.classList.add('is-resizing-code-files-nav');
    function onMove(e) {
      const next = clampFilesNavWidth(e.clientX - shellLeft);
      const bounded = Math.max(minW, Math.min(maxW, next));
      filesNavWidthPx = bounded;
      filesNav.style.width = `${bounded}px`;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('is-resizing-code-files-nav');
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function applyFilesNavCollapsed(collapsed) {
    filesNavCollapsed = collapsed;
    filesNav.classList.toggle('code-files-nav-collapsed', collapsed);
    if (collapsed) {
      savedFilesNavWidthPx = clampFilesNavWidth(filesNav.getBoundingClientRect().width || filesNavWidthPx);
      filesNav.style.width = '44px';
    } else {
      filesNavWidthPx = clampFilesNavWidth(savedFilesNavWidthPx || filesNavWidthPx);
      filesNav.style.width = `${filesNavWidthPx}px`;
    }
    filesNavResizer.style.display = collapsed ? 'none' : '';
    filesPanelToggleBtn.innerHTML = collapsed
      ? `
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path>
        </svg>
      `
      : `
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z"></path>
        </svg>
      `;
    filesPanelToggleBtn.title = collapsed ? 'Show file panel' : 'Hide file panel';
    filesPanelToggleBtn.setAttribute('aria-label', collapsed ? 'Show file panel' : 'Hide file panel');
    filesPanelToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  filesPanelToggleBtn.addEventListener('click', () => {
    applyFilesNavCollapsed(!filesNavCollapsed);
  });
  applyFilesNavCollapsed(filesNavCollapsed);

  if (effectiveOutside) {
    mountFullFileDiffPanel(
      rhizomeRoot,
      effectiveOutside,
      flowPayload,
      sourceLinesByFile,
      diffLinesByFile,
      prContext
    );
  } else {
    rhizomeRoot.className = 'code-files-root rhizome-code-root';
    for (const { treeNodeKey, functionId } of rhizomeOrder) {
      const fn = flowPayload.functionsById[functionId];
      if (!fn) continue;
      const collapsedMode = uiState.collapsedFunctionIds.has(fn.id);
      const block = document.createElement('div');
      mountRhizomeFunctionBlock(
        block,
        fn,
        treeNodeKey,
        flowPayload,
        uiState,
        sourceLinesByFile,
        diffLinesByFile,
        filesWithModuleContext,
        moduleMetaByFile,
        moduleContextOwnerByFile,
        calleesByCaller,
        flowFnIds,
        prContext,
        canonicalKeyByFunctionId,
        collapsedMode
      );
      rhizomeRoot.appendChild(block);
    }
  }

  contentScroller.appendChild(rhizomeRoot);
  contentShell.appendChild(filesNav);
  contentShell.appendChild(filesNavResizer);
  contentShell.appendChild(contentScroller);
  container.appendChild(contentShell);
  contentScroller.scrollTop = codePaneScrollTop;
  contentScroller.scrollLeft = codePaneScrollLeft;

  const rawActiveKey =
    uiState.activeTreeNodeKey ||
    (uiState.activeFunctionId ? canonicalKeyByFunctionId.get(uiState.activeFunctionId) : null);
  const scrollTargetKey =
    rawActiveKey && !String(rawActiveKey).startsWith('flow:') ? rawActiveKey : null;
  const nextScrollKey = scrollTargetKey ? `node:${scrollTargetKey}` : null;
  const autoScrollSuppressed = Date.now() < suppressAutoScrollUntil;

  contentScroller.querySelectorAll('.diff-line-function-target').forEach((el) => {
    el.classList.remove('diff-line-function-target');
  });

  if (
    !effectiveOutside &&
    !autoScrollSuppressed &&
    nextScrollKey &&
    nextScrollKey !== lastScrolledToActiveKey
  ) {
    const block = contentScroller.querySelector(
      `.function-block[data-tree-node-key="${CSS.escape(scrollTargetKey)}"]`
    );
    if (block) {
      lastScrolledToActiveKey = nextScrollKey;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const behavior = preferSmoothScrollForNextActiveSelection ? 'smooth' : 'auto';
          preferSmoothScrollForNextActiveSelection = false;
          scrollToVerticalCenter(contentScroller, block, { behavior });
          setInViewTreeNodeKey(scrollTargetKey);
        });
      });
    }
  }
  if (!nextScrollKey || effectiveOutside) {
    lastScrolledToActiveKey = null;
    preferSmoothScrollForNextActiveSelection = false;
  }

  if (!contentScroller.dataset.scrollLinked) {
    contentScroller.dataset.scrollLinked = '1';
    let scrollRaf = 0;
    contentScroller.addEventListener(
      'scroll',
      () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0;
          updateInViewFromScroll(contentScroller);
        });
      },
      { passive: true }
    );
    requestAnimationFrame(() => updateInViewFromScroll(contentScroller));
  }

  const returnTarget = uiState.callSiteReturnScrollTarget;
  const returnTargetCallerId = returnTarget
    ? getFunctionIdFromTreeNodeKey(returnTarget.callerTreeNodeKey)
    : null;
  // Only apply "return to call site" scroll when the caller card is active.
  // This prevents forward callee navigation from immediately jumping back to the call site line.
  if (
    returnTarget &&
    returnTargetCallerId &&
    uiState.activeFunctionId === returnTargetCallerId &&
    applyCallSiteReturnScroll(contentScroller, returnTarget)
  ) {
    clearCallSiteReturnScrollTarget();
  }

  reapplyCallSiteReturnHighlight(contentScroller);
}

/**
 * Updates hover-only classes without rebuilding the pane (used when store notifies for pointer sync).
 * @param {HTMLElement | null} codePane - `#code-pane`
 */
export function syncCodePanePointerStyles(codePane) {
  const root = codePane?.querySelector?.('.code-pane-content');
  if (!root) return;
  const { uiState } = getState();
  const hoverKey = uiState.hoveredTreeNodeKey;

  for (const el of root.querySelectorAll('.function-block.hovered')) {
    el.classList.remove('hovered');
  }
  if (hoverKey) {
    root
      .querySelector(`.function-block[data-tree-node-key="${CSS.escape(hoverKey)}"]`)
      ?.classList.add('hovered');
  }

  for (const el of root.querySelectorAll('.call-site.hovered')) {
    el.classList.remove('hovered');
  }
  if (hoverKey) {
    for (const el of root.querySelectorAll('.call-site[data-tree-node-key]')) {
      if (el.dataset.treeNodeKey === hoverKey) el.classList.add('hovered');
    }
  }
}
