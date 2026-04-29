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
 * Bare `ClassName(` (instantiation) is not treated as a call: changed `class` metas are excluded.
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

/** `Foo(` typically instantiates a class, not a call to a function; skip changed `class` metas. */
function excludeClassMetaNodes(functionsById, calleeIds) {
  return calleeIds.filter((id) => functionsById[id]?.kind !== 'class');
}

function topLevelClassName(className) {
  const raw = String(className || '').trim();
  if (!raw) return '';
  return raw.split('.')[0];
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
 * @returns {{ flows: import('../flowSchema.js').Flow[], edges: import('../flowSchema.js').Edge[], standaloneClassIds: string[], classDefAboveMethod: Record<string, string> }}
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
          calleeIds = excludeClassMetaNodes(functionsById, calleeIds);
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
          calleeIds = excludeClassMetaNodes(functionsById, calleeIds);
          calleeIds = resolveNameCollisions(caller, calleeIds, functionsById);
          pushCalleeEdges(calleeIds);
        }
      }

      for (const { calleeId, callIndex } of callOrder) {
        edges.push({ callerId: caller.id, calleeId, callIndex, relationType: 'call' });
      }
    }
  }

  // Two-stage rhizome grouping:
  // 1) call rhizomes rooted by forward-call entry points (shared descendants allowed)
  // 2) class-membership rhizomes only for methods with no call participation
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
  const eligibleIds = Object.entries(functionsById)
    .filter(([, fn]) => fn && fn.changeType !== 'deleted' && fn.kind !== 'class' && !isTestFunction(fn))
    .map(([id]) => id);
  const eligibleSet = new Set(eligibleIds);
  function compareFnIds(a, b) {
    const fa = functionsById[a];
    const fb = functionsById[b];
    if ((fa?.file || '') !== (fb?.file || '')) {
      return String(fa?.file || '').localeCompare(String(fb?.file || ''));
    }
    if ((fa?.startLine || 0) !== (fb?.startLine || 0)) {
      return (fa?.startLine || 0) - (fb?.startLine || 0);
    }
    if ((fa?.name || '') !== (fb?.name || '')) {
      return String(fa?.name || '').localeCompare(String(fb?.name || ''));
    }
    return String(a).localeCompare(String(b));
  }
  const callAdjacency = new Map();
  const callParticipants = new Set();
  const callInDegree = new Map();
  for (const e of edges) {
    if (e.relationType !== 'call') continue;
    if (!eligibleSet.has(e.callerId) || !eligibleSet.has(e.calleeId)) continue;
    const outs = callAdjacency.get(e.callerId) || new Set();
    outs.add(e.calleeId);
    callAdjacency.set(e.callerId, outs);
    if (eligibleSet.has(e.callerId)) callParticipants.add(e.callerId);
    if (eligibleSet.has(e.calleeId)) callParticipants.add(e.calleeId);
    callInDegree.set(e.calleeId, (callInDegree.get(e.calleeId) || 0) + 1);
    if (!callInDegree.has(e.callerId)) callInDegree.set(e.callerId, callInDegree.get(e.callerId) || 0);
  }
  function callReachableFrom(rootId) {
    const reached = new Set([rootId]);
    const stack = [rootId];
    while (stack.length) {
      const cur = stack.pop();
      const outs = callAdjacency.get(cur) || new Set();
      for (const nxt of outs) {
        if (reached.has(nxt)) continue;
        reached.add(nxt);
        stack.push(nxt);
      }
    }
    return reached;
  }
  const sortedCallParticipants = [...callParticipants].sort(compareFnIds);
  const callRoots = sortedCallParticipants
    .filter((id) => (callInDegree.get(id) || 0) === 0)
    .sort(compareFnIds);
  /** @type {{ rootId: string, members: Set<string> }[]} */
  const callRhizomes = [];
  const coveredByAnyCallRhizome = new Set();
  for (const rootId of callRoots) {
    const members = callReachableFrom(rootId);
    callRhizomes.push({ rootId, members });
    for (const id of members) coveredByAnyCallRhizome.add(id);
  }
  // Cycles can have no in-degree-zero root. Seed one deterministic call rhizome per remaining cycle.
  for (const id of sortedCallParticipants) {
    if (coveredByAnyCallRhizome.has(id)) continue;
    const members = callReachableFrom(id);
    callRhizomes.push({ rootId: id, members });
    for (const mid of members) coveredByAnyCallRhizome.add(mid);
  }

  // Secondary grouping by class-membership, only for methods with no call relations.
  const classBuckets = new Map(); // `${file}::${className}` -> [{id, fn}]
  for (const [id, fn] of Object.entries(functionsById)) {
    if (!eligibleSet.has(id)) continue;
    if (callParticipants.has(id)) continue;
    if (fn?.kind !== 'method' || !fn?.className) continue;
    const k = `${fn.file}::${topLevelClassName(fn.className)}`;
    const list = classBuckets.get(k) || [];
    list.push({ id, fn });
    classBuckets.set(k, list);
  }

  const classOnlyComponents = [];
  const classMembershipMethodIds = new Set();
  for (const list of classBuckets.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.fn.startLine - b.fn.startLine);
    const comp = new Set(list.map((x) => x.id));
    for (const mid of comp) classMembershipMethodIds.add(mid);
    classOnlyComponents.push(comp);
    const anchorId = list[0].id;
    for (let i = 1; i < list.length; i++) {
      const calleeId = list[i].id;
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

  const classAssigned = new Set();
  for (const comp of classOnlyComponents) {
    for (const id of comp) classAssigned.add(id);
  }
  const singletonRhizomes = [];
  for (const id of eligibleIds) {
    if (callParticipants.has(id) || classAssigned.has(id)) continue;
    singletonRhizomes.push({ rootId: id, members: new Set([id]) });
  }

  const classRhizomes = classOnlyComponents.map((members) => {
    const memberList = [...members].sort(compareFnIds);
    return { rootId: memberList[0], members };
  });

  // Merge disconnected rhizomes that are all methods from the same class into one linear flow.
  // Example: C.m1->C.m2, C.m4->C.m5, C.m7->C.m8 => one flow for class C.
  function singleClassKeyForMembers(members) {
    let key = null;
    for (const id of members) {
      const fn = functionsById[id];
      if (!fn || fn.kind !== 'method' || !fn.className || !fn.file) return null;
      const nextKey = `${fn.file}::${topLevelClassName(fn.className)}`;
      if (key == null) key = nextKey;
      else if (key !== nextKey) return null;
    }
    return key;
  }
  const rhizomes = [...callRhizomes, ...classRhizomes, ...singletonRhizomes];
  const rhizomeByRootId = new Map(rhizomes.map((r) => [r.rootId, r]));
  const singleClassRootsByKey = new Map();
  for (const r of rhizomes) {
    const classKey = singleClassKeyForMembers(r.members);
    if (!classKey) continue;
    const list = singleClassRootsByKey.get(classKey) || [];
    list.push(r.rootId);
    singleClassRootsByKey.set(classKey, list);
  }
  const mergeCandidateKeys = [...singleClassRootsByKey.entries()]
    .filter(([, roots]) => roots.length >= 2)
    .map(([key]) => key);
  const removedRoots = new Set();
  // Merge only when one class-key clearly dominates disconnected single-class rhizomes.
  if (mergeCandidateKeys.length === 1) {
    const roots = singleClassRootsByKey.get(mergeCandidateKeys[0]) || [];
    if (roots.length >= 2) {
      const sortedRoots = [...roots].sort(compareFnIds);
      let primaryRoot = sortedRoots[0];
      let bestStart = Number.POSITIVE_INFINITY;
      for (const rootId of sortedRoots) {
        const part = rhizomeByRootId.get(rootId);
        if (!part) continue;
        let minStartInRhizome = Number.POSITIVE_INFINITY;
        for (const id of part.members) {
          const fn = functionsById[id];
          if (!fn || fn.kind !== 'method' || fn.changeType === 'deleted') continue;
          const s = Number(fn.startLine) || Number.POSITIVE_INFINITY;
          if (s < minStartInRhizome) minStartInRhizome = s;
        }
        if (minStartInRhizome < bestStart) {
          bestStart = minStartInRhizome;
          primaryRoot = rootId;
        } else if (minStartInRhizome === bestStart && compareFnIds(rootId, primaryRoot) < 0) {
          primaryRoot = rootId;
        }
      }
      const primary = rhizomeByRootId.get(primaryRoot);
      if (primary) {
        const effectivePrimary = primary;
        for (const rootId of sortedRoots) {
          if (rootId === primaryRoot) continue;
          const part = rhizomeByRootId.get(rootId);
          if (!part) continue;
          for (const id of part.members) effectivePrimary.members.add(id);
          const key = `${primaryRoot}->${rootId}`;
          if (!edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push({
              callerId: primaryRoot,
              calleeId: rootId,
              callIndex: nextCallIndex(primaryRoot),
              relationType: 'class'
            });
          }
          removedRoots.add(rootId);
        }
      }
    }
  }
  const mergedRhizomes = rhizomes.filter((r) => !removedRoots.has(r.rootId));

  // Where to show a changed class definition in the code pane: above a method (not in the rhizome tree).
  // — Class-membership rhizome: class diff only above the first method in that group (by source line).
  // — Call-only: class diff only above the first method (by source line) for that class.
  // — No changed methods: standaloneClassIds (tree section below rhizomes).
  const classDefAboveMethod = {};
  const standaloneClassIds = [];
  const classNodes = Object.values(functionsById).filter(
    (fn) => fn?.kind === 'class' && fn.changeType !== 'deleted'
  );
  for (const cls of classNodes) {
    const methodIds = Object.entries(functionsById)
      .filter(
        ([, fn]) =>
          fn?.kind === 'method' &&
          topLevelClassName(fn?.className) === topLevelClassName(cls.className) &&
          fn?.file === cls.file &&
          fn.changeType !== 'deleted'
      )
      .map(([id]) => id);
    if (methodIds.length === 0) {
      standaloneClassIds.push(cls.id);
      continue;
    }

    const members = methodIds.filter((id) => classMembershipMethodIds.has(id));
    const hasMembership = members.length >= 2;
    const idSort = (a, b) => {
      const fa = functionsById[a];
      const fb = functionsById[b];
      if ((fa?.startLine || 0) !== (fb?.startLine || 0)) return (fa?.startLine || 0) - (fb?.startLine || 0);
      return a.localeCompare(b);
    };
    if (hasMembership) {
      const sortedMembers = [...members].sort(idSort);
      if (sortedMembers[0]) classDefAboveMethod[sortedMembers[0]] = cls.id;
    } else {
      const sorted = [...methodIds].sort(idSort);
      classDefAboveMethod[sorted[0]] = cls.id;
    }
  }
  const flowMemberIdsByRoot = new Map(mergedRhizomes.map((r) => [r.rootId, r.members]));

  // Flow ordering prefers class-linear reading:
  // 1) flow containing a method with class-def badge ("C")
  // 2) other flows touching methods of that same class
  // then fallback to existing group/size/name sorting.
  const classOrderByKey = new Map();
  const classKeys = Object.values(functionsById)
    .filter((fn) => fn?.kind === 'class' && fn.changeType !== 'deleted')
    .sort(compareFnIds)
    .map((fn) => `${fn.file}::${topLevelClassName(fn.className)}`);
  for (const key of classKeys) {
    if (!classOrderByKey.has(key)) classOrderByKey.set(key, classOrderByKey.size);
  }

  const anchorClassKeyByFlowRoot = new Map();
  for (const [methodId, classId] of Object.entries(classDefAboveMethod)) {
    const methodMeta = functionsById[methodId];
    const classMeta = functionsById[classId];
    if (!methodMeta || !classMeta) continue;
    const classKey = `${classMeta.file}::${topLevelClassName(classMeta.className)}`;
    for (const [rootId, memberIds] of flowMemberIdsByRoot.entries()) {
      if (!memberIds.has(methodId)) continue;
      const prevKey = anchorClassKeyByFlowRoot.get(rootId);
      if (!prevKey) {
        anchorClassKeyByFlowRoot.set(rootId, classKey);
        continue;
      }
      const prevOrder = classOrderByKey.get(prevKey) ?? Number.POSITIVE_INFINITY;
      const nextOrder = classOrderByKey.get(classKey) ?? Number.POSITIVE_INFINITY;
      if (nextOrder < prevOrder) anchorClassKeyByFlowRoot.set(rootId, classKey);
    }
  }

  const dependentClassKeyByFlowRoot = new Map();
  for (const [rootId, memberIds] of flowMemberIdsByRoot.entries()) {
    if (anchorClassKeyByFlowRoot.has(rootId)) continue;
    let bestKey = null;
    let bestOrder = Number.POSITIVE_INFINITY;
    for (const id of memberIds) {
      const fn = functionsById[id];
      if (!fn || fn.kind !== 'method' || !fn.className) continue;
      const classKey = `${fn.file}::${topLevelClassName(fn.className)}`;
      if (!classOrderByKey.has(classKey)) continue;
      const ord = classOrderByKey.get(classKey) ?? Number.POSITIVE_INFINITY;
      if (ord < bestOrder) {
        bestOrder = ord;
        bestKey = classKey;
      }
    }
    if (bestKey) dependentClassKeyByFlowRoot.set(rootId, bestKey);
  }

  const flows = mergedRhizomes
    .map(({ rootId, members }) => {
      const root = functionsById[rootId];
      const size = members.size;
      const isCallRhizome = callRhizomes.some((r) => r.rootId === rootId);
      const isClassRhizome = classRhizomes.some((r) => r.rootId === rootId);
      let groupRank = 2; // 0: call rhizome (>1), 1: class-membership rhizome, 2: singleton
      if (isCallRhizome && size > 1) groupRank = 0;
      else if (isClassRhizome) groupRank = 1;

      const anchorClassKey = anchorClassKeyByFlowRoot.get(rootId) ?? null;
      const dependentClassKey = dependentClassKeyByFlowRoot.get(rootId) ?? null;
      const classClusterKey = anchorClassKey || dependentClassKey;
      const classClusterOrder =
        classClusterKey != null
          ? (classOrderByKey.get(classClusterKey) ?? Number.POSITIVE_INFINITY)
          : Number.POSITIVE_INFINITY;
      const classRole = anchorClassKey ? 0 : dependentClassKey ? 1 : 2; // 0 anchor, 1 dependent, 2 unrelated

      return {
        id: rootId,
        rootId,
        name: root ? getFunctionDisplayName(root) : rootId.split(':').pop(),
        _size: size,
        _groupRank: groupRank,
        _classClusterOrder: classClusterOrder,
        _classRole: classRole
      };
    })
    .sort((a, b) => {
      if (a._classClusterOrder !== b._classClusterOrder) return a._classClusterOrder - b._classClusterOrder;
      if (a._classRole !== b._classRole) return a._classRole - b._classRole;
      if (a._groupRank !== b._groupRank) return a._groupRank - b._groupRank;
      if (a._size !== b._size) return b._size - a._size;
      return String(a.name || '').localeCompare(String(b.name || ''));
    })
    .map(({ _size, _groupRank, _classClusterOrder, _classRole, ...rest }) => rest);

  return { flows, edges, standaloneClassIds, classDefAboveMethod };
}
