/**
 * Code view pane: shows all functions of the selected flow in flow-tree order.
 * No inline expansion; call-site and flow-tree clicks navigate (scroll to + highlight) the function block.
 */

import { getState, setActiveFunction } from '../state/store.js';

let lastScrolledToActiveKey = null;

function isElementInView(container, el) {
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const padding = 40;
  return eRect.top >= cRect.top - padding && eRect.bottom <= cRect.bottom + padding;
}

function scrollToVerticalCenter(container, el) {
  if (!container || !el) return;
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const containerCenterY = cRect.top + cRect.height / 2;
  const elementCenterY = eRect.top + eRect.height / 2;
  const delta = elementCenterY - containerCenterY;
  container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
}

function getFunctionIdFromTreeNodeKey(treeNodeKey) {
  if (!treeNodeKey) return null;
  if (treeNodeKey.startsWith('root:')) return treeNodeKey.slice(5);
  const parts = treeNodeKey.split('/');
  const last = parts[parts.length - 1];
  if (last.startsWith('e:')) {
    const p = last.split(':');
    if (p.length >= 4) return p[3];
  }
  return null;
}

function applyFocusDimming(container, uiState) {
  container.querySelectorAll('.code-focus-block').forEach((el) => el.classList.remove('code-focus-block'));
  const dimmables = container.querySelectorAll(
    '.diff-line, .file-name-header, .module-context, .function-block'
  );
  dimmables.forEach((el) => el.classList.remove('code-dimmed'));
  container.classList.remove('code-focus-mode');

  const activeFunctionId =
    getFunctionIdFromTreeNodeKey(uiState.activeTreeNodeKey) || uiState.activeFunctionId;
  if (!activeFunctionId) return;

  const focusEl = container.querySelector(
    `.function-block[data-function-id="${CSS.escape(activeFunctionId)}"]`
  );
  if (!focusEl) return;

  focusEl.classList.add('code-focus-block');
  container.classList.add('code-focus-mode');
  dimmables.forEach((el) => {
    if (el.closest('.code-focus-block')) return;
    if (el.contains(focusEl)) return;
    el.classList.add('code-dimmed');
  });
}

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

function buildDiffLines(hunks) {
  const diffLines = [];

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
    // Include any diff rows anchored in this range.
    for (const row of relevantDiffLines) {
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

function renderDiffRows(container, filePath, rows, prContext) {
  for (const rowData of rows) {
    const line = rowData.content;
    const lineHtml = highlightPython(line);

    const lineNum = rowData.newLineNumber ?? rowData.oldLineNumber;
    const lineLink = prContext && lineNum != null && rowData.type !== 'del'
      ? `https://github.com/${prContext.owner}/${prContext.repo}/blob/${prContext.headSha}/${filePath}#L${lineNum}`
      : '';
    const oldNumHtml = rowData.oldLineNumber != null ? String(rowData.oldLineNumber) : '';
    const newNumHtml = rowData.newLineNumber != null
      ? (lineLink ? `<a href="${escapeHtml(lineLink)}" target="_blank" rel="noopener" class="diff-num-link" title="Open on GitHub">${rowData.newLineNumber}</a>` : String(rowData.newLineNumber))
      : '';

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
 * Returns functions in flow order (DFS from root, first occurrence). One entry per function.
 * @param {string} rootId
 * @param {import('../flowSchema.js').FlowPayload} payload
 * @returns {{ treeNodeKey: string, functionId: string }[]}
 */
function collectFlowOrder(rootId, payload) {
  const rootKey = `root:${rootId}`;
  const list = [];

  function visit(fnId, treeNodeKey, pathFromRoot) {
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
 * Renders a function body with clickable call sites and inline expansion.
 * @param {string} pathPrefix - path-based tree key for this block (root:rootId or parentPath/e:caller:idx:callee)
 * @param {Record<string, string[]>} sourceLinesByFile - file path -> full current source lines
 * @param {Record<string, { type: string, oldLineNumber: number | null, newLineNumber: number | null, content: string }[]>} diffLinesByFile
 * @param {Set<string>} filesWithModuleContext - file paths that have module-scope changes
 * @param {Map<string, { moduleChangedRanges?: { start: number, end: number }[], moduleChangedSymbols?: string[] }>} moduleMetaByFile
 */
function renderFunctionBody(container, payload, uiState, fn, sourceLinesByFile, diffLinesByFile, filesWithModuleContext, moduleMetaByFile, calleesByCaller, indent, pathPrefix, prContext) {
  const fileBlock = container.closest('[data-file]') || container;

  // Show file name only when there are no module-level changes (module-context already shows the file name).
  const hasFileHeader = fileBlock.querySelector?.('.file-name-header, [data-module-context-section]');
  if (!hasFileHeader && !filesWithModuleContext.has(fn.file) && fileBlock.dataset?.file === fn.file) {
    const fileHeader = document.createElement('div');
    fileHeader.className = 'file-name-header';
    fileHeader.textContent = fn.file;
    fileBlock.prepend(fileHeader);
  }

  // Ensure a module-context section exists within this file block (root or inline)
  // so any "module context" pills have a reliable scroll target.
  if (filesWithModuleContext.has(fn.file)) {
    const fileBlock = container.closest('[data-file]') || container;
    const already = fileBlock.querySelector?.('[data-module-context-section]');
    if (!already) {
      const fileMeta = moduleMetaByFile.get(fn.file);
      if (fileMeta?.moduleChangedRanges?.length) {
        const ctx = document.createElement('div');
        ctx.className = 'module-context';
        ctx.dataset.moduleContextSection = fn.file;
        const symText = (fileMeta.moduleChangedSymbols || []).slice(0, 8).join(', ');
        const more = (fileMeta.moduleChangedSymbols || []).length > 8 ? ` (+${(fileMeta.moduleChangedSymbols || []).length - 8} more)` : '';
        const ctxId = `module-ctx:${fn.file}`;
        ctx.innerHTML = `
          <div class="module-context-header">
            <button type="button" class="module-context-toggle" aria-expanded="false" aria-controls="${escapeHtml(ctxId)}" title="Changes outside function bodies">Module changes</button>
            <span class="module-context-file">${escapeHtml(fn.file)}</span>
            ${symText ? `<span class="module-context-syms" title="${escapeHtml((fileMeta.moduleChangedSymbols || []).join(', '))}">${escapeHtml(symText)}${more}</span>` : ''}
          </div>
          <div class="module-context-body" id="${escapeHtml(ctxId)}" hidden></div>
        `;
        const body = ctx.querySelector('.module-context-body');
        const toggle = ctx.querySelector('.module-context-toggle');
        toggle?.addEventListener('click', (e) => {
          e.stopPropagation();
          const expanded = toggle.getAttribute('aria-expanded') === 'true';
          toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
          if (body) body.hidden = expanded;
          if (!expanded && body && body.childElementCount === 0) {
            const rows = buildRangeDisplayRows(
              fileMeta.moduleChangedRanges,
              sourceLinesByFile[fn.file] || [],
              diffLinesByFile[fn.file] || [],
              new Set(fileMeta.moduleExcludedLineNumbers || [])
            );
            const lines = document.createElement('div');
            lines.className = 'module-context-lines';
            renderDiffRows(lines, fn.file, rows, prContext);
            body.appendChild(lines);
          }
        });
        fileBlock.prepend(ctx);
      }
    }
  }

  const pathFunctionIds = getPathFunctionIds(pathPrefix);
  const sourceLines = sourceLinesByFile[fn.file] || [];
  const fnDiffLines = buildFunctionDisplayRows(fn, sourceLines, diffLinesByFile[fn.file] || []);
  const calleesWithIndex = (calleesByCaller.get(fn.id) || []).sort((a, b) => a.callIndex - b.callIndex);
  const calleesForFind = [...new Map(calleesWithIndex.map((e) => [e.calleeId, { calleeId: e.calleeId, name: payload.functionsById[e.calleeId]?.name }])).values()].filter((x) => x.name);
  const remainingByCallee = new Map();
  for (const { calleeId, callIndex } of calleesWithIndex) {
    if (!remainingByCallee.has(calleeId)) remainingByCallee.set(calleeId, []);
    remainingByCallee.get(calleeId).push(callIndex);
  }

  for (const rowData of fnDiffLines) {
    const line = rowData.content;
    const sites = rowData.type === 'del' ? [] : findCallSitesInLine(line, calleesForFind);
    for (const site of sites) {
      const indices = remainingByCallee.get(site.calleeId);
      if (indices?.length) site.callIndex = indices.shift();
    }

    let lineHtml;
    const placeholders = [];

    if (sites.length === 0) {
      lineHtml = highlightPython(indent + line);
    } else {
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
    }

    const lineNum = rowData.newLineNumber ?? rowData.oldLineNumber;
    const lineLink = prContext && lineNum != null && rowData.type !== 'del'
      ? `https://github.com/${prContext.owner}/${prContext.repo}/blob/${prContext.headSha}/${fn.file}#L${lineNum}`
      : '';
    const oldNumHtml = rowData.oldLineNumber != null ? String(rowData.oldLineNumber) : '';
    const newNumHtml = rowData.newLineNumber != null
      ? (lineLink ? `<a href="${escapeHtml(lineLink)}" target="_blank" rel="noopener" class="diff-num-link" title="Open on GitHub">${rowData.newLineNumber}</a>` : String(rowData.newLineNumber))
      : '';
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
        uiState.activeFunctionId === calleeId ||
        (treeNodeKey && uiState.activeTreeNodeKey === treeNodeKey);
      const isHovered = treeNodeKey && uiState.hoveredTreeNodeKey === treeNodeKey;
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
      if (isHovered) el.classList.add('hovered');
      el.title = `Go to ${callee?.name || calleeId}`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveFunction(calleeId, treeNodeKey);
      });
    });

    container.appendChild(row);
  }
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
    const isHovered = uiState.hoveredTreeNodeKey === treeNodeKey;
    if (isActive) block.classList.add('active');
    if (isHovered) block.classList.add('hovered');

    renderFunctionBody(
      block,
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
      prContext
    );
    fileSection.appendChild(block);
  }
  container.appendChild(fileSection);

  const activeFunctionId =
    getFunctionIdFromTreeNodeKey(uiState.activeTreeNodeKey) || uiState.activeFunctionId;
  if (activeFunctionId && activeFunctionId !== lastScrolledToActiveKey) {
    const el = container.querySelector(
      `.function-block[data-function-id="${CSS.escape(activeFunctionId)}"]`
    );
    if (el) {
      lastScrolledToActiveKey = activeFunctionId;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToVerticalCenter(container, el));
      });
    }
  }
  if (!activeFunctionId) lastScrolledToActiveKey = null;

  applyFocusDimming(container, uiState);
}
