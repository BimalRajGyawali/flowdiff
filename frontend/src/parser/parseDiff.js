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
 * Hunk body runs from the end of one `@@ ... @@` header to just before the next real hunk header.
 * `indexOf("@@")` matches `@@` inside source text and truncates the hunk — skewing line counts.
 * @param {string} block - full `diff --git` block
 * @param {number} afterHeaderIndex - index immediately after `@@ -old +new @@`
 */
function sliceHunkLines(block, afterHeaderIndex) {
  const rest = block.slice(afterHeaderIndex).replace(/\r\n/g, '\n');
  const m = /\n@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(rest);
  let body = m ? rest.slice(0, m.index) : rest;
  // Git prints optional context (e.g. ` def _get_invocation_params(`) after the second `@@` on the
  // same line. That suffix is not a unified-diff row and must not advance old/new line counters.
  const firstNl = body.indexOf('\n');
  // If there is no newline, the whole segment is a single diff line (no optional @@ suffix).
  if (firstNl !== -1) body = body.slice(firstNl + 1);
  let lines = body.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  while (lines.length && lines[0] === '') lines.shift();
  return lines;
}

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
      const lines = sliceHunkLines(block, hunkStart);
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
