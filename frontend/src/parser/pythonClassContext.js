/**
 * Resolve enclosing `class` scope for a `def` line (supports nested classes).
 * @param {string[]} sourceLines 0-based lines
 * @param {number} defLineNum 1-based line of `def`
 * @param {number} defIndent column indent of `def` line
 * @returns {string} qualified class chain e.g. `Outer.Inner`, or '' if module-level
 */
export function getQualifiedClassPrefix(sourceLines, defLineNum, defIndent) {
  const parts = [];
  let threshold = defIndent;
  for (let ln = defLineNum - 1; ln >= 1; ln--) {
    const text = sourceLines[ln - 1] ?? '';
    const m = text.match(/^(\s*)(?:async\s+def|def|class)\s+(\w+)\b/);
    if (!m) continue;
    const ind = m[1].length;
    if (ind >= threshold) continue;
    const isClass = /^\s*class\b/.test(text);
    if (!isClass) return '';
    parts.push(m[2]);
    threshold = ind;
  }
  parts.reverse();
  return parts.length ? parts.join('.') : '';
}

/**
 * Line numbers of `class` headers that enclose this method (for module-scope exclusion).
 * @param {string[]} sourceLines
 * @param {number} defLineNum 1-based
 * @param {number} defIndent
 * @returns {number[]}
 */
export function getEnclosingClassHeaderLines(sourceLines, defLineNum, defIndent) {
  const lines = [];
  let threshold = defIndent;
  for (let ln = defLineNum - 1; ln >= 1; ln--) {
    const text = sourceLines[ln - 1] ?? '';
    const m = text.match(/^(\s*)(?:async\s+def|def|class)\s+(\w+)\b/);
    if (!m) continue;
    const ind = m[1].length;
    if (ind >= threshold) continue;
    const isClass = /^\s*class\b/.test(text);
    if (!isClass) return [];
    lines.push(ln);
    threshold = ind;
  }
  return lines;
}
