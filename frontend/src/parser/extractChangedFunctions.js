/**
 * Extracts changed/added functions from parsed diff.
 * Python only: detects `def name(...):` and `async def name(...):`.
 * Excludes test files (test_*.py, *_test.py, tests/**, test/**).
 */

/** @typedef {import('./parseDiff.js').ParsedFile} ParsedFile */
import { isTestFile } from './isTestFile.js';
import { buildVisibleLines } from './buildVisibleLines.js';

const PY_FN_REGEX = /(?:async\s+)?def\s+(\w+)\s*\(/g;
const PY_DEF_LINE_REGEX = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
const PY_BLOCK_START_REGEX = /^(\s*)(?:async\s+)?def\s+\w+\s*\(|^(\s*)class\s+\w+/;

/**
 * @param {{ files: ParsedFile[] }} parsed
 * @param {Record<string, string>} [fileContentsByPath={}]
 * @returns {{ functionsById: Record<string, import('../flowSchema.js').FunctionMeta>, files: import('../flowSchema.js').File[] }}
 */
export function extractChangedFunctions(parsed, fileContentsByPath = {}) {
  const functionsById = {};
  const files = [];

  for (const pf of parsed.files) {
    if (!pf.path.endsWith('.py') || isTestFile(pf.path)) continue;

    const changedRanges = pf.hunks.flatMap((h) => {
      const start = h.newStart;
      const end = h.newStart + (h.newLines || 1) - 1;
      return [{ start, end }];
    });

    const visibleLines = buildVisibleLines(pf.hunks);
    const sourceText = fileContentsByPath[pf.path] ?? visibleLines.map((line) => line.content).join('\n');
    const sourceLines = sourceText.split('\n');
    const fileEndLine = sourceLines.length;

    const defs = [];
    for (let index = 0; index < sourceLines.length; index++) {
      const line = sourceLines[index];
      const match = line.match(PY_DEF_LINE_REGEX);
      if (!match) continue;
      const lineNum = index + 1;
      const visibleLine = visibleLines.find((item) => item.lineNumber === lineNum);
      defs.push({
        name: match[2],
        lineNum,
        indent: match[1].length,
        defAdded: visibleLine?.added ?? false,
        snippet: line
      });
    }

    for (let i = 0; i < defs.length; i++) {
      const { name, lineNum, snippet, indent } = defs[i];
      let endLine = fileEndLine;
      for (let j = lineNum; j < sourceLines.length; j++) {
        const blockMatch = sourceLines[j].match(PY_BLOCK_START_REGEX);
        if (!blockMatch) continue;
        const nextIndent = (blockMatch[1] ?? blockMatch[2] ?? '').length;
        if (nextIndent <= indent) {
          endLine = j;
          break;
        }
      }

      const hasAddedChange = visibleLines.some(
        (line) => line.lineNumber >= lineNum && line.lineNumber <= endLine && line.added
      );
      const hasDeletedChange = visibleLines.some(
        (line) => line.lineNumber >= lineNum && line.lineNumber <= endLine && line.touchedByDeletion
      );

      if (!hasAddedChange) continue;

      const id = `${pf.path}:${name}`;
      functionsById[id] = {
        id,
        name,
        file: pf.path,
        startLine: lineNum,
        endLine,
        snippet: snippet ?? `def ${name}(`,
        changed: true,
        changeType: hasDeletedChange ? 'modified' : 'added'
      };
    }

    files.push({
      path: pf.path,
      hunks: pf.hunks,
      changedRanges,
      sourceLines
    });
  }

  return { functionsById, files };
}
