/**
 * Display labels for extracted Python functions and class methods.
 * @param {import('../flowSchema.js').FunctionMeta | null | undefined} fn
 * @returns {string}
 */
export function getFunctionDisplayName(fn) {
  if (!fn) return '';
  if (fn.kind === 'method' && fn.className) {
    return `${fn.className}.${fn.name}`;
  }
  return fn.name;
}
