# 0061 — Main-owned atomic command preferences

## Decision

Command keymaps and frecency now live in `<userData>/settings.json`, following the blueprint's main-owned settings boundary. The command catalogue, shortcut parser, and bounded data schemas are shared through the IPC contract. Renderer requests expose only reads, a revision-checked keymap save, one-time legacy import, and a known command ID invocation. They cannot supply file paths or invoke these methods in the Git utility process.

Main serializes preference updates, writes a private temporary file, syncs it, and renames it over settings. In-memory state changes only after the rename succeeds. Keymap revisions change only for keymap saves; usage updates do not make an open editor stale. The editor validates locally for useful errors, and main repeats validation before saving. Reopening the editor fetches the current main revision. Application shutdown waits for queued settings writes within the existing bounded shutdown window.

Legacy renderer preferences migrate only when no main settings file exists. Legacy keys are removed only after the native save succeeds; an existing native settings file wins over any leftover legacy values. Invalid legacy keymap text remains available for repair but never becomes an effective shortcut. Usage accepts only known IDs, bounded finite weights, and plausible timestamps. Queries, repository information, and credentials are not persisted.

The file reader and writer share a 256 KiB limit. The keymap's 32,768-code-unit bound can expand to 196,608 bytes when JSON escapes control characters or lone surrogates, so the file limit includes room for that worst case and settings metadata. The writer checks serialized UTF-8 bytes before creating a temporary file. This keeps accepted legacy data readable after restart, including invalid text that needs repair.

Unreadable or malformed settings use defaults without automatic overwrite. Ordinary usage recording does not rewrite a damaged file. Explicit Apply can repair malformed settings after preserving the original bytes in a private uniquely named backup. An unreadable file or externally changed source refuses writes. A failed save leaves the active keymap unchanged and the editor draft intact. Unknown settings versions or fields are treated as damaged, preserving them for recovery rather than silently discarding them.

## Scope

This supersedes ADR 0060's interim renderer-local persistence. It does not migrate unrelated older graph preferences or avatar settings, and does not itself implement native menu accelerators. The shared command definitions are the next accelerator integration boundary. Native shortcuts must still pass renderer context checks and reuse existing action handlers.

## Verification

Real Electron tests cover persistence after clearing renderer storage, full restart, frecency persistence, one-time legacy migration, invalid and stale main IPC writes, reopening at the current revision, preservation and explicit backup repair of damaged settings, and failed-write retention of existing shortcuts. Existing palette, keyboard, modal, composition, and Git ref cancellation tests continue to run. Contract tests reject unknown commands, oversized keymaps, negative revisions, extra fields, and every settings route at the Git-service boundary.

A restart regression also migrates a maximum-length control-character keymap, preserves it for repair, restores defaults through the editor and verifies a subsequent clean restart.
