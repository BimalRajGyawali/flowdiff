#!/usr/bin/env node
/**
 * Fetch a GitHub PR, run FlowDiff analysis, and write flow trees to a text file.
 * Usage: node scripts/dump-flow-tree.mjs [owner] [repo] [prNumber] [outFile]
 * Example: node scripts/dump-flow-tree.mjs langchain-ai langchain 31685 flow-tree-dump.txt
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const parseDiff = (await import(join(root, 'frontend/src/parser/parseDiff.js'))).parseDiff;
const { extractChangedFunctions } = await import(join(root, 'frontend/src/parser/extractChangedFunctions.js'));
const { buildFlows } = await import(join(root, 'frontend/src/parser/buildFlows.js'));
const { getFunctionDisplayName } = await import(join(root, 'frontend/src/parser/functionDisplayName.js'));

async function fetchPullRequestMeta(owner, repo, number) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchDiff(owner, repo, number) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github.v3.diff' }
  });
  if (!res.ok) throw new Error(`GitHub diff error: ${res.status}`);
  return res.text();
}

async function fetchFileContent(owner, repo, path, ref) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github.raw' }
  });
  if (!res.ok) return null;
  return res.text();
}

function analyzeRawPullRequestData(diffText, fileContentsByPath) {
  const parsed = parseDiff(diffText);
  const { functionsById, files } = extractChangedFunctions(parsed, fileContentsByPath);
  const { flows, edges } = buildFlows(functionsById, parsed, fileContentsByPath);
  return { files, functionsById, flows, edges };
}

/**
 * DFS matching collectFlowOrder in codeView.js: each function id appears once (first DFS hit).
 * Cycles: skip edge; diamonds: omit second edge with a note (callee already listed).
 */
function formatFlowTree(rootId, payload, lines, visited, depth = 0, treeNodeKey = `root:${rootId}`, pathFromRoot = new Set()) {
  const fn = payload.functionsById[rootId];
  const pad = '  '.repeat(depth);
  const label = fn ? getFunctionDisplayName(fn) : rootId;
  const kind = fn?.kind === 'method' ? ' [method]' : '';

  if (visited.has(rootId)) return;
  visited.add(rootId);

  lines.push(`${pad}${label}${kind}`);
  lines.push(`${pad}  id: ${rootId}`);
  lines.push(`${pad}  treeNodeKey: ${treeNodeKey}`);

  const pathIncludingThis = new Set(pathFromRoot);
  pathIncludingThis.add(rootId);

  const childEdges = payload.edges
    .filter((e) => e.callerId === rootId)
    .sort((a, b) => a.callIndex - b.callIndex);

  for (const e of childEdges) {
    const cfn = payload.functionsById[e.calleeId];
    const cname = cfn ? getFunctionDisplayName(cfn) : e.calleeId;
    if (pathIncludingThis.has(e.calleeId)) {
      lines.push(`${pad}  (cycle edge skipped → ${cname})`);
      continue;
    }
    if (visited.has(e.calleeId)) {
      lines.push(`${pad}  → ${cname} [${e.calleeId}] (omitted — already listed above in this flow)`);
      continue;
    }
    const childKey = `${treeNodeKey}/e:${e.callerId}:${e.callIndex}:${e.calleeId}`;
    formatFlowTree(e.calleeId, payload, lines, visited, depth + 1, childKey, pathIncludingThis);
  }
}

const owner = process.argv[2] || 'langchain-ai';
const repo = process.argv[3] || 'langchain';
const number = parseInt(process.argv[4] || '31685', 10);
const outFile = process.argv[5] || join(root, 'flow-tree-dump.txt');

const out = [];
out.push(`Flow tree dump`);
out.push(`PR: https://github.com/${owner}/${repo}/pull/${number}`);
out.push(`Generated: ${new Date().toISOString()}`);
out.push('');

try {
  out.push('Fetching PR metadata and diff...');
  const [meta, diffText] = await Promise.all([fetchPullRequestMeta(owner, repo, number), fetchDiff(owner, repo, number)]);

  out.push(`Head SHA: ${meta.head?.sha ?? '?'}`);
  out.push(`Title: ${meta.title ?? '?'}`);
  out.push(`Changed files (from diff): ${diffText.split('diff --git').length - 1}`);
  out.push('');

  const parsed = parseDiff(diffText);
  const pythonPaths = [...new Set(parsed.files.map((f) => f.path).filter((p) => p.endsWith('.py')))];
  out.push(`Fetching ${pythonPaths.length} Python file(s) from head...`);

  const fileContentEntries = await Promise.all(
    pythonPaths.map(async (path) => [path, await fetchFileContent(owner, repo, path, meta.head.sha)])
  );
  const fileContentsByPath = Object.fromEntries(fileContentEntries.filter(([, c]) => typeof c === 'string'));

  out.push(`Loaded full contents for ${Object.keys(fileContentsByPath).length} file(s).`);
  out.push('');

  const { functionsById, flows, edges, files } = analyzeRawPullRequestData(diffText, fileContentsByPath);

  out.push(`--- Summary ---`);
  out.push(`Functions/methods in graph: ${Object.keys(functionsById).length}`);
  out.push(`Edges: ${edges.length}`);
  out.push(`Flows: ${flows.length}`);
  out.push(`Parsed files: ${files?.length ?? 0}`);
  out.push('');

  out.push(`--- All nodes (id → display) ---`);
  for (const [id, fn] of Object.entries(functionsById).sort(([a], [b]) => a.localeCompare(b))) {
    const q = getFunctionDisplayName(fn);
    out.push(`  ${id}`);
    out.push(`    → ${q}${fn.kind === 'method' ? ` (class: ${fn.className})` : ''}`);
  }
  out.push('');

  out.push(`--- Edges (caller → callee, callIndex) ---`);
  for (const e of [...edges].sort((a, b) => a.callerId.localeCompare(b.callerId) || a.callIndex - b.callIndex)) {
    const ca = functionsById[e.callerId];
    const ce = functionsById[e.calleeId];
    out.push(
      `  ${getFunctionDisplayName(ca)} [${e.callerId}]  --${e.callIndex}→  ${getFunctionDisplayName(ce)} [${e.calleeId}]`
    );
  }
  out.push('');

  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    const rootFn = functionsById[flow.rootId];
    out.push(`========== Flow ${i + 1}/${flows.length} ==========`);
    out.push(`flow.id: ${flow.id}`);
    out.push(`flow.name: ${flow.name ?? '?'}`);
    out.push(`rootId: ${flow.rootId}`);
    out.push(`root display: ${rootFn ? getFunctionDisplayName(rootFn) : 'MISSING'}`);
    out.push('');
    out.push('Tree (DFS, callIndex order; same rules as UI flow tree):');
    const treeLines = [];
    const visited = new Set();
    formatFlowTree(flow.rootId, { functionsById, edges }, treeLines, visited);
    for (const line of treeLines) out.push(line);
    out.push('');
  }

  const text = out.join('\n');
  writeFileSync(outFile, text, 'utf8');
  console.log(`Wrote ${outFile} (${text.length} bytes)`);
  console.log(`Flows: ${flows.length}, functions: ${Object.keys(functionsById).length}, edges: ${edges.length}`);
} catch (err) {
  const msg = err instanceof Error ? err.stack : String(err);
  writeFileSync(outFile, `ERROR\n\n${msg}`, 'utf8');
  console.error(err);
  process.exit(1);
}
