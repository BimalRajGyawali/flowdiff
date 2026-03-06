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
import { isTestFile } from '../frontend/src/parser/isTestFile.js';
import { parsePrUrl } from '../frontend/src/github/parsePrUrl.js';

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

test('extractChangedFunctions marks added-only functions as added', () => {
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
  assert(fn.changeType === 'added', 'added-only function marked added');
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

test('test files are excluded from flows', () => {
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
  assert(Object.keys(functionsById).length === 0, 'test file functions excluded');
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
