/**
 * Parses raw diff text into structured files and hunks.
 * Multi-commit PR patches may repeat the same path in several `diff --git` sections;
 * we merge hunks in order so line maps match GitHub's full file view.
 */

/**
 * @typedef {{ path: string, hunks: Hunk[] }} ParsedFile
 * @typedef {{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[] }} Hunk
 */

/**
 * @param {string} diffText
 * @returns {{ files: ParsedFile[] }}
 */
export function parseDiff(diffText) {
  /** @type {Map<string, ParsedFile>} */
  const byPath = new Map();
  /** @type {string[]} */
  const order = [];

  const fileBlocks = diffText.split(/(?=^diff --git )/m).filter(Boolean);

  for (const block of fileBlocks) {
    const pathMatch = block.match(/^diff --git a\/(.+?) b\/(.+?)(?:\n|$)/m);
    if (!pathMatch) continue;
    const path = pathMatch[2];

    const hunks = [];
    const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
    let m;
    while ((m = hunkRegex.exec(block)) !== null) {
      const oldStart = parseInt(m[1], 10);
      const oldLines = parseInt(m[2] || '1', 10);
      const newStart = parseInt(m[3], 10);
      const newLines = parseInt(m[4] || '1', 10);
      const hunkStart = m.index + m[0].length;
      const nextHunk = block.indexOf('@@', hunkStart);
      const hunkBody = nextHunk >= 0 ? block.slice(hunkStart, nextHunk) : block.slice(hunkStart);
      const lines = hunkBody.split('\n').filter((l) => l.length > 0);
      hunks.push({ oldStart, oldLines, newStart, newLines, lines });
    }

    const existing = byPath.get(path);
    if (existing) {
      existing.hunks.push(...hunks);
    } else {
      byPath.set(path, { path, hunks });
      order.push(path);
    }
  }

  return { files: order.map((p) => byPath.get(p)) };
}
