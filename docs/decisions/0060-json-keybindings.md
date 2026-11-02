# 0060 — Validated renderer keymaps

## Decision

The command catalogue accepts a versioned JSON preferences document, `{ "version": 1, "bindings": { "command.id": "Mod+K" } }`. Missing commands inherit defaults; explicit null unbinds. This is OpenKraken's own schema, not an Atom selector grammar. It exposes only known command IDs and never evaluates code, shell commands, or selectors.

A shortcut consists of unique modifiers (Mod/Ctrl/Alt/Shift/Meta) and one physical key (letter, digit, function key, or named punctuation). Mod maps to Command on macOS and Control elsewhere. Validation rejects unknown commands, malformed or oversized documents, unmodified typing keys, and reserved editing/window/developer shortcuts. It checks the complete effective map, including defaults, for collisions on both macOS and Windows/Linux. Mod cannot be mixed with Ctrl/Meta. The same physical key spelled as K or KeyK conflicts.

Validation and persistence complete before the active mapping changes. Storage failure leaves the previous map active. Invalid saved data falls back to defaults and remains visible in the editor for repair; merely invoking a command does not overwrite it. Restore defaults edits the draft and requires Apply. Preferences are local to the profile.

Renderer dispatch ignores handled/repeated/composing/AltGraph events, open dialogs, and (except opening the palette) text-editing targets. Dispatch reuses the same context-aware registry as the palette. The editor lists all IDs and effective bindings, and palette rows/button tooltips show assigned shortcuts.

## Scope and follow-up

This implements renderer keybindings only. Native menu accelerators and bringing the existing history-search shortcut into the catalogue remain follow-up work. Terminal/editor contexts retain their own shortcuts. Cross-platform validation is implemented, but desktop execution is currently verified on Linux only.

## Evidence

Real Electron tests exercise conflicts with inherited defaults, unknown IDs, unsafe bare typing keys, valid remapping and null overrides, atomic Apply, modal suppression, restart persistence, restoring defaults, damaged-data recovery, and ignoring action shortcuts inside commit search. A repository fixture test checks that selecting Create branch opens the existing dialog without altering refs, and cancel preserves the refs.
