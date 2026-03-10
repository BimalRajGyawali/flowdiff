/**
 * Code view pane: shows only the code of the selected flow.
 * Callee call sites are clickable; when expanded, the callee is inlined at the call site.
 * Expansion syncs with the flow tree. Uses Prism for syntax highlighting.
 */

import { getState, toggleExpandedTreeNode, setActiveFunction, setSelectedFileInFlow } from '../state/store.js';

let lastScrolledToActiveKey = null;
let lastScrolledToHoveredKey = null;

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
 */
function renderFunctionBody(container, payload, uiState, fn, sourceLinesByFile, diffLinesByFile, calleesByCaller, indent, pathPrefix, prContext) {
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
        const idx = placeholders[pi].callIndex;
        const indicator = idx !== undefined ? `<sup class="call-site-indicator" title="Call #${idx + 1}">${idx + 1}</sup>` : '';
        const callSpanHtml = `<span class="call-site" data-callee-id="${escapeHtml(calleeId)}"${dataKey} title="Click to expand">${escapeHtml(callText)}${indicator}</span>`;
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
      label.textContent = `↳ ${callee.name}`;
      inlineBlock.appendChild(label);
      const innerContainer = document.createElement('div');
      innerContainer.className = 'inline-callee-body';
      const innerIndent = indent + '    ';
      renderFunctionBody(innerContainer, payload, uiState, callee, sourceLinesByFile, diffLinesByFile, calleesByCaller, innerIndent, treeNodeKey, prContext);
      inlineBlock.appendChild(innerContainer);
      container.appendChild(inlineBlock);
    }
  }
}

export function renderCodeView(container) {
  const { flowPayload, uiState, prContext } = getState();
  container.innerHTML = '';

  if (!flowPayload.files?.length) {
    container.textContent = 'Enter a PR URL and click Analyze.';
    return;
  }

  const selectedFlow = flowPayload.flows?.find((f) => f.id === uiState.selectedFlowId);
  const flowFnIds = selectedFlow ? getFlowFunctionIds(selectedFlow, flowPayload) : new Set();

  if (flowFnIds.size === 0) {
    container.textContent = 'Select a flow.';
    return;
  }

  const flowFiles = new Set();
  for (const id of flowFnIds) {
    const fn = flowPayload.functionsById[id];
    if (fn?.file) flowFiles.add(fn.file);
  }
  const flowFilesSorted = [...flowFiles].sort();

  const calleesByCaller = new Map();
  for (const e of flowPayload.edges) {
    if (!flowFnIds.has(e.callerId) || !flowFnIds.has(e.calleeId)) continue;
    const list = calleesByCaller.get(e.callerId) || [];
    list.push({ calleeId: e.calleeId, callIndex: e.callIndex });
    calleesByCaller.set(e.callerId, list);
  }

  const sourceLinesByFile = {};
  const diffLinesByFile = {};
  for (const file of flowPayload.files) {
    sourceLinesByFile[file.path] = file.sourceLines || [];
    diffLinesByFile[file.path] = buildDiffLines(file.hunks || []);
  }

  const root = flowPayload.functionsById[selectedFlow.rootId];
  if (!root) return;

  if (flowFilesSorted.length > 1) {
    const tabBar = document.createElement('div');
    tabBar.className = 'file-tabs';
    for (const filePath of flowFilesSorted) {
      const tab = document.createElement('button');
      tab.className = 'file-tab';
      tab.type = 'button';
      tab.textContent = filePath.split('/').pop();
      tab.title = filePath;
      tab.dataset.file = filePath;
      if (filePath === (uiState.selectedFileInFlow || root.file)) tab.classList.add('active');
      tab.addEventListener('click', () => {
        setSelectedFileInFlow(filePath);
        const el = [...container.querySelectorAll('[data-file]')].find((e) => e.dataset.file === filePath);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      tabBar.appendChild(tab);
    }
    container.appendChild(tabBar);
  }

  const rootPath = `root:${root.id}`;
  const fileSection = document.createElement('div');
  fileSection.className = 'file-section';
  const header = document.createElement('div');
  header.className = 'file-header';
  header.textContent = root.file;
  fileSection.appendChild(header);

  const rootBlock = document.createElement('div');
  rootBlock.className = 'function-block root';
  rootBlock.dataset.functionId = root.id;
  rootBlock.dataset.treeNodeKey = rootPath;
  rootBlock.dataset.file = root.file;
  if (uiState.activeTreeNodeKey === rootPath) rootBlock.classList.add('active');
  if (uiState.hoveredTreeNodeKey === rootPath) rootBlock.classList.add('hovered');

  renderFunctionBody(rootBlock, flowPayload, uiState, root, sourceLinesByFile, diffLinesByFile, calleesByCaller, '', rootPath, prContext);
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

  if (uiState.hoveredTreeNodeKey && uiState.hoveredTreeNodeKey !== lastScrolledToHoveredKey) {
    const candidates = container.querySelectorAll('[data-tree-node-key]');
    const el = [...candidates].find((c) => c.dataset.treeNodeKey === uiState.hoveredTreeNodeKey);
    if (el) {
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      });
      lastScrolledToHoveredKey = uiState.hoveredTreeNodeKey;
    }
  }
  if (!uiState.hoveredTreeNodeKey) lastScrolledToHoveredKey = null;
}
