/** Complete unified hunks only; row numbers refer to the displayed patch, not the file. */
export function providerPatchLines(text: string) {
  const anchors = new Map<
    number,
    { oldLine: number | null; newLine: number | null; text: string }
  >();
  let oldLine = 0,
    newLine = 0,
    oldRemaining = 0,
    newRemaining = 0;
  let seen = false,
    mayMark = false;
  const rows = text.split('\n');
  const invalid = () =>
    new Map<number, { oldLine: number | null; newLine: number | null; text: string }>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*$/.exec(row);
    if (header) {
      if (oldRemaining || newRemaining) return invalid();
      const [oldStart, oldCount, newStart, newCount] = [
        Number(header[1]),
        Number(header[2] ?? 1),
        Number(header[3]),
        Number(header[4] ?? 1),
      ] as const;
      if (
        ![
          oldStart,
          oldCount,
          newStart,
          newCount,
          oldStart + Math.max(oldCount, 1),
          newStart + Math.max(newCount, 1),
        ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        (oldCount > 0 && oldStart === 0) ||
        (newCount > 0 && newStart === 0) ||
        (seen &&
          (oldStart + (oldCount === 0 ? 1 : 0) < oldLine ||
            newStart + (newCount === 0 ? 1 : 0) < newLine))
      )
        return invalid();
      oldLine = oldStart + (oldCount === 0 ? 1 : 0);
      newLine = newStart + (newCount === 0 ? 1 : 0);
      oldRemaining = oldCount;
      newRemaining = newCount;
      seen = true;
      mayMark = false;
      continue;
    }
    if (row === '' && index === rows.length - 1) continue;
    if (/^\\ No newline at end of file\r?$/.test(row) && mayMark) {
      mayMark = false;
      continue;
    }
    if (!seen) return invalid();
    if (row.startsWith('-') && oldRemaining > 0) {
      anchors.set(index + 1, { oldLine: oldLine++, newLine: null, text: row });
      oldRemaining--;
    } else if (row.startsWith('+') && newRemaining > 0) {
      anchors.set(index + 1, { oldLine: null, newLine: newLine++, text: row });
      newRemaining--;
    } else if (row.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      anchors.set(index + 1, { oldLine: oldLine++, newLine: newLine++, text: row });
      oldRemaining--;
      newRemaining--;
    } else return invalid();
    mayMark = true;
  }
  return oldRemaining || newRemaining ? invalid() : anchors;
}
