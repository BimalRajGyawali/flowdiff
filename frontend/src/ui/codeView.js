/**
 * Code view pane: shows all functions of the selected flow in flow-tree order.
 * No inline expansion; call-site and flow-tree clicks navigate (scroll to + highlight) the function block.
 */

import {
  getState,
  setActiveFunctionFromInlineCallSite,
  returnFromCallSiteToCaller,
  restoreCallSiteReturnTreeNode,
  clearCallSiteReturnScrollTarget,
  setInViewTreeNodeKey,
  setSelectedFileInFlow,
  setFunctionReadState,
  setFunctionCollapsedState,
  setHoveredTreeNodeKey
} from '../state/store.js';
import { normalizeMergedPatchDiffLines } from '../parser/mergeDiffArtifacts.js';
import { getFunctionDisplayName } from '../parser/functionDisplayName.js';

let lastScrolledToActiveKey = null;
let scrollRAF = null;
let moduleContextExpandedKeys = new Set();
/** Expanded "unchanged lines" collapse toggles; survives scroll-driven re-renders. */
let ctxCollapseExpandedKeys = new Set();
let moduleContextFlowId = null;
let filesNavWidthPx = 260;
const FILES_NAV_WIDTH_MIN = 190;
const FILES_NAV_WIDTH_MAX = 520;
let filesNavFolderOpenState = new Map();
let filesNavFolderStateInitialized = false;
let codePaneScrollTop = 0;
let codePaneScrollLeft = 0;

/**
 * Return-to-call-site highlight must survive `innerHTML` rebuilds (scroll / in-view updates re-render).
 * @type {null | { callerTreeNodeKey: string, scrollLine: number, lineKind: string, calleeId: string, calleeOrdinalOnLine: number, expireAt: number }}
 */
let callSiteReturnHighlightSpec = null;
let callSiteReturnHighlightTimer = 0;

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
  if (calleeNavKey) restoreCallSiteReturnTreeNode(calleeNavKey);
  const meta = diffLineScrollMeta(rowData);
  const returnScroll =
    meta && callerPathPrefix ? { ...meta, calleeId, calleeOrdinalOnLine } : null;
  setActiveFunctionFromInlineCallSite(calleeId, calleeNavKey || null, callerPathPrefix, returnScroll);
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
 * Names to scan for in each line: edge callees first (for callIndex alignment), then any other
 * in-flow function so links appear even when the global edge list missed a call (regex / name ambiguity).
 * @param {{ calleeId: string, callIndex: number }[]} calleesWithIndex
 * @param {string} callerFnId
 * @param {Set<string>} flowFnIds
 * @param {Record<string, import('../flowSchema.js').FunctionMeta>} functionsById
 */
function buildCalleesForFind(calleesWithIndex, callerFnId, flowFnIds, functionsById) {
  const map = new Map();
  for (const { calleeId } of calleesWithIndex) {
    const meta = functionsById[calleeId];
    if (meta?.name) map.set(calleeId, { calleeId, name: meta.name });
  }
  for (const id of flowFnIds) {
    if (id === callerFnId || map.has(id)) continue;
    const meta = functionsById[id];
    if (meta?.name) map.set(id, { calleeId: id, name: meta.name });
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

function buildRangeDisplayRows(ranges, sourceLines, diffLines, excludedLineNumbers = new Set()) {
  if (!ranges?.length) return [];
  const inRange = (n) => ranges.some((r) => n >= r.start && n <= r.end);

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
  for (const r of ranges) {
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

function toBaseName(path) {
  return String(path || '').replace(/^.*\//, '');
}

function pathParts(path) {
  return String(path || '').split('/').filter(Boolean);
}

function filePathSort(a, b) {
  return String(a).localeCompare(String(b));
}

function clampFilesNavWidth(widthPx) {
  return Math.max(FILES_NAV_WIDTH_MIN, Math.min(FILES_NAV_WIDTH_MAX, widthPx));
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
  /** Same source range must not be claimed by multiple callees that share a short `name`. */
  const claimed = new Set();
  for (const { calleeId, name } of callees) {
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(line)) !== null) {
      const start = m.index;
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
    lineHtml = highlightPython(lineWithPlaceholders);

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
 * @param {{ callerId: string, parentTreeNodeKey: string | null, callerName: string, calleeTreeNodeKey: string } | null} [callSiteReturn]
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
  const showFileName = slot !== 'after';
  ctx.innerHTML = `
    <div class="module-context-header">
      <button type="button" class="module-context-toggle" aria-expanded="false" aria-controls="${escapeHtml(ctxId)}" title="${escapeHtml(titleText)}">${escapeHtml(buttonLabel)}</button>
      ${showFileName ? `<span class="module-context-file">${escapeHtml(baseName)}</span>` : ''}
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
  calleesByCaller,
  flowFnIds,
  indent,
  pathPrefix,
  prContext,
  callSiteReturn,
  collapsedMode = false,
  canonicalKeyByFunctionId = new Map()
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

  if (collapsedMode) {
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
  if (fnDiffLines.length === 0) {
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
  const calleesWithIndex = (calleesByCaller.get(fn.id) || []).sort((a, b) => a.callIndex - b.callIndex);
  const calleesForFind = buildCalleesForFind(calleesWithIndex, fn.id, flowFnIds, payload.functionsById);
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
          calleesForFind,
          canonicalKeyByFunctionId
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
      calleesForFind,
      canonicalKeyByFunctionId
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
  /** First DFS key per function — matches each `.function-block[data-tree-node-key]`. */
  const canonicalKeyByFunctionId = new Map(
    flowOrder.map(({ functionId, treeNodeKey }) => [functionId, treeNodeKey])
  );
  const contentShell = document.createElement('div');
  contentShell.className = 'code-pane-shell';
  const filesNav = document.createElement('aside');
  filesNav.className = 'code-files-nav';
  filesNav.style.width = `${clampFilesNavWidth(filesNavWidthPx)}px`;
  const filesNavResizer = document.createElement('div');
  filesNavResizer.className = 'code-files-nav-resizer';
  filesNavResizer.title = 'Drag to resize files panel';
  filesNavResizer.setAttribute('role', 'separator');
  filesNavResizer.setAttribute('aria-orientation', 'vertical');
  const contentScroller = document.createElement('div');
  contentScroller.className = 'code-pane-content';
  const fileSection = document.createElement('div');
  fileSection.className = 'file-section';

  const fileFnCount = new Map();
  for (const { treeNodeKey, functionId } of flowOrder) {
    const fn = flowPayload.functionsById[functionId];
    if (!fn?.file) continue;
    fileFnCount.set(fn.file, (fileFnCount.get(fn.file) || 0) + 1);
  }

  const activeFnFromSelection = flowPayload.functionsById[uiState.activeFunctionId];
  const activeFile = uiState.selectedFileInFlow || activeFnFromSelection?.file || null;
  const changedFiles = (flowPayload.files || []).map((f) => f.path).filter(Boolean).sort(filePathSort);
  const navTitle = document.createElement('div');
  navTitle.className = 'code-files-nav-title';
  navTitle.textContent = `Files changed (${changedFiles.length})`;
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

  const rootNode = { folders: new Map(), files: [] };
  for (const filePath of changedFiles) {
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

  function scrollToFile(filePath) {
    setSelectedFileInFlow(filePath);
    const target = contentScroller.querySelector(
      `.function-block[data-file="${CSS.escape(filePath)}"]`
    );
    if (target) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToVerticalCenter(contentScroller, target));
      });
    }
  }

  function hasVisibleDescendant(node, filterText) {
    if (!filterText) return true;
    if (node.files.some((filePath) => filePath.toLowerCase().includes(filterText))) return true;
    return [...node.folders.values()].some((child) => hasVisibleDescendant(child, filterText));
  }

  function renderTree(parentEl, node, depth = 0, filterText = '', parentPath = '') {
    const folderEntries = [...node.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [folderName, childNode] of folderEntries) {
      if (!hasVisibleDescendant(childNode, filterText)) continue;
      const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
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
        <span class="code-files-nav-folder-name">${escapeHtml(folderName)}</span>
      `;
      details.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'code-files-nav-folder-body';
      renderTree(body, childNode, depth + 1, filterText, folderPath);
      details.appendChild(body);
      details.addEventListener('toggle', () => {
        filesNavFolderOpenState.set(folderPath, details.open);
      });
      parentEl.appendChild(details);
    }

    const files = [...node.files].sort(filePathSort);
    for (const filePath of files) {
      if (filterText && !filePath.toLowerCase().includes(filterText)) continue;
      const navItem = document.createElement('button');
      navItem.type = 'button';
      navItem.className = 'code-files-nav-item';
      if (activeFile && activeFile === filePath) navItem.classList.add('active');
      navItem.style.paddingLeft = `${depth * 14 + 30}px`;
      navItem.title = filePath;
      navItem.innerHTML = `
        <span class="code-files-nav-file-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M2.75 1h5.5c.464 0 .909.184 1.237.513l3 3c.329.328.513.773.513 1.237v7.5A1.75 1.75 0 0 1 11.25 15h-8.5A1.75 1.75 0 0 1 1 13.25v-10.5C1 1.784 1.784 1 2.75 1Zm5.5 1.5h-5.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V2.5h.25Zm1.25.31V4.25c0 .138.112.25.25.25h1.44L9.5 2.81Z"></path><path d="M8 8.25a.75.75 0 0 1 .75.75v.75h.75a.75.75 0 0 1 0 1.5h-.75V12a.75.75 0 0 1-1.5 0v-.75H6.5a.75.75 0 0 1 0-1.5h.75V9A.75.75 0 0 1 8 8.25Z"></path></svg>
        </span>
        <span class="code-files-nav-name">${escapeHtml(toBaseName(filePath))}</span>
        <span class="code-files-nav-count">${fileFnCount.get(filePath) || 0}</span>
      `;
      navItem.addEventListener('click', () => scrollToFile(filePath));
      parentEl.appendChild(navItem);
    }
  }

  const filterInput = filterWrap.querySelector('.code-files-nav-filter-input');
  function rerenderNavTree() {
    const filterText = (filterInput?.value || '').trim().toLowerCase();
    navTree.innerHTML = '';
    renderTree(navTree, rootNode, 0, filterText, '');
    if (!navTree.childElementCount) {
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
    content.className = 'function-block-content';
    block.appendChild(content);

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

    // Always derive the caller from this card's flow path. There is one code card per function
    // (first DFS occurrence); mixing in activeTreeNodeKey caused null/mismatch when selection
    // state and the card key diverged, so "Return to call site" was missing for some navigations.
    const callerId = getCallerFromTreeNodeKey(treeNodeKey);
    const baseCallSiteReturn =
      callerId != null
        ? {
            callerId,
            parentTreeNodeKey: getParentTreeNodeKey(treeNodeKey),
            callerName:
              getFunctionDisplayName(flowPayload.functionsById[callerId]) || callerId,
            calleeTreeNodeKey: treeNodeKey
          }
        : null;
    const callSiteReturn =
      baseCallSiteReturn && !uiState.callSiteReturnConsumedKeys?.has?.(treeNodeKey)
        ? baseCallSiteReturn
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
      flowFnIds,
      '',
      treeNodeKey,
      prContext,
      callSiteReturn,
      isCollapsed,
      canonicalKeyByFunctionId
    );

    // Attach checkbox-style "done/read" control into the existing header inside this block:
    // prefer module-context header if present, otherwise file-name header.
    const headerEl =
      block.querySelector('.module-context-header') ||
      block.querySelector('.file-name-header');
    if (headerEl) {
      const controls = document.createElement('div');
      controls.className = 'function-block-header-controls';
      const headerToggleBtn = toggleBtn.cloneNode(true);
      const headerDoneBtn = doneBtn.cloneNode(true);
      headerToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFunctionCollapsedState(functionId);
      });
      headerDoneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFunctionReadState(functionId);
      });
      controls.appendChild(headerToggleBtn);
      controls.appendChild(headerDoneBtn);
      headerEl.appendChild(controls);
    }
    fileSection.appendChild(block);
  }
  contentScroller.appendChild(fileSection);
  contentShell.appendChild(filesNav);
  contentShell.appendChild(filesNavResizer);
  contentShell.appendChild(contentScroller);
  container.appendChild(contentShell);
  contentScroller.scrollTop = codePaneScrollTop;
  contentScroller.scrollLeft = codePaneScrollLeft;

  // Determine the current active code block, preferring the specific tree-node path
  // when available so different occurrences of the same function scroll independently.
  const activeTreeNodeKey = uiState.activeTreeNodeKey || null;
  const activeFunctionId =
    getFunctionIdFromTreeNodeKey(activeTreeNodeKey) || uiState.activeFunctionId;

  // Build a stable key that distinguishes different occurrences of the same function.
  const activeScrollKey = activeTreeNodeKey || (activeFunctionId ? `fn:${activeFunctionId}` : null);

  const pendingReturnScroll = uiState.callSiteReturnScrollTarget;
  const applyReturnScroll =
    pendingReturnScroll &&
    activeTreeNodeKey &&
    pendingReturnScroll.callerTreeNodeKey === activeTreeNodeKey;

  // Only auto-center when the active target changes, so manual scrolling isn't
  // constantly overridden on every store update (e.g., when updating "you are here").
  if (applyReturnScroll) {
    const lineOk = applyCallSiteReturnScroll(contentScroller, pendingReturnScroll);
    clearCallSiteReturnScrollTarget();
    lastScrolledToActiveKey = activeScrollKey;
    if (!lineOk && activeTreeNodeKey) {
      const block = contentScroller.querySelector(
        `.function-block[data-tree-node-key="${CSS.escape(activeTreeNodeKey)}"]`
      );
      if (block) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => scrollToVerticalCenter(contentScroller, block));
        });
      }
    }
  } else if (activeScrollKey && activeScrollKey !== lastScrolledToActiveKey) {
    let el = null;
    if (activeTreeNodeKey) {
      el = contentScroller.querySelector(
        `.function-block[data-tree-node-key="${CSS.escape(activeTreeNodeKey)}"]`
      );
    }
    if (!el && activeFunctionId) {
      el = contentScroller.querySelector(
        `.function-block[data-function-id="${CSS.escape(activeFunctionId)}"]`
      );
    }
    if (el) {
      lastScrolledToActiveKey = activeScrollKey;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToVerticalCenter(contentScroller, el));
      });
    }
  }
  if (!activeScrollKey) lastScrolledToActiveKey = null;

  // Explicitly mark the "you are here" function block in the code view,
  // based on the function ID derived from the tree's inViewTreeNodeKey.
  const inViewFnId =
    getFunctionIdFromTreeNodeKey(uiState.inViewTreeNodeKey) || null;
  if (inViewFnId) {
    const inViewBlock = contentScroller.querySelector(
      `.function-block[data-function-id="${CSS.escape(inViewFnId)}"]`
    );
    if (inViewBlock) inViewBlock.classList.add('in-view');
  }

  // Live in-view sync on every scroll caused frequent full re-renders that interrupted
  // momentum scrolling. Keep code-pane scrolling uninterrupted.
  if (!contentScroller.dataset.scrollLinked) {
    contentScroller.dataset.scrollLinked = '1';
  }
  reapplyCallSiteReturnHighlight(contentScroller);
}
