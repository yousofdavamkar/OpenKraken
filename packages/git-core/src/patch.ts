import { GitError } from './runner.js';
export interface PatchLine {
  id: number;
  kind: 'context' | 'add' | 'del';
  text: string;
  oldNo?: number;
  newNo?: number;
  noNewline?: boolean;
}
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: PatchLine[];
}
export interface FilePatch {
  path: string;
  oldExists: boolean;
  newExists: boolean;
  oldMode: string;
  newMode: string;
  binary: boolean;
  hunks: PatchHunk[];
}
export function parsePatch(raw: string, path: string): FilePatch {
  const result: FilePatch = {
    path,
    oldExists: !/^--- \/dev\/null$/m.test(raw),
    newExists: !/^\+\+\+ \/dev\/null$/m.test(raw),
    oldMode: '100644',
    newMode: '100644',
    binary: /^(Binary files |GIT binary patch)/m.test(raw),
    hunks: [],
  };
  const mode = /^index [^\n]+ ([0-9]{6})$/m.exec(raw)?.[1];
  if (mode) result.oldMode = result.newMode = mode;
  result.oldMode = /^(?:old|deleted file) mode ([0-9]{6})$/m.exec(raw)?.[1] ?? result.oldMode;
  result.newMode = /^(?:new|new file) mode ([0-9]{6})$/m.exec(raw)?.[1] ?? result.newMode;
  let hunk: PatchHunk | undefined,
    oldNo = 0,
    newNo = 0,
    id = 0;
  for (const line of raw.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (match) {
      hunk = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        header: match[5]!,
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      result.hunks.push(hunk);
    } else if (hunk && line.startsWith('\\ No newline')) {
      const previous = hunk.lines.at(-1);
      if (previous) previous.noNewline = true;
    } else if (hunk && [' ', '+', '-'].includes(line[0] ?? '')) {
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'context';
      hunk.lines.push({
        id: id++,
        kind,
        text: line.slice(1),
        ...(kind !== 'add' ? { oldNo: oldNo++ } : {}),
        ...(kind !== 'del' ? { newNo: newNo++ } : {}),
      });
    }
  }
  return result;
}
/** Git's quoted paths use byte-oriented C/octal escaping, not JSON's Unicode escaping. */
function quote(path: string) {
  return (
    '"' +
    [...Buffer.from(path)]
      .map((b) =>
        b >= 32 && b < 127 && b !== 34 && b !== 92
          ? String.fromCharCode(b)
          : `\\${b.toString(8).padStart(3, '0')}`,
      )
      .join('') +
    '"'
  );
}
export function selectPatch(file: FilePatch, selectedIds: number[], reverse = false) {
  if (
    file.binary ||
    !file.hunks.length ||
    !/^100(?:644|755)$/.test(reverse ? file.newMode : file.oldMode)
  )
    throw new GitError(
      'PARTIAL_UNSUPPORTED',
      'Use whole-file staging for binary files, links and mode-only changes',
    );
  const selected = new Set(selectedIds),
    changes = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context');
  const available = new Set(changes.map((line) => line.id));
  if (
    !selected.size ||
    selected.size !== selectedIds.length ||
    [...selected].some((id) => !available.has(id))
  )
    throw new GitError('INVALID_SELECTION', 'Select changed lines from the current diff');
  const baseExists = reverse ? file.newExists : file.oldExists,
    targetExists = reverse ? file.oldExists : file.newExists;
  const outputExists = targetExists || changes.some((line) => !selected.has(line.id));
  let patch = `diff --git ${quote(`a/${file.path}`)} ${quote(`b/${file.path}`)}\n`;
  if (!baseExists) patch += `new file mode ${reverse ? file.oldMode : file.newMode}\n`;
  if (!outputExists) patch += `deleted file mode ${reverse ? file.newMode : file.oldMode}\n`;
  patch += `--- ${baseExists ? quote(`a/${file.path}`) : '/dev/null'}\n+++ ${outputExists ? quote(`b/${file.path}`) : '/dev/null'}\n`;
  let delta = 0;
  for (const hunk of file.hunks) {
    const lines: string[] = [];
    let oldCount = 0,
      newCount = 0,
      changed = false;
    for (const original of hunk.lines) {
      const kind =
        reverse && original.kind !== 'context'
          ? original.kind === 'add'
            ? 'del'
            : 'add'
          : original.kind;
      if (kind === 'add' && !selected.has(original.id)) continue;
      const prefix =
        kind === 'context' || (kind === 'del' && !selected.has(original.id))
          ? ' '
          : kind === 'add'
            ? '+'
            : '-';
      if (prefix !== '+') oldCount++;
      if (prefix !== '-') newCount++;
      if (prefix !== ' ') changed = true;
      lines.push(prefix + original.text);
      if (original.noNewline) lines.push('\\ No newline at end of file');
    }
    if (!changed) continue;
    const oldStart = reverse ? hunk.newStart : hunk.oldStart;
    const newStart = oldStart + delta + (oldCount === 0 ? 1 : 0) - (newCount === 0 ? 1 : 0);
    patch += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join('\n')}\n`;
    delta += newCount - oldCount;
  }
  return patch;
}
