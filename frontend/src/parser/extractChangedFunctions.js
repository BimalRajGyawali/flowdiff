/**
 * Extracts changed/added functions from parsed diff.
 * Python only: detects top-level `def` / `async def` and class methods (defs inside `class` bodies).
 * Function ids: `path:name` at module scope, `path:Outer.Inner.methodName` for class methods.
 * Includes all .py files (tests appear in the file list; test roots are not listed as flows).
 * Requires full-file source from the PR head when available: compressed hunks often omit `def`
 * lines; overlap with `visibleLines` uses real new-file line numbers, so spans must come from
 * {@link listAllPythonFunctionMetas} on the complete file, not hunk-stitched text alone.
 */

/** @typedef {import('./parseDiff.js').ParsedFile} ParsedFile */
import { buildVisibleLines } from './buildVisibleLines.js';
import { computePythonFunctionEndLine, listAllPythonFunctionMetas } from './pythonDefScan.js';
import { getQualifiedClassPrefix, getEnclosingClassHeaderLines } from './pythonClassContext.js';

const PY_DEF_LINE_REGEX = /^(\s*)(?:async\s+)?def\s+(\w+)\b/;

function collectDeletedFunctionMetas(pf, survivingFunctionNames = new Set()) {
  const deletedFns = [];
  for (const hunk of pf.hunks || []) {
    let oldLine = hunk.oldStart;
    for (const rawLine of hunk.lines || []) {
      if (rawLine.startsWith('-')) {
        const content = rawLine.slice(1);
        const match = content.match(PY_DEF_LINE_REGEX);
        if (match) {
          const name = match[2];
          // If this function name still exists in the new file, treat this as a modification
          // (e.g. signature change) rather than a true deletion.
          if (survivingFunctionNames.has(name)) {
            oldLine += 1;
            continue;
          }
          deletedFns.push({
            id: `${pf.path}:deleted:${name}:${oldLine}`,
            name,
            file: pf.path,
            startLine: oldLine,
            endLine: oldLine,
            snippet: content,
            changed: true,
            changeType: 'deleted',
            kind: 'function'
          });
        }
        oldLine += 1;
        continue;
      }
      if (rawLine.startsWith('+')) {
        continue;
      }
      oldLine += 1;
    }
  }
  return deletedFns;
}

/**
 * `computePythonFunctionEndLine` can run past the next method in a class when boundaries are
 * ambiguous; cap so spans never include a following `def` at the same or lower indent.
 * @param {{ lineNum: number, indent: number }[]} defsInFileOrder
 * @param {number} index
 * @param {number} endLine
 * @param {number} fileEndLine
 */
function clampEndToNextSiblingDef(defsInFileOrder, index, endLine, fileEndLine) {
  const cur = defsInFileOrder[index];
  for (let j = index + 1; j < defsInFileOrder.length; j++) {
    const n = defsInFileOrder[j];
    if (n.lineNum <= cur.lineNum) continue;
    if (n.indent <= cur.indent) {
      return Math.min(endLine, n.lineNum - 1);
    }
  }
  return Math.min(endLine, fileEndLine);
}

/**
 * @param {{ files: ParsedFile[] }} parsed
 * @param {Record<string, string>} [fileContentsByPath={}]
 * @returns {{ functionsById: Record<string, import('../flowSchema.js').FunctionMeta>, files: import('../flowSchema.js').File[] }}
 */
export function extractChangedFunctions(parsed, fileContentsByPath = {}) {
  const functionsById = {};
  const files = [];

  for (const pf of parsed.files) {
    if (!pf.path.endsWith('.py')) continue;

    const changedRanges = pf.hunks.flatMap((h) => {
      const start = h.newStart;
      const end = h.newStart + (h.newLines || 1) - 1;
      return [{ start, end }];
    });

    const visibleLines = buildVisibleLines(pf.hunks);
    const hasFullFile = typeof fileContentsByPath[pf.path] === 'string';

    // GitHub hunks are often compressed: changed lines inside a function may appear without the
    // `def` line. `visibleLines` still carry real new-file line numbers for those edits. Matching
    // them to function bodies requires the full PR head file so we can find every `def` and its
    // span (`listAllPythonFunctionMetas`). Stitched hunk-only text has wrong length/coordinates.
    const sourceText = fileContentsByPath[pf.path] ?? visibleLines.map((line) => line.content).join('\n');
    const sourceLines = sourceText.split('\n');
    const fileEndLine = sourceLines.length;

    /** @type {{ name: string, lineNum: number, indent: number, snippet: string, defAdded: boolean, endLine?: number }[]} */
    let defs;
    if (hasFullFile) {
      defs = listAllPythonFunctionMetas(sourceLines).map((m) => {
        const visibleLine = visibleLines.find((item) => item.lineNumber === m.startLine);
        return {
          name: m.name,
          lineNum: m.startLine,
          indent: m.indent,
          snippet: m.snippet,
          defAdded: visibleLine?.added ?? false,
          endLine: m.endLine
        };
      });
    } else {
      defs = [];
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
    }

    /** @type {import('../flowSchema.js').FunctionMeta[]} */
    const changedFnsInFile = [];
    const survivingFunctionNames = new Set(defs.map((d) => d.name));

    // Decorators immediately above a `def` belong to the function, not module context.
    // This includes multi-line decorators where continuation lines are indented further.
    const decoratorLineNumbers = new Set();
    const decoratorStartByDefLine = new Map();
    for (const d of defs) {
      let decoratorStart = d.lineNum;
      let seenDecoratorStart = false;
      // Walk upward from the line above `def`, collecting the contiguous decorator block:
      // - lines starting with '@' at the same indent as the def
      // - continuation lines inside decorator arguments (indented lines and bare closing brackets)
      for (let idx = d.lineNum - 2; idx >= 0; idx--) {
        const text = sourceLines[idx] ?? '';
        if (text.trim().length === 0) break;
        const indentMatch = text.match(/^(\s*)/);
        const indentLen = (indentMatch?.[1] ?? '').length;

        const isDecoratorStart = indentLen === d.indent && text.trimStart().startsWith('@');
        const isDecoratorContinuation = indentLen > d.indent;
        const isDecoratorClosingLine = indentLen === d.indent && /^[)\]}]+,?\s*$/.test(text.trim());

        // Regular decorator line anchors the decorator block.
        if (isDecoratorStart) {
          seenDecoratorStart = true;
          decoratorLineNumbers.add(idx + 1);
          decoratorStart = idx + 1;
          continue;
        }

        // Before seeing any '@', only allow a closing-bracket line (for multiline decorator args).
        if (!seenDecoratorStart) {
          if (isDecoratorClosingLine) {
            decoratorLineNumbers.add(idx + 1);
            decoratorStart = idx + 1;
            continue;
          }
          break;
        }

        // After decorator block is anchored, allow continuation/closing lines.
        if (isDecoratorContinuation || isDecoratorClosingLine) {
          decoratorLineNumbers.add(idx + 1);
          decoratorStart = idx + 1;
          continue;
        }

        break;
      }
      decoratorStartByDefLine.set(d.lineNum, decoratorStart);
    }

    /** @type {{ start: number, end: number }[]} */
    const functionOwnedRanges = [];

    for (let i = 0; i < defs.length; i++) {
      const { name, lineNum, snippet, indent, defAdded } = defs[i];
      const startLine = decoratorStartByDefLine.get(lineNum) ?? lineNum;
      let endLine =
        defs[i].endLine ??
        computePythonFunctionEndLine(sourceLines, lineNum, indent, fileEndLine);
      endLine = clampEndToNextSiblingDef(defs, i, endLine, fileEndLine);

      const className = getQualifiedClassPrefix(sourceLines, lineNum, indent);
      const isMethod = Boolean(className);
      const classHeaderLines = isMethod
        ? getEnclosingClassHeaderLines(sourceLines, lineNum, indent)
        : [];

      // For module-context exclusion, treat the entire function span [startLine, endLine]
      // (including the def line) as "owned" by the function.
      functionOwnedRanges.push({ start: startLine, end: endLine });

      const hasAddedChange = visibleLines.some(
        (line) => line.lineNumber >= startLine && line.lineNumber <= endLine && line.added
      );
      const hasDeletedChange = visibleLines.some((line) => {
        if (line.lineNumber < startLine || line.lineNumber > endLine) return false;
        if (!line.touchedByDeletion) return false;
        // A deletion immediately before `def ...` can mark the def line as touched even when this
        // function body did not change (e.g. previous function removed with no blank-line gap).
        // Treat deletion touch on the function start line as non-body noise.
        return line.lineNumber !== startLine;
      });
      const hasAnyChange = hasAddedChange || hasDeletedChange;

      // Only keep functions whose body changed (added or deleted lines).
      if (!hasAnyChange) continue;

      // Classification:
      // - "added": function is newly created (its def line is newly added and there are no deletions in its body)
      // - "modified": function existed before and its body has added and/or deleted lines
      const isNewFunction = defAdded && !hasDeletedChange;
      const changeType = isNewFunction ? 'added' : 'modified';

      const id = isMethod ? `${pf.path}:${className}.${name}` : `${pf.path}:${name}`;
      const fnMeta = {
        id,
        name,
        file: pf.path,
        startLine,
        endLine,
        snippet: snippet ?? `def ${name}(`,
        changed: true,
        changeType,
        kind: isMethod ? 'method' : 'function',
        ...(isMethod ? { className } : {})
      };
      functionsById[id] = fnMeta;
      changedFnsInFile.push(fnMeta);

      for (const cln of classHeaderLines) {
        decoratorLineNumbers.add(cln);
      }
    }

    const deletedFns = collectDeletedFunctionMetas(pf, survivingFunctionNames);
    for (const deletedFn of deletedFns) {
      if (!functionsById[deletedFn.id]) {
        functionsById[deletedFn.id] = deletedFn;
        changedFnsInFile.push(deletedFn);
      }
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
