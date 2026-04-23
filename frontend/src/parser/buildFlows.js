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

/**
 * Count unique nodes reachable from root (including root), cycle-safe.
 * @param {string} rootId
 * @param {Map<string, string[]>} adjacency
 */
function flowSizeFromRoot(rootId, adjacency) {
  const visited = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop();
    const outs = adjacency.get(cur) || [];
    for (const nxt of outs) {
      if (visited.has(nxt)) continue;
      visited.add(nxt);
      stack.push(nxt);
    }
  }
  return visited.size;
}

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
        edges.push({ callerId: caller.id, calleeId, callIndex, relationType: 'call' });
      }
    }
  }

  // Add class-membership links for changed methods in the same class.
  // We model these as synthetic edges from an anchor method to sibling methods so
  // existing tree/code traversal can include class-related peers.
  const edgeKeys = new Set(edges.map((e) => `${e.callerId}->${e.calleeId}`));
  const outgoingByCaller = new Map();
  for (const e of edges) {
    const v = outgoingByCaller.get(e.callerId) || [];
    v.push(e.callIndex);
    outgoingByCaller.set(e.callerId, v);
  }
  function nextCallIndex(callerId) {
    const used = outgoingByCaller.get(callerId) || [];
    const n = used.length ? Math.max(...used) + 1 : 0;
    used.push(n);
    outgoingByCaller.set(callerId, used);
    return n;
  }
  const changedMethods = Object.entries(functionsById)
    .filter(([, fn]) => fn?.kind === 'method' && fn?.className && fn?.changeType !== 'deleted');
  const classBuckets = new Map(); // `${file}::${className}` -> [{id, fn}]
  for (const [id, fn] of changedMethods) {
    const k = `${fn.file}::${fn.className}`;
    const list = classBuckets.get(k) || [];
    list.push({ id, fn });
    classBuckets.set(k, list);
  }
  for (const list of classBuckets.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.fn.startLine - b.fn.startLine);
    const anchorId = list[0].id;
    const memberIdSet = new Set(list.map((x) => x.id));
    const methodsInAnyCallRelation = new Set(
      edges
        .filter(
          (e) =>
            e.relationType === 'call' &&
            (memberIdSet.has(e.callerId) || memberIdSet.has(e.calleeId))
        )
        .flatMap((e) => [e.callerId, e.calleeId])
    );
    for (let i = 1; i < list.length; i++) {
      const calleeId = list[i].id;
      // If a method already participates in any call relation in this class component,
      // do not add an extra synthetic class edge for it (prevents duplicate rhizome rows).
      if (methodsInAnyCallRelation.has(calleeId)) continue;
      const key = `${anchorId}->${calleeId}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        callerId: anchorId,
        calleeId,
        callIndex: nextCallIndex(anchorId),
        relationType: 'class'
      });
    }
  }

  // Build undirected connectivity for rhizome grouping:
  // connected by either direct call relationship or class-membership links above.
  const eligibleIds = Object.entries(functionsById)
    .filter(([, fn]) => fn && fn.changeType !== 'deleted' && !isTestFunction(fn))
    .map(([id]) => id);
  const eligibleSet = new Set(eligibleIds);
  const undirected = new Map();
  function link(a, b) {
    if (!eligibleSet.has(a) || !eligibleSet.has(b)) return;
    if (!undirected.has(a)) undirected.set(a, new Set());
    if (!undirected.has(b)) undirected.set(b, new Set());
    undirected.get(a).add(b);
    undirected.get(b).add(a);
  }
  for (const e of edges) link(e.callerId, e.calleeId);

  const components = [];
  const seen = new Set();
  for (const id of eligibleIds) {
    if (seen.has(id)) continue;
    const comp = new Set([id]);
    seen.add(id);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      const neigh = undirected.get(cur) || new Set();
      for (const nxt of neigh) {
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        comp.add(nxt);
        stack.push(nxt);
      }
    }
    components.push(comp);
  }

  const adjacency = new Map(); // callerId -> calleeIds[]
  for (const e of edges) {
    const list = adjacency.get(e.callerId) || [];
    list.push(e.calleeId);
    adjacency.set(e.callerId, list);
  }
  function reachableFrom(rootId, members) {
    const reached = new Set([rootId]);
    const stack = [rootId];
    while (stack.length) {
      const cur = stack.pop();
      const outs = adjacency.get(cur) || [];
      for (const nxt of outs) {
        if (!members.has(nxt) || reached.has(nxt)) continue;
        reached.add(nxt);
        stack.push(nxt);
      }
    }
    return reached;
  }

  const flows = components
    .map((members) => {
      const memberList = [...members];
      const inDegree = new Map(memberList.map((id) => [id, 0]));
      for (const e of edges) {
        if (members.has(e.callerId) && members.has(e.calleeId)) {
          inDegree.set(e.calleeId, (inDegree.get(e.calleeId) || 0) + 1);
        }
      }
      const roots = memberList.filter((id) => (inDegree.get(id) || 0) === 0);
      const candidateIds = roots.length ? roots : memberList;
      candidateIds.sort((a, b) => {
        const fa = functionsById[a];
        const fb = functionsById[b];
        if ((fa?.file || '') !== (fb?.file || '')) return String(fa?.file || '').localeCompare(String(fb?.file || ''));
        if ((fa?.startLine || 0) !== (fb?.startLine || 0)) return (fa?.startLine || 0) - (fb?.startLine || 0);
        return String(fa?.name || '').localeCompare(String(fb?.name || ''));
      });
      const rootId = candidateIds[0];

      // Ensure every member is reachable from root in directed traversal used by UI.
      const reached = reachableFrom(rootId, members);
      for (const id of memberList) {
        if (id === rootId || reached.has(id)) continue;
        const k = `${rootId}->${id}`;
        if (edgeKeys.has(k)) continue;
        edgeKeys.add(k);
        edges.push({
          callerId: rootId,
          calleeId: id,
          callIndex: nextCallIndex(rootId),
          relationType: 'class'
        });
      }

      const root = functionsById[rootId];
      return {
        id: rootId,
        rootId,
        name: root ? getFunctionDisplayName(root) : rootId.split(':').pop(),
        _size: memberList.length
      };
    })
    .sort((a, b) => {
      if (a._size !== b._size) return b._size - a._size;
      return String(a.name || '').localeCompare(String(b.name || ''));
    })
    .map(({ _size, ...rest }) => rest);

  return { flows, edges };
}
