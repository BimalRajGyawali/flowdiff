import { githubAuthHeaders } from './auth.js';

/**
 * Fetches PR diff from GitHub API.
 * @param {string} owner
 * @param {string} repo
 * @param {number} number
 * @returns {Promise<string>}
 */

export async function fetchDiff(owner, repo, number) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3.diff',
      ...githubAuthHeaders()
    }
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.text();
}
