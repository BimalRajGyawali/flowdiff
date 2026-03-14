/**
 * Fetches PR diff from GitHub and runs the parse pipeline.
 * For scaffold: returns mock data until pipeline is implemented.
 */

import { setFlowPayload, setPrContext } from '../state/store.js';
import { parsePrUrl } from './parsePrUrl.js';
import { fetchDiff } from './fetchDiff.js';
import { parseDiff } from '../parser/parseDiff.js';
import { extractChangedFunctions } from '../parser/extractChangedFunctions.js';
import { buildFlows } from '../parser/buildFlows.js';

const CACHE_VERSION = 'v2';

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
  const { flows, edges } = buildFlows(functionsById, parsed, fileContentsByPath);
  return { files, functionsById, flows, edges };
}

async function fetchPullRequestMeta(owner, repo, number) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json();
}

async function fetchFileContent(owner, repo, path, ref) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github.raw' }
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
    const pythonPaths = parsed.files
      .map((file) => file.path)
      .filter((path) => path.endsWith('.py'));
    const uniquePaths = [...new Set(pythonPaths)];
    const fileContentEntries = await Promise.all(
      uniquePaths.map(async (path) => [path, await fetchFileContent(owner, repo, path, meta.head.sha)])
    );
    const fileContentsByPath = Object.fromEntries(
      fileContentEntries.filter(([, content]) => typeof content === 'string')
    );

    const payload = analyzeRawPullRequestData(diffText, fileContentsByPath);
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
      setFlowPayload(payload);
      return { source: 'cache' };
    }
    throw error;
  }
}
