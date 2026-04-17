/**
 * List all top-level and nested Python `def` / `async def` spans in a file.
 * End-line detection respects parenthesized/bracket continuations (delimiter nesting)
 * before treating a dedented line as leaving the function.
 */

const PY_DEF_LINE_REGEX = /^(\s*)(?:async\s+)?def\s+(\w+)\b/;
const PY_BLOCK_START_REGEX = /^(\s*)(?:async\s+)?def\s+\w+\b|^(\s*)class\s+\w+\b/;

/**
 * Net change in delimiter nesting depth for a single line (strings and # comments skipped).
 * @param {string} line
 * @returns {number}
 */
function netDelimiterDelta(line) {
  let delta = 0;
  let inString = /** @type {string | null} */ (null);
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === inString) {
        inString = null;
        continue;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    const rest = line.slice(i);
    if (rest.startsWith('#')) break;
    if (c === '(') delta++;
    else if (c === ')') delta--;
    else if (c === '[') delta++;
    else if (c === ']') delta--;
    else if (c === '{') delta++;
    else if (c === '}') delta--;
  }
  return delta;
}

/**
 * @param {string[]} sourceLines 0-based lines
 * @param {number} defLineNum 1-based line of `def`
 * @param {number} defIndent column indent of `def`
 * @param {number} fileEndLine 1-based last line
 * @returns {number} 1-based inclusive end line of function body span
 */
export function computePythonFunctionEndLine(sourceLines, defLineNum, defIndent, fileEndLine) {
  let nest = netDelimiterDelta(sourceLines[defLineNum - 1] ?? '');
  if (nest < 0) nest = 0;
  let endLine = fileEndLine;
  for (let lineNo = defLineNum + 1; lineNo <= fileEndLine; lineNo++) {
    const text = sourceLines[lineNo - 1] ?? '';
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      const indentMatch = text.match(/^(\s*)/);
      const lineIndent = (indentMatch?.[1] ?? '').length;
      if (nest === 0 && lineIndent <= defIndent) {
        // Closing paren / `) -> T:` / `):` belongs to the header, not the next statement.
        if (trimmed.startsWith(')')) {
          // fall through to nest update
        } else {
          const blockMatch = text.match(PY_BLOCK_START_REGEX);
          if (blockMatch) {
            const nextBlockIndent = (blockMatch[1] ?? blockMatch[2] ?? '').length;
            if (nextBlockIndent === defIndent) {
              endLine = lineNo - 1;
              break;
            }
          }
          endLine = lineNo - 1;
          break;
        }
      }
    }
    nest += netDelimiterDelta(text);
    if (nest < 0) nest = 0;
  }
  return endLine;
}

/**
 * @param {string[]} sourceLines
 * @returns {{ name: string, startLine: number, endLine: number, indent: number, snippet: string }[]}
 */
export function listAllPythonFunctionMetas(sourceLines) {
  const fileEndLine = sourceLines.length;
  const out = [];
  for (let index = 0; index < sourceLines.length; index++) {
    const line = sourceLines[index];
    const match = line.match(PY_DEF_LINE_REGEX);
    if (!match) continue;
    const lineNum = index + 1;
    const indent = match[1].length;
    const name = match[2];
    const endLine = computePythonFunctionEndLine(sourceLines, lineNum, indent, fileEndLine);
    out.push({
      name,
      startLine: lineNum,
      endLine,
      indent,
      snippet: line.trimEnd()
    });
  }
  return out;
}
