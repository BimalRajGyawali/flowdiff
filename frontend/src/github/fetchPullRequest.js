/**
 * Fetches PR diff from GitHub and runs the parse pipeline.
 * For scaffold: returns mock data until pipeline is implemented.
 */

import { setFlowPayload } from '../state/store.js';
import { parsePrUrl } from './parsePrUrl.js';
import { fetchDiff } from './fetchDiff.js';
import { parseDiff } from '../parser/parseDiff.js';
import { extractChangedFunctions } from '../parser/extractChangedFunctions.js';
import { buildFlows } from '../parser/buildFlows.js';
import { isTestFile } from '../parser/isTestFile.js';

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
  const [meta, diffText] = await Promise.all([
    fetchPullRequestMeta(owner, repo, number),
    fetchDiff(owner, repo, number)
  ]);
  const parsed = parseDiff(diffText);
  const pythonPaths = parsed.files
    .map((file) => file.path)
    .filter((path) => path.endsWith('.py') && !isTestFile(path));
  const uniquePaths = [...new Set(pythonPaths)];
  const fileContentEntries = await Promise.all(
    uniquePaths.map(async (path) => [path, await fetchFileContent(owner, repo, path, meta.head.sha)])
  );
  const fileContentsByPath = Object.fromEntries(
    fileContentEntries.filter(([, content]) => typeof content === 'string')
  );

  const { functionsById, files } = extractChangedFunctions(parsed, fileContentsByPath);
  const { flows, edges } = buildFlows(functionsById, parsed, fileContentsByPath);
  setFlowPayload({ files, functionsById, flows, edges });
}
