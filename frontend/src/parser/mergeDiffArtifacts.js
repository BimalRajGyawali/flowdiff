/**
 * When multiple `diff --git` sections are merged for one file, hunks reset their
 * @@ new-file counters. The same logical line can appear as context (` `) in an
 * earlier hunk and as `+` in a later one — then the UI shows both a plain line
 * and a `+` duplicate. Drop the redundant context row only when that `ctx` and
 * the `+` share the same new-file line **and** the same text (true duplicate).
 *
 * Dropping every `ctx` whenever any `+` reused that line number (without comparing
 * text) removed legitimate context when line numbers were off by one: e.g. a real
 * `params["stop"] = stop` line disappeared because a different `+` claimed the same N.
 *
 * Another merge artifact: a context line whose text already matches the following
 * single `+` in a one-line replace (e.g. import + trailing comment) — drop that
 * `ctx` so only `-` / `+` remain.
 */

function trimDiffLine(s) {
  return (s ?? '').replace(/\s+$/, '');
}

/**
 * @param {{ type: string, newLineNumber: number | null, content: string }[]} rows
 * @returns {typeof rows}
 */
export function normalizeMergedPatchDiffLines(rows) {
  /** @type {Map<number, { type: string, newLineNumber: number | null, content: string }>} */
  const addByNewLine = new Map();
  for (const r of rows) {
    if (r.type === 'add' && r.newLineNumber != null) addByNewLine.set(r.newLineNumber, r);
  }

  let step = rows.filter((r) => {
    if (r.type !== 'ctx' || r.newLineNumber == null) return true;
    const add = addByNewLine.get(r.newLineNumber);
    if (!add) return true;
    return trimDiffLine(r.content) !== trimDiffLine(add.content);
  });

  step = stripRedundantCtxBeforeSingleReplace(step);

  const out = [];
  for (const r of step) {
    const prev = out[out.length - 1];
    if (
      r.type === 'ctx' &&
      prev?.type === 'ctx' &&
      r.newLineNumber === prev.newLineNumber &&
      r.content === prev.content
    ) {
      continue;
    }
    out.push(r);
  }
  return out;
}

/**
 * @param {{ type: string, newLineNumber: number | null, content: string }[]} rows
 */
function stripRedundantCtxBeforeSingleReplace(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    const del = rows[i + 1];
    const add = rows[i + 2];
    const afterPair = rows[i + 3];
    if (
      r.type === 'ctx' &&
      del?.type === 'del' &&
      add?.type === 'add' &&
      r.content === add.content &&
      del.content !== add.content &&
      afterPair?.type !== 'del' &&
      afterPair?.type !== 'add'
    ) {
      i += 1;
      continue;
    }
    out.push(r);
    i += 1;
  }
  return out;
}
