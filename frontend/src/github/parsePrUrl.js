/**
 * Parses a GitHub PR URL into owner, repo, and PR number.
 * @param {string} url
 * @returns {{ owner: string, repo: string, number: number }}
 */
export function parsePrUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!match) throw new Error('Invalid GitHub PR URL');
  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3], 10)
  };
}
