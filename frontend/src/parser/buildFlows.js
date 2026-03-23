/**
 * Builds flows from changed Python functions by detecting call relationships.
 * Call graph: caller -> callee. Supports cross-file calls (e.g. imported functions).
 * Flows are rooted at entry functions (no incoming edges).
 * Flow name = root function name. Test roots (test_* names or test paths) are omitted from flows.
 */

import { buildVisibleLines } from './buildVisibleLines.js';
import { isTestFile, isTestFunction } from './isTestFile.js';

// Matches: foo(  or  self.foo(  or  obj.foo(
const PY_CALL_REGEX = /(?:^|\s)(?:self\.|[\w]+\.)?(\w+)\s*\(/g;

const PY_KEYWORDS = new Set(['def', 'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally', 'class', 'return', 'raise', 'yield', 'assert', 'lambda', 'and', 'or', 'not', 'in', 'is']);

/** All functions with a given name (across files). */
function getFunctionsByName(functionsById, name) {
  return Object.entries(functionsById)
    .filter(([, fn]) => fn.name === name)
    .map(([id]) => id);
}

/**
 * @param {Record<string, import('../flowSchema.js').FunctionMeta>} functionsById
 * @param {{ files: { path: string, hunks: { lines: string[] }[] }[] }} parsed
 * @param {Record<string, string>} [fileContentsByPath={}]
 * @returns {{ flows: import('../flowSchema.js').Flow[], edges: import('../flowSchema.js').Edge[] }}
 */
export function buildFlows(functionsById, parsed, fileContentsByPath = {}) {
  const edges = [];

  const pyFiles = parsed.files.filter((pf) => pf.path.endsWith('.py'));

  for (const pf of pyFiles) {
    const fnsInFile = Object.values(functionsById)
      .filter((f) => f.file === pf.path)
      .sort((a, b) => a.startLine - b.startLine);
    if (fnsInFile.length === 0) continue;

    const sourceText = fileContentsByPath[pf.path];
    const sourceLines = sourceText
      ? sourceText.split('\n')
      : buildVisibleLines(pf.hunks).map((line) => line.content);

    for (let i = 0; i < fnsInFile.length; i++) {
      const caller = fnsInFile[i];
      const body = sourceLines
        .slice(caller.startLine - 1, caller.endLine)
        .filter(Boolean)
        .join('\n');

      const callOrder = [];
      let m;
      PY_CALL_REGEX.lastIndex = 0;
      while ((m = PY_CALL_REGEX.exec(body)) !== null) {
        const calleeName = m[1];
        if (PY_KEYWORDS.has(calleeName)) continue;

        const calleeIds = getFunctionsByName(functionsById, calleeName).filter((id) => id !== caller.id);
        for (const calleeId of calleeIds) {
          const key = `${caller.id}->${calleeId}`;
          const existing = callOrder.find((e) => e.key === key);
          if (!existing) {
            const idx = callOrder.length;
            callOrder.push({ key, calleeId, callIndex: idx });
          }
        }
      }

      for (const { calleeId, callIndex } of callOrder) {
        edges.push({ callerId: caller.id, calleeId, callIndex });
      }
    }
  }

  const roots = new Set(Object.keys(functionsById));
  for (const e of edges) {
    const callerPath = functionsById[e.callerId]?.file;
    // Tests often call production APIs (e.g. block.run); those edges must not
    // strip production entrypoints from the root set.
    if (isTestFile(callerPath ?? '')) continue;
    roots.delete(e.calleeId);
  }

  const flows = Array.from(roots)
    .map((rootId) => {
      const root = functionsById[rootId];
      return {
        id: rootId,
        rootId,
        name: root ? root.name : rootId.split(':').pop()
      };
    })
    .filter((f) => {
      const root = functionsById[f.rootId];
      return root && !isTestFunction(root);
    });

  return { flows, edges };
}
