/**
 * Resolve enclosing `class` scope for a `def` line (supports nested classes).
 * @param {string[]} sourceLines 0-based lines
 * @param {number} defLineNum 1-based line of `def`
 * @param {number} defIndent column indent of `def` line
 * @returns {string} qualified class chain e.g. `Outer.Inner`, or '' if module-level
 */
export function getQualifiedClassPrefix(sourceLines, defLineNum, defIndent) {
  // Only defs directly under class scope are methods.
  // If the nearest enclosing block is another def (nested function), this is not a method.
  for (let ln = defLineNum - 1; ln >= 1; ln--) {
    const text = sourceLines[ln - 1] ?? '';
    const m = text.match(/^(\s*)(?:async\s+def|def|class)\s+(\w+)\b/);
    if (!m) continue;
    const ind = m[1].length;
    if (ind >= defIndent) continue;
    const blockKind = /^\s*class\b/.test(text) ? 'class' : 'def';
    if (blockKind === 'def') return '';
    break;
  }

  const parts = [];
  let threshold = defIndent;
  for (let ln = defLineNum - 1; ln >= 1; ln--) {
    const text = sourceLines[ln - 1] ?? '';
    const m = text.match(/^(\s*)class\s+(\w+)\b/);
    if (!m) continue;
    const ind = m[1].length;
    if (ind < threshold) {
      parts.push(m[2]);
      threshold = ind;
    }
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
  // Nested defs inside another function should not claim class header lines as method context.
  for (let ln = defLineNum - 1; ln >= 1; ln--) {
    const text = sourceLines[ln - 1] ?? '';
    const m = text.match(/^(\s*)(?:async\s+def|def|class)\s+(\w+)\b/);
    if (!m) continue;
    const ind = m[1].length;
    if (ind >= defIndent) continue;
    const blockKind = /^\s*class\b/.test(text) ? 'class' : 'def';
    if (blockKind === 'def') return [];
    break;
  }

  const lines = [];
  let threshold = defIndent;
  for (let ln = defLineNum - 1; ln >= 1; ln--) {
    const text = sourceLines[ln - 1] ?? '';
    const m = text.match(/^(\s*)class\s+(\w+)\b/);
    if (!m) continue;
    const ind = m[1].length;
    if (ind < threshold) {
      lines.push(ln);
      threshold = ind;
    }
  }
  return lines;
}
