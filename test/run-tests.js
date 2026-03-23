/**
 * Smoke tests for FlowDiff parser, flow ordering, and data contract.
 * Run: node test/run-tests.js
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseDiff } from '../frontend/src/parser/parseDiff.js';
import { extractChangedFunctions } from '../frontend/src/parser/extractChangedFunctions.js';
import { buildFlows } from '../frontend/src/parser/buildFlows.js';
import { augmentCallersInFunctionsById } from '../frontend/src/parser/augmentCallersInFunctionsById.js';
import { isTestFile } from '../frontend/src/parser/isTestFile.js';
import { parsePrUrl } from '../frontend/src/github/parsePrUrl.js';
import { normalizeMergedPatchDiffLines } from '../frontend/src/parser/mergeDiffArtifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    throw e;
  }
}

console.log('FlowDiff smoke tests\n');

test('parsePrUrl extracts owner, repo, number', () => {
  const { owner, repo, number } = parsePrUrl('https://github.com/owner/repo/pull/123');
  assert(owner === 'owner');
  assert(repo === 'repo');
  assert(number === 123);
});

test('parsePrUrl accepts /changes and /files suffixes', () => {
  const a = parsePrUrl('https://github.com/owner/repo/pull/123/changes');
  assert(a.number === 123);
  const b = parsePrUrl('https://github.com/owner/repo/pull/123/files');
  assert(b.number === 123);
});

test('parsePrUrl throws on invalid URL', () => {
  let threw = false;
  try {
    parsePrUrl('https://example.com/foo');
  } catch {
    threw = true;
  }
  assert(threw);
});

test('parseDiff extracts files and hunks', () => {
  const diff = readFileSync(join(__dirname, 'fixtures/sample.diff'), 'utf8');
  const { files } = parseDiff(diff);
  assert(files.length >= 1);
  assert(files[0].path === 'src/example.py');
  assert(files[0].hunks.length >= 1);
});

test('normalizeMergedPatchDiffLines drops ctx when same new line is also added (merged hunks)', () => {
  const rows = [
    { type: 'ctx', newLineNumber: 5, content: '    perm_token = None' },
    { type: 'add', newLineNumber: 5, content: '    perm_token = None' }
  ];
  const out = normalizeMergedPatchDiffLines(rows);
  assert(out.length === 1);
  assert(out[0].type === 'add');
});

test('normalizeMergedPatchDiffLines drops ctx before -/+ when ctx duplicates the + line', () => {
  const rows = [
    { type: 'ctx', newLineNumber: 9, content: 'from backend.copilot.model import create_chat_session  # avoid circular import' },
    { type: 'del', newLineNumber: null, content: 'from backend.copilot.model import create_chat_session' },
    {
      type: 'add',
      newLineNumber: 10,
      content: 'from backend.copilot.model import create_chat_session  # avoid circular import'
    }
  ];
  const out = normalizeMergedPatchDiffLines(rows);
  assert(out.length === 2);
  assert(out[0].type === 'del');
  assert(out[1].type === 'add');
});

test('normalizeMergedPatchDiffLines removes duplicate consecutive context rows', () => {
  const rows = [
    { type: 'ctx', newLineNumber: 3, content: '    x = 1' },
    { type: 'ctx', newLineNumber: 3, content: '    x = 1' },
    { type: 'add', newLineNumber: 4, content: '    y = 2' }
  ];
  const out = normalizeMergedPatchDiffLines(rows);
  assert(out.length === 2);
  assert(out[0].type === 'ctx' && out[1].type === 'add');
});

test('parseDiff merges repeated diff --git blocks for the same path (multi-commit patches)', () => {
  const diff = [
    'diff --git a/pkg/a.py b/pkg/a.py',
    '--- a/pkg/a.py',
    '+++ b/pkg/a.py',
    '@@ -1,2 +1,3 @@',
    ' x',
    '+y',
    ' z',
    '',
    'diff --git a/other.py b/other.py',
    '--- a/other.py',
    '+++ b/other.py',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
    'diff --git a/pkg/a.py b/pkg/a.py',
    '--- a/pkg/a.py',
    '+++ b/pkg/a.py',
    '@@ -10,1 +10,2 @@',
    ' tail',
    '+more',
    ''
  ].join('\n');
  const { files } = parseDiff(diff);
  const a = files.find((f) => f.path === 'pkg/a.py');
  assert(a, 'single merged entry for pkg/a.py');
  assert(a.hunks.length === 2, 'hunks from both sections are concatenated');
  assert(files.filter((f) => f.path === 'pkg/a.py').length === 1);
});

test('extractChangedFunctions finds func1, func2, func3, func4, func5', () => {
  const diff = readFileSync(join(__dirname, 'fixtures/sample.diff'), 'utf8');
  const parsed = parseDiff(diff);
  const { functionsById } = extractChangedFunctions(parsed);
  const names = new Set(Object.values(functionsById).map((f) => f.name));
  assert(names.has('func1'));
  assert(names.has('func2'));
  assert(names.has('func3'));
  assert(names.has('func4'));
  assert(names.has('func5'));
});

test('extractChangedFunctions marks existing def with only +lines as modified', () => {
  const diff = [
    'diff --git a/src/example.py b/src/example.py',
    'index 123..456 100644',
    '--- a/src/example.py',
    '+++ b/src/example.py',
    '@@ -1,5 +1,6 @@',
    ' def convert_command():',
    '+    print("changed")',
    '     return 1',
    ''
  ].join('\n');
  const parsed = parseDiff(diff);
  const { functionsById } = extractChangedFunctions(parsed);
  const fn = Object.values(functionsById).find((f) => f.name === 'convert_command');
  assert(fn, 'changed function found');
  assert(fn.changeType === 'modified', 'context def line + body additions is modified');
});

test('extractChangedFunctions finds def when signature opens on the next line', () => {
  const path = 'pkg/sandbox.py';
  const content = [
    'def get_current_sandbox(',
    '):',
    '    """Return the E2B sandbox for the current session, or None if not active."""',
    '    return _current_sandbox.get()',
    ''
  ].join('\n');
  const diff = [
    'diff --git a/pkg/sandbox.py b/pkg/sandbox.py',
    '--- a/pkg/sandbox.py',
    '+++ b/pkg/sandbox.py',
    '@@ -3,2 +3,2 @@',
    '     """Return the E2B sandbox for the current session, or None if not active."""',
    '-    return None',
    '+    return _current_sandbox.get()',
    ''
  ].join('\n');
  const parsed = parseDiff(diff);
  const { functionsById } = extractChangedFunctions(parsed, { [path]: content });
  const fn = functionsById[`${path}:get_current_sandbox`];
  assert(fn, 'function detected when ( is not on the def line');
  assert(fn.startLine === 1, 'startLine is the def line');
  assert(fn.endLine >= 4, 'body spans docstring and return');
});

test('extractChangedFunctions marks functions with deletions as modified', () => {
  const diff = [
    'diff --git a/src/example.py b/src/example.py',
    'index 123..456 100644',
    '--- a/src/example.py',
    '+++ b/src/example.py',
    '@@ -1,6 +1,6 @@',
    ' def convert_command():',
    '-    print("old")',
    '+    print("new")',
    '     return 1',
    ''
  ].join('\n');
  const parsed = parseDiff(diff);
  const { functionsById } = extractChangedFunctions(parsed);
  const fn = Object.values(functionsById).find((f) => f.name === 'convert_command');
  assert(fn, 'modified function found');
  assert(fn.changeType === 'modified', 'function with deletions marked modified');
});

test('extractChangedFunctions includes decorators in function span', () => {
  const path = 'pkg/decorators.py';
  const content = [
    '@retry(',
    '    times=3,',
    ')',
    '@logged',
    'def worker():',
    '    return 1',
    ''
  ].join('\n');
  const diff = [
    'diff --git a/pkg/decorators.py b/pkg/decorators.py',
    '--- a/pkg/decorators.py',
    '+++ b/pkg/decorators.py',
    '@@ -2,1 +2,1 @@',
    '-    times=2,',
    '+    times=3,',
    ''
  ].join('\n');
  const parsed = parseDiff(diff);
  const { functionsById } = extractChangedFunctions(parsed, { [path]: content });
  const fn = functionsById[`${path}:worker`];
  assert(fn, 'decorated function detected');
  assert(fn.startLine === 1, 'function startLine includes top decorator line');
  assert(fn.endLine >= 6, 'function span still includes body');
});

test('augmentCallersInFunctionsById roots flow at unchanged caller of changed callee', () => {
  const modPath = 'pkg/mod.py';
  const fullFile = ['def run():', '    helper()', '', 'def helper():', '    x = 2', ''].join('\n');
  const diff = [
    'diff --git a/pkg/mod.py b/pkg/mod.py',
    '--- a/pkg/mod.py',
    '+++ b/pkg/mod.py',
    '@@ -4,3 +4,3 @@',
    ' def helper():',
    '-    x = 1',
    '+    x = 2',
    ''
  ].join('\n');
  const parsed = parseDiff(diff);
  const contents = { [modPath]: fullFile };
  const { functionsById } = extractChangedFunctions(parsed, contents);
  const merged = augmentCallersInFunctionsById(functionsById, contents);
  const { flows, edges } = buildFlows(merged, parsed, contents);
  const runFlow = flows.find((f) => merged[f.rootId]?.name === 'run');
  assert(runFlow, 'unchanged run becomes flow root');
  assert(!flows.some((f) => merged[f.rootId]?.name === 'helper'), 'changed helper is not a separate root');
  assert(merged[`${modPath}:run`]?.changed === false);
  assert(
    edges.some((e) => e.callerId === `${modPath}:run` && e.calleeId === `${modPath}:helper`),
    'edge from run to helper'
  );
});

test('buildFlows keeps production roots when only tests call them', () => {
  const diff = [
    'diff --git a/pkg/mod.py b/pkg/mod.py',
    '--- a/pkg/mod.py',
    '+++ b/pkg/mod.py',
    '@@ -1,3 +1,4 @@',
    ' def run():',
    '+    x = 1',
    '     helper()',
    '',
    'diff --git a/tests/test_mod.py b/tests/test_mod.py',
    '--- a/tests/test_mod.py',
    '+++ b/tests/test_mod.py',
    '@@ -1,3 +1,4 @@',
    ' def test_it():',
    '+    run()',
    '     assert True',
    ''
  ].join('\n');
  const parsed = parseDiff(diff);
  const { functionsById, files } = extractChangedFunctions(parsed);
  const { flows } = buildFlows(functionsById, parsed);
  const runFlow = flows.find((f) => functionsById[f.rootId]?.name === 'run');
  assert(runFlow, 'run stays a flow root despite test calling it');
});

test('buildFlows produces flows with correct sibling order (func2 before func5, func3 before func4)', () => {
  const diff = readFileSync(join(__dirname, 'fixtures/sample.diff'), 'utf8');
  const parsed = parseDiff(diff);
  const { functionsById, files } = extractChangedFunctions(parsed);
  const { flows, edges } = buildFlows(functionsById, parsed);

  assert(flows.length >= 1, 'at least one flow');
  const rootFlow = flows.find((f) => {
    const root = functionsById[f.rootId];
    return root?.name === 'func1';
  });
  assert(rootFlow, 'flow rooted at func1');

  const func1Edges = edges.filter((e) => e.callerId === rootFlow.rootId).sort((a, b) => a.callIndex - b.callIndex);
  const calleeNames = func1Edges.map((e) => functionsById[e.calleeId]?.name).filter(Boolean);
  const func2Idx = calleeNames.indexOf('func2');
  const func5Idx = calleeNames.indexOf('func5');
  assert(func2Idx >= 0 && func5Idx >= 0, 'func2 and func5 called from func1');
  assert(func2Idx < func5Idx, 'func2 before func5 in call order');

  const func2Id = Object.entries(functionsById).find(([, f]) => f.name === 'func2')?.[0];
  const func2Edges = edges.filter((e) => e.callerId === func2Id).sort((a, b) => a.callIndex - b.callIndex);
  const func2Callees = func2Edges.map((e) => functionsById[e.calleeId]?.name).filter(Boolean);
  const f3Idx = func2Callees.indexOf('func3');
  const f4Idx = func2Callees.indexOf('func4');
  assert(f3Idx >= 0 && f4Idx >= 0, 'func3 and func4 called from func2');
  assert(f3Idx < f4Idx, 'func3 before func4 in call order');
});

test('buildFlows suppresses descendant roots already reachable from another root', () => {
  const prodPath = 'pkg/mod.py';
  const testPath = 'tests/test_mod.py';

  const fullProd = [
    'def B():',
    '    return 20',
    '',
    'def A():',
    '    T()',
    '    return 10',
    ''
  ].join('\n');

  const fullTest = [
    'def T():',
    '    B()',
    '    return 3',
    ''
  ].join('\n');

  const diff = [
    'diff --git a/pkg/mod.py b/pkg/mod.py',
    '--- a/pkg/mod.py',
    '+++ b/pkg/mod.py',
    '@@ -2,1 +2,1 @@',
    '-    return 2',
    '+    return 20',
    '@@ -6,1 +6,1 @@',
    '-    return 1',
    '+    return 10',
    '',
    'diff --git a/tests/test_mod.py b/tests/test_mod.py',
    '--- a/tests/test_mod.py',
    '+++ b/tests/test_mod.py',
    '@@ -3,1 +3,1 @@',
    '-    return None',
    '+    return 3',
    ''
  ].join('\n');

  const parsed = parseDiff(diff);
  const contents = { [prodPath]: fullProd, [testPath]: fullTest };
  const { functionsById } = extractChangedFunctions(parsed, contents);
  const merged = augmentCallersInFunctionsById(functionsById, contents);
  const { flows, edges } = buildFlows(merged, parsed, contents);

  const flowNames = flows
    .map((f) => merged[f.rootId]?.name)
    .filter(Boolean);

  assert(flowNames.includes('A'), 'A is a flow root');
  assert(!flowNames.includes('B'), 'B is suppressed since it is reachable from A');

  const aId = Object.entries(merged).find(([, f]) => f.name === 'A')?.[0];
  const tId = Object.entries(merged).find(([, f]) => f.name === 'T')?.[0];
  const bId = Object.entries(merged).find(([, f]) => f.name === 'B')?.[0];
  assert(
    edges.some((e) => e.callerId === aId && e.calleeId === tId),
    'edge A -> T'
  );
  assert(
    edges.some((e) => e.callerId === tId && e.calleeId === bId),
    'edge T -> B'
  );
});

test('buildFlows omits test roots from the flow list', () => {
  const diff = [
    'diff --git a/tests/test_example.py b/tests/test_example.py',
    '--- a/tests/test_example.py',
    '+++ b/tests/test_example.py',
    '@@ -1,3 +1,4 @@',
    ' def test_foo():',
    '+    assert 1',
    '     pass',
    ''
  ].join('\n');
  const parsed = parseDiff(diff);
  const { functionsById } = extractChangedFunctions(parsed);
  const { flows } = buildFlows(functionsById, parsed);
  assert(flows.length === 0, 'test-only root is not a flow');
});

test('isTestFile classifies paths; extractChangedFunctions still parses test files', () => {
  assert(isTestFile('tests/test_foo.py'));
  assert(isTestFile('test_utils.py'));
  assert(isTestFile('src/foo_test.py'));
  assert(isTestFile('tests/unit/test_bar.py'));
  assert(!isTestFile('src/example.py'));
  assert(!isTestFile('utils.py'));

  const diff = [
    'diff --git a/tests/test_example.py b/tests/test_example.py',
    'new file',
    '@@ -0,0 +1,5 @@',
    '+def test_something():',
    '+    assert True',
    ''
  ].join('\n');
  const parsed = parseDiff(diff);
  const { functionsById } = extractChangedFunctions(parsed);
  assert(Object.keys(functionsById).length >= 1, 'test modules are parsed like other .py files');
});

test('flow name is root function name', () => {
  const diff = readFileSync(join(__dirname, 'fixtures/sample.diff'), 'utf8');
  const parsed = parseDiff(diff);
  const { functionsById } = extractChangedFunctions(parsed);
  const { flows } = buildFlows(functionsById, parsed);
  const func1Flow = flows.find((f) => functionsById[f.rootId]?.name === 'func1');
  assert(func1Flow, 'flow for func1 exists');
  assert(func1Flow.name === 'func1', 'flow name is root function name');
});

test('flow payload has required shape', () => {
  const diff = readFileSync(join(__dirname, 'fixtures/sample.diff'), 'utf8');
  const parsed = parseDiff(diff);
  const { functionsById, files } = extractChangedFunctions(parsed);
  const { flows, edges } = buildFlows(functionsById, parsed);

  const payload = { files, functionsById, flows, edges };
  assert(Array.isArray(payload.files));
  assert(typeof payload.functionsById === 'object');
  assert(Array.isArray(payload.flows));
  assert(Array.isArray(payload.edges));
  for (const f of Object.values(payload.functionsById)) {
    assert(f.id && f.name && f.file && typeof f.startLine === 'number');
  }
  for (const flow of payload.flows) {
    assert(flow.id && flow.rootId);
  }
  for (const e of payload.edges) {
    assert(e.callerId && e.calleeId && typeof e.callIndex === 'number');
  }
});

console.log('\nAll tests passed.');
