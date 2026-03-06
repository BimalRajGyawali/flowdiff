/**
 * Returns true if the file path indicates a test file.
 * Excludes: test_*.py, *_test.py, paths containing /tests/ or /test/
 */
export function isTestFile(path) {
  if (!path.endsWith('.py')) return false;
  const base = path.replace(/^.*\//, '');
  if (base.startsWith('test_') || base.endsWith('_test.py')) return true;
  if (/\/tests?\//.test(path) || path.startsWith('tests/') || path.startsWith('test/')) return true;
  return false;
}
