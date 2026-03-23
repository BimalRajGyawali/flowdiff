/**
 * Adds unchanged functions that call changed functions in the same file so the
 * call graph can root at real entrypoints instead of orphaning changed callees.
 */

import { listAllPythonFunctionMetas } from './pythonDefScan.js';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {Record<string, import('../flowSchema.js').FunctionMeta>} functionsById
 * @param {Record<string, string>} fileContentsByPath
 * @returns {Record<string, import('../flowSchema.js').FunctionMeta>}
 */
export function augmentCallersInFunctionsById(functionsById, fileContentsByPath) {
  const merged = { ...functionsById };
  const paths = new Set(Object.values(functionsById).map((f) => f.file));

  for (const path of paths) {
    const text = fileContentsByPath[path];
    if (typeof text !== 'string') continue;

    const sourceLines = text.split('\n');
    const allDefs = listAllPythonFunctionMetas(sourceLines);
    const changedInFile = Object.values(functionsById).filter((f) => f.file === path && f.changed);

    for (const c of changedInFile) {
      const callRe = new RegExp(`\\b${escapeRe(c.name)}\\s*\\(`);
      for (const d of allDefs) {
        if (d.name === c.name && d.startLine === c.startLine) continue;

        const body = sourceLines.slice(d.startLine - 1, d.endLine).join('\n');
        if (!callRe.test(body)) continue;

        const id = `${path}:${d.name}`;
        if (merged[id]) continue;

        merged[id] = {
          id,
          name: d.name,
          file: path,
          startLine: d.startLine,
          endLine: d.endLine,
          snippet: d.snippet || `def ${d.name}(`,
          changed: false
        };
      }
    }
  }

  return merged;
}
