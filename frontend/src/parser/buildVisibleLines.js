/**
 * Builds visible new-file lines from a diff hunk sequence.
 * Removed lines are skipped; added and context lines are kept with new-file numbers.
 * Deletion markers are attached to nearby visible lines so callers can classify
 * a function as modified when its diff region includes removed lines.
 *
 * @param {{ newStart: number, lines: string[] }[]} hunks
 * @returns {{ lineNumber: number, content: string, added: boolean, touchedByDeletion: boolean }[]}
 */
export function buildVisibleLines(hunks) {
  const visibleLines = [];

  for (const hunk of hunks) {
    let newLineNumber = hunk.newStart;
    let pendingDeletion = false;

    for (const rawLine of hunk.lines || []) {
      if (rawLine.startsWith('-')) {
        pendingDeletion = true;
        continue;
      }

      const added = rawLine.startsWith('+');
      const content = rawLine.startsWith('+') || rawLine.startsWith(' ')
        ? rawLine.slice(1)
        : rawLine;

      visibleLines.push({
        lineNumber: newLineNumber,
        content,
        added,
        touchedByDeletion: pendingDeletion
      });

      pendingDeletion = false;
      newLineNumber += 1;
    }

    if (pendingDeletion && visibleLines.length > 0) {
      visibleLines[visibleLines.length - 1].touchedByDeletion = true;
    }
  }

  return visibleLines;
}
