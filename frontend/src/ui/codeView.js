/**
 * Code view pane: shows only the code of the selected flow.
 * Callee call sites are clickable; when expanded, the callee is inlined at the call site.
 * Expansion syncs with the flow tree. Uses Prism for syntax highlighting.
 */

import { getState, toggleExpandedTreeNode, setActiveFunction } from '../state/store.js';

let lastScrolledToActiveKey = null;

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
        const dataKey = treeNodeKey ? ` data-tree-node-key="${escapeHtml(treeNodeKey)}"` : '';
        const callSpanHtml = `<span class="call-site" data-callee-id="${escapeHtml(calleeId)}"${dataKey} title="Click to expand">${escapeHtml(callText)}</span>`;
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
      const callee = payload.functionsById[calleeId];
      const isExpanded = treeNodeKey ? uiState.expandedTreeNodeIds.has(treeNodeKey) : false;
      const isActive = treeNodeKey ? uiState.activeTreeNodeKey === treeNodeKey : uiState.activeFunctionId === calleeId;
      const isHovered = treeNodeKey && uiState.hoveredTreeNodeKey === treeNodeKey;
      if (isActive) el.classList.add('active');
      if (isHovered) el.classList.add('hovered');
      el.title = `Click to ${isExpanded ? 'collapse' : 'expand'} ${callee?.name || calleeId}`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveFunction(calleeId, treeNodeKey);
        if (treeNodeKey) toggleExpandedTreeNode(treeNodeKey);
      });
    });

    container.appendChild(row);

    for (const site of sites) {
      const treeNodeKey = site.callIndex !== undefined ? `${pathPrefix}/e:${fn.id}:${site.callIndex}:${site.calleeId}` : '';
      const callee = payload.functionsById[site.calleeId];
      if (!callee || !treeNodeKey || !uiState.expandedTreeNodeIds.has(treeNodeKey)) continue;

      const inlineBlock = document.createElement('div');
      inlineBlock.className = 'inline-callee function-block';
      inlineBlock.dataset.treeNodeKey = treeNodeKey;
      inlineBlock.dataset.file = callee.file;
      if (uiState.activeTreeNodeKey === treeNodeKey) inlineBlock.classList.add('active');
      if (uiState.hoveredTreeNodeKey === treeNodeKey) inlineBlock.classList.add('hovered');
      inlineBlock.dataset.functionId = site.calleeId;
      const label = document.createElement('div');
      label.className = 'inline-callee-label';
      label.textContent = '↳';
      inlineBlock.appendChild(label);
      const innerContainer = document.createElement('div');
      innerContainer.className = 'inline-callee-body';
      const innerIndent = indent + '    ';
      renderFunctionBody(innerContainer, payload, uiState, callee, sourceLinesByFile, diffLinesByFile, filesWithModuleContext, moduleMetaByFile, calleesByCaller, innerIndent, treeNodeKey, prContext);
      inlineBlock.appendChild(innerContainer);
      container.appendChild(inlineBlock);
    }
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

  const rootPath = `root:${root.id}`;
  const fileSection = document.createElement('div');
  fileSection.className = 'file-section';
  // File header omitted; file context is shown within blocks.

  // Module context sections are inserted lazily per file block in renderFunctionBody,
  // so inline callees in other files also get a scroll target.

  const rootBlock = document.createElement('div');
  rootBlock.className = 'function-block root';
  rootBlock.dataset.functionId = root.id;
  rootBlock.dataset.treeNodeKey = rootPath;
  rootBlock.dataset.file = root.file;
  if (uiState.activeTreeNodeKey === rootPath) rootBlock.classList.add('active');
  if (uiState.hoveredTreeNodeKey === rootPath) rootBlock.classList.add('hovered');

  renderFunctionBody(rootBlock, flowPayload, uiState, root, sourceLinesByFile, diffLinesByFile, filesWithModuleContext, moduleMetaByFile, calleesByCaller, '', rootPath, prContext);
  fileSection.appendChild(rootBlock);
  container.appendChild(fileSection);

  if (uiState.activeTreeNodeKey && uiState.activeTreeNodeKey !== lastScrolledToActiveKey) {
    const candidates = container.querySelectorAll('[data-tree-node-key]');
    const el = [...candidates].find((c) => c.dataset.treeNodeKey === uiState.activeTreeNodeKey);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      lastScrolledToActiveKey = uiState.activeTreeNodeKey;
    }
  }
  if (!uiState.activeTreeNodeKey) lastScrolledToActiveKey = null;

  // Hover only highlights; no auto-scroll (prevents disorientation).
}
