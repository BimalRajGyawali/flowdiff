/**
 * Returns true if the file path indicates a test file.
 * Excludes: test_*.py, *_test.py, paths containing /tests/ or /test/
 */
export function isTestFile(path) {
  if (!path || !path.endsWith('.py')) return false;
  const base = path.replace(/^.*\//, '');
  if (base.startsWith('test_') || base.endsWith('_test.py')) return true;
  if (/\/tests?\//.test(path) || path.startsWith('tests/') || path.startsWith('test/')) return true;
  return false;
}

/**
 * Returns true if the function is a test function: file under tests/ (or test/) or name starts with test_.
 * @param {{ file: string, name: string }} fn
 */
export function isTestFunction(fn) {
  if (!fn) return false;
  if (fn.name && fn.name.startsWith('test_')) return true;
  if (/\/tests?\//.test(fn.file) || fn.file.startsWith('tests/') || fn.file.startsWith('test/')) return true;
  return isTestFile(fn.file);
}
