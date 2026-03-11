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

    /** @type {import('../flowSchema.js').FunctionMeta[]} */
    const changedFnsInFile = [];

    // Decorators immediately above a `def` belong to the function, not module context.
    // This includes multi-line decorators where continuation lines are indented further.
    const decoratorLineNumbers = new Set();
    for (const d of defs) {
      // Walk upward from the line above `def`, collecting the contiguous decorator block:
      // - lines starting with '@' at the same indent as the def
      // - any continuation lines more-indented than the def (e.g. decorator args split across lines)
      for (let idx = d.lineNum - 2; idx >= 0; idx--) {
        const text = sourceLines[idx] ?? '';
        if (text.trim().length === 0) break;
        const indentMatch = text.match(/^(\s*)/);
        const indentLen = (indentMatch?.[1] ?? '').length;

        const isDecoratorStart = indentLen === d.indent && text.trimStart().startsWith('@');
        const isDecoratorContinuation = indentLen > d.indent;

        if (!isDecoratorStart && !isDecoratorContinuation) break;
        decoratorLineNumbers.add(idx + 1);
      }
    }

    /** @type {{ start: number, end: number }[]} */
    const functionOwnedRanges = [];

    for (let i = 0; i < defs.length; i++) {
      const { name, lineNum, snippet, indent, defAdded } = defs[i];
      let endLine = fileEndLine;
      // Original heuristic for function boundaries: next def/class at same or lower indent.
      for (let j = lineNum; j < sourceLines.length; j++) {
        const blockMatch = sourceLines[j].match(PY_BLOCK_START_REGEX);
        if (!blockMatch) continue;
        const nextIndent = (blockMatch[1] ?? blockMatch[2] ?? '').length;
        if (nextIndent <= indent) {
          endLine = j;
          break;
        }
      }

      // For module-context exclusion, treat the entire function span [startLine, endLine]
      // (including the def line) as "owned" by the function.
      functionOwnedRanges.push({ start: lineNum, end: endLine });

      const hasAddedChange = visibleLines.some(
        (line) => line.lineNumber >= lineNum && line.lineNumber <= endLine && line.added
      );
      const hasDeletedChange = visibleLines.some(
        (line) => line.lineNumber >= lineNum && line.lineNumber <= endLine && line.touchedByDeletion
      );
      const hasAnyChange = hasAddedChange || hasDeletedChange;

      // Only keep functions whose body changed (added or deleted lines).
      if (!hasAnyChange) continue;

      // Classification:
      // - "added": function is newly created (its def line is newly added and there are no deletions in its body)
      // - "modified": function existed before and its body has added and/or deleted lines
      const isNewFunction = defAdded && !hasDeletedChange;
      const changeType = isNewFunction ? 'added' : 'modified';

      const id = `${pf.path}:${name}`;
      const fnMeta = {
        id,
        name,
        file: pf.path,
        startLine: lineNum,
        endLine,
        snippet: snippet ?? `def ${name}(`,
        changed: true,
        changeType
      };
      functionsById[id] = fnMeta;
      changedFnsInFile.push(fnMeta);
    }

    // Compute module-scope changed ranges.
    // Heuristic: touched lines that are NOT owned by any function (or its decorators).
    // This captures imports/constants/module init code and other non-function changes.
    const moduleChangedLineNumbers = [];
    const functionOwnedLineNumbers = new Set(decoratorLineNumbers);
    for (const r of functionOwnedRanges) {
      for (let ln = r.start; ln <= r.end; ln++) functionOwnedLineNumbers.add(ln);
    }
    for (const line of visibleLines) {
      const touched = line.added || line.touchedByDeletion;
      if (!touched) continue;
      if (line.lineNumber == null) continue;
      if (functionOwnedLineNumbers.has(line.lineNumber)) continue;
      moduleChangedLineNumbers.push(line.lineNumber);
    }
    moduleChangedLineNumbers.sort((a, b) => a - b);

    /** @type {{ start: number, end: number }[]} */
    const moduleChangedRanges = [];
    for (const ln of moduleChangedLineNumbers) {
      const last = moduleChangedRanges[moduleChangedRanges.length - 1];
      if (!last || ln > last.end + 1) moduleChangedRanges.push({ start: ln, end: ln });
      else last.end = ln;
    }

    // Extract simple module-level symbols (best-effort): NAME = ...
    const moduleChangedSymbolsSet = new Set();
    const moduleAssignRe = /^\s*([A-Za-z_]\w*)\s*=/;
    for (const r of moduleChangedRanges) {
      for (let ln = r.start; ln <= r.end; ln++) {
        const text = sourceLines[ln - 1] ?? '';
        // Only consider top-level (no indentation).
        if (/^\s+/.test(text)) continue;
        const m = text.match(moduleAssignRe);
        if (m) moduleChangedSymbolsSet.add(m[1]);
      }
    }
    const moduleChangedSymbols = [...moduleChangedSymbolsSet].sort();

    // Tag functions that reference module-level changed symbols (best-effort).
    if (moduleChangedSymbols.length > 0) {
      for (const fn of changedFnsInFile) {
        const body = sourceLines.slice(fn.startLine - 1, fn.endLine).join('\n');
        const deps = moduleChangedSymbols.filter((sym) => new RegExp(`\\b${sym}\\b`).test(body));
        if (deps.length) fn.moduleDeps = deps;
      }
    }

    files.push({
      path: pf.path,
      hunks: pf.hunks,
      changedRanges,
      moduleChangedRanges,
      moduleChangedSymbols,
      moduleExcludedLineNumbers: [...functionOwnedLineNumbers],
      sourceLines
    });
  }

  return { functionsById, files };
}
