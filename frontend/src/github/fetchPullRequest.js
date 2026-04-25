/**
 * Fetches PR diff from GitHub and runs the parse pipeline.
 * For scaffold: returns mock data until pipeline is implemented.
 */

import { setFlowPayload, setPrContext } from '../state/store.js';
import { parsePrUrl } from './parsePrUrl.js';
import { fetchDiff } from './fetchDiff.js';
import { githubAuthHeaders } from './auth.js';
import { parseDiff } from '../parser/parseDiff.js';
import { extractChangedFunctions } from '../parser/extractChangedFunctions.js';
import { buildFlows } from '../parser/buildFlows.js';
import { getFunctionDisplayName } from '../parser/functionDisplayName.js';

const CACHE_VERSION = 'v16';

function getCacheKey(owner, repo, number) {
  return `flowdiff:${CACHE_VERSION}:${owner}/${repo}#${number}`;
}

function readCachedRawData(cacheKey) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.rawData ?? null;
  } catch {
    return null;
  }
}

function writeCachedRawData(cacheKey, rawData) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(cacheKey, JSON.stringify({
      savedAt: new Date().toISOString(),
      rawData
    }));
  } catch {
    // Ignore storage quota or serialization issues and proceed normally.
  }
}

function analyzeRawPullRequestData(diffText, fileContentsByPath) {
  const parsed = parseDiff(diffText);
  const { functionsById, files } = extractChangedFunctions(parsed, fileContentsByPath);
  const { flows, edges, standaloneClassIds, classDefAboveMethod } = buildFlows(
    functionsById,
    parsed,
    fileContentsByPath
  );
  return { files, functionsById, flows, edges, standaloneClassIds, classDefAboveMethod };
}

function formatFlowTree(rootId, payload, lines, visited, depth = 0, pathFromRoot = new Set()) {
  const fn = payload.functionsById[rootId];
  const pad = '  '.repeat(depth);
  const label = fn ? getFunctionDisplayName(fn) : rootId;
  const kind = fn?.kind === 'method' ? ' [method]' : '';

  if (visited.has(rootId)) return;
  visited.add(rootId);

  lines.push(`${pad}${label}${kind}`);
  lines.push(`${pad}  id: ${rootId}`);

  const pathIncludingThis = new Set(pathFromRoot);
  pathIncludingThis.add(rootId);

  const childEdges = payload.edges
    .filter((e) => e.callerId === rootId)
    .sort((a, b) => a.callIndex - b.callIndex);

  for (const e of childEdges) {
    const cfn = payload.functionsById[e.calleeId];
    const cname = cfn ? getFunctionDisplayName(cfn) : e.calleeId;
    if (pathIncludingThis.has(e.calleeId)) {
      lines.push(`${pad}  (cycle edge skipped -> ${cname})`);
      continue;
    }
    if (visited.has(e.calleeId)) {
      lines.push(`${pad}  -> ${cname} [${e.calleeId}] (omitted - already listed above in this flow)`);
      continue;
    }
    formatFlowTree(e.calleeId, payload, lines, visited, depth + 1, pathIncludingThis);
  }
}

function logFlowDebugDump(prUrl, payload) {
  const out = [];
  out.push('Flow tree dump');
  out.push(`PR: ${prUrl}`);
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push('');
  out.push('--- Summary ---');
  out.push(`Functions/methods in graph: ${Object.keys(payload.functionsById).length}`);
  out.push(`Edges: ${payload.edges.length}`);
  out.push(`Flows: ${payload.flows.length}`);
  out.push(`Parsed files: ${payload.files?.length ?? 0}`);
  out.push('');

  out.push('--- All nodes (id -> display) ---');
  for (const [id, fn] of Object.entries(payload.functionsById).sort(([a], [b]) => a.localeCompare(b))) {
    const display = getFunctionDisplayName(fn);
    out.push(`  ${id}`);
    out.push(`    -> ${display}${fn.kind === 'method' ? ` (class: ${fn.className})` : ''}`);
  }
  out.push('');

  out.push('--- Edges (caller -> callee, callIndex) ---');
  for (const e of [...payload.edges].sort((a, b) => a.callerId.localeCompare(b.callerId) || a.callIndex - b.callIndex)) {
    const caller = payload.functionsById[e.callerId];
    const callee = payload.functionsById[e.calleeId];
    out.push(
      `  ${getFunctionDisplayName(caller)} [${e.callerId}] --${e.callIndex}-> ${getFunctionDisplayName(callee)} [${e.calleeId}]`
    );
  }
  out.push('');

  for (let i = 0; i < payload.flows.length; i++) {
    const flow = payload.flows[i];
    const rootFn = payload.functionsById[flow.rootId];
    out.push(`========== Flow ${i + 1}/${payload.flows.length} ==========`);
    out.push(`flow.id: ${flow.id}`);
    out.push(`flow.name: ${flow.name ?? '?'}`);
    out.push(`rootId: ${flow.rootId}`);
    out.push(`root display: ${rootFn ? getFunctionDisplayName(rootFn) : 'MISSING'}`);
    out.push('');
    out.push('Tree (DFS, callIndex order; same rules as UI flow tree):');
    const treeLines = [];
    const visited = new Set();
    formatFlowTree(flow.rootId, { functionsById: payload.functionsById, edges: payload.edges }, treeLines, visited);
    for (const line of treeLines) out.push(line);
    out.push('');
  }

  console.log(out.join('\n'));
}

async function fetchPullRequestMeta(owner, repo, number) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...githubAuthHeaders()
    }
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json();
}

async function fetchFileContent(owner, repo, path, ref) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.raw',
      ...githubAuthHeaders()
    }
  });
  if (!res.ok) return null;
  return res.text();
}

/**
 * @param {string} prUrl
 */
export async function fetchAndAnalyze(prUrl) {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const cacheKey = getCacheKey(owner, repo, number);
  const cachedRawData = readCachedRawData(cacheKey);
  if (cachedRawData) {
    const payload = analyzeRawPullRequestData(
      cachedRawData.diffText,
      cachedRawData.fileContentsByPath ?? {}
    );
    logFlowDebugDump(prUrl, payload);
    setFlowPayload(payload);
    if (cachedRawData.headSha) {
      setPrContext(cachedRawData.owner, cachedRawData.repo, String(cachedRawData.number), cachedRawData.headSha);
    }
    return { source: 'cache' };
  }

  try {
    const [meta, diffText] = await Promise.all([
      fetchPullRequestMeta(owner, repo, number),
      fetchDiff(owner, repo, number)
    ]);
    const parsed = parseDiff(diffText);
    const changedPaths = parsed.files
      .map((file) => file.path)
      .filter(Boolean);
    const uniquePaths = [...new Set(changedPaths)];
    const fileContentEntries = await Promise.all(
      uniquePaths.map(async (path) => [path, await fetchFileContent(owner, repo, path, meta.head.sha)])
    );
    const fileContentsByPath = Object.fromEntries(
      fileContentEntries.filter(([, content]) => typeof content === 'string')
    );

    const payload = analyzeRawPullRequestData(diffText, fileContentsByPath);
    logFlowDebugDump(prUrl, payload);
    writeCachedRawData(cacheKey, {
      prUrl,
      owner,
      repo,
      number,
      headSha: meta.head.sha,
      diffText,
      fileContentsByPath
    });
    setFlowPayload(payload);
    setPrContext(owner, repo, String(number), meta.head.sha);
    return { source: 'network' };
  } catch (error) {
    if (cachedRawData) {
      const payload = analyzeRawPullRequestData(
        cachedRawData.diffText,
        cachedRawData.fileContentsByPath ?? {}
      );
      logFlowDebugDump(prUrl, payload);
      setFlowPayload(payload);
      return { source: 'cache' };
    }
    throw error;
  }
}
