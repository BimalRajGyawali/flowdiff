/**
 * Builds flows from changed Python functions by detecting call relationships.
 * Call graph: caller -> callee. Supports cross-file calls (e.g. imported functions).
 * Edges connect changed functions only when the call appears on a **diff-touched** line in the
 * caller (added or deletion-adjacent), aligned with {@link extractChangedFunctions}.
 * Callees not in that map are ignored. Unchanged lines in the body do not create edges.
 * Flows are rooted at entry functions (no incoming edges).
 * Flow name = root function name. Test roots (test_* names or test paths) are omitted from flows.
 *
 * `self.method(` is resolved only to changed methods with the same {@link FunctionMeta#className}
 * as the caller. For other calls (`super().asdict()`, `obj.foo()`, bare `foo()`), if several
 * changed symbols share a short name we only keep callees in the **caller's file**; otherwise we
 * add no edge (avoids linking `super().asdict()` to every `asdict` in the PR).
 */

import { buildVisibleLines } from './buildVisibleLines.js';
import { isTestFile, isTestFunction } from './isTestFile.js';
import { getFunctionDisplayName } from './functionDisplayName.js';

// Matches: foo(  or  self.foo(  or  obj.foo( — used after masking out `self....(` (see below).
const PY_CALL_REGEX = /(?:^|\s)(?:self\.|[\w]+\.)?(\w+)\s*\(/g;

/** `self.method(` — group 1 is method name */
const PY_SELF_CALL_REGEX = /\bself\.(\w+)\s*\(/g;
const PY_DEF_OR_CLASS_LINE_REGEX = /^\s*(?:async\s+def|def|class)\b/;

const PY_KEYWORDS = new Set(['def', 'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally', 'class', 'return', 'raise', 'yield', 'assert', 'lambda', 'and', 'or', 'not', 'in', 'is']);

/** All functions with a given name (across files). */
function getFunctionsByName(functionsById, name) {
  return Object.entries(functionsById)
    .filter(([, fn]) => fn.name === name && fn.changeType !== 'deleted')
    .map(([id]) => id);
}

/**
 * Many PRs touch the same method name on unrelated base classes (`asdict`, `dict`, …).
 * Without type info, only link same-name callees in the caller's file when there is ambiguity.
 * @param {import('../flowSchema.js').FunctionMeta} caller
 * @param {string[]} calleeIds
 * @param {Record<string, import('../flowSchema.js').FunctionMeta>} functionsById
 */
function resolveNameCollisions(caller, calleeIds, functionsById) {
  const base = calleeIds.filter((id) => id !== caller.id);
  if (base.length <= 1) return base;

  const inCallerFile = base.filter((id) => functionsById[id]?.file === caller.file);
  if (inCallerFile.length === 1) return inCallerFile;
  if (inCallerFile.length > 1 && caller.className) {
    const sameClass = inCallerFile.filter((id) => functionsById[id]?.className === caller.className);
    if (sameClass.length === 1) return sameClass;
    if (sameClass.length > 0) return sameClass;
  }
  if (inCallerFile.length > 0) return inCallerFile;
  return [];
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

    const visibleLines = buildVisibleLines(pf.hunks);
    const diffLineNumbers = new Set();
    const lineContentByNumber = new Map();
    for (const vl of visibleLines) {
      if (vl.lineNumber == null) continue;
      lineContentByNumber.set(vl.lineNumber, vl.content);
      if (vl.added || vl.touchedByDeletion) diffLineNumbers.add(vl.lineNumber);
    }

    const fullLines = fileContentsByPath[pf.path]?.split('\n');
    const lineText = (ln) =>
      fullLines ? (fullLines[ln - 1] ?? '') : (lineContentByNumber.get(ln) ?? '');

    for (let i = 0; i < fnsInFile.length; i++) {
      const caller = fnsInFile[i];
      const callOrder = [];

      for (let ln = caller.startLine; ln <= caller.endLine; ln++) {
        if (!diffLineNumbers.has(ln)) continue;
        const line = lineText(ln);
        // Prevent false edges like `def main(` being treated as a call to another `main`.
        if (PY_DEF_OR_CLASS_LINE_REGEX.test(line)) continue;

        function pushCalleeEdges(calleeIds) {
          for (const calleeId of calleeIds) {
            const key = `${caller.id}->${calleeId}`;
            const existing = callOrder.find((e) => e.key === key);
            if (!existing) {
              const idx = callOrder.length;
              callOrder.push({ key, calleeId, callIndex: idx });
            }
          }
        }

        // `self.method(` — only link to changed methods on the same class. Otherwise every
        // `self.asdict()` matches every `asdict` in the PR (llms.py, prompts/base.py, …).
        PY_SELF_CALL_REGEX.lastIndex = 0;
        let m;
        while ((m = PY_SELF_CALL_REGEX.exec(line)) !== null) {
          const calleeName = m[1];
          if (PY_KEYWORDS.has(calleeName)) continue;
          let calleeIds = getFunctionsByName(functionsById, calleeName).filter(
            (id) => id !== caller.id && functionsById[id]?.changed !== false
          );
          if (caller.className) {
            const narrowed = calleeIds.filter((id) => functionsById[id]?.className === caller.className);
            calleeIds = narrowed;
          }
          pushCalleeEdges(resolveNameCollisions(caller, calleeIds, functionsById));
        }

        PY_SELF_CALL_REGEX.lastIndex = 0;
        const masked = line.replace(PY_SELF_CALL_REGEX, (match) => ' '.repeat(match.length));
        PY_CALL_REGEX.lastIndex = 0;
        while ((m = PY_CALL_REGEX.exec(masked)) !== null) {
          const calleeName = m[1];
          if (PY_KEYWORDS.has(calleeName)) continue;

          let calleeIds = getFunctionsByName(functionsById, calleeName).filter(
            (id) => id !== caller.id && functionsById[id]?.changed !== false
          );
          calleeIds = resolveNameCollisions(caller, calleeIds, functionsById);
          pushCalleeEdges(calleeIds);
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

  // Suppress “inner” roots that are already reachable from another (main) root.
  // This avoids showing duplicated flows for functions that are already part of
  // another flow’s call-tree in the UI.
  const adjacency = new Map(); // callerId -> calleeIds[]
  for (const e of edges) {
    const list = adjacency.get(e.callerId) || [];
    list.push(e.calleeId);
    adjacency.set(e.callerId, list);
  }

  const rootIds = Array.from(roots);
  const shownRootIds = rootIds.filter((rootId) => {
    const root = functionsById[rootId];
    return root && !isTestFunction(root);
  });
  const shownRootIdSet = new Set(shownRootIds);

  const rootsToRemove = new Set();
  for (const src of shownRootIds) {
    const visited = new Set([src]);
    const stack = [src];
    while (stack.length) {
      const cur = stack.pop();
      const outs = adjacency.get(cur) || [];
      for (const nxt of outs) {
        if (visited.has(nxt)) continue;
        visited.add(nxt);
        stack.push(nxt);
      }
    }
    for (const maybeRoot of visited) {
      if (maybeRoot !== src && shownRootIdSet.has(maybeRoot)) rootsToRemove.add(maybeRoot);
    }
  }

  const filteredRootIds = rootIds.filter((id) => !rootsToRemove.has(id));

  const flows = filteredRootIds
    .map((rootId) => {
      const root = functionsById[rootId];
      return {
        id: rootId,
        rootId,
        name: root ? getFunctionDisplayName(root) : rootId.split(':').pop()
      };
    })
    .filter((f) => {
      const root = functionsById[f.rootId];
      return root && !isTestFunction(root);
    });

  return { flows, edges };
}
