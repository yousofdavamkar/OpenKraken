# 0062 — Native command menu and accelerators

## Decision

Main builds a native Commands menu from the shared catalogue, grouped by domain. Validated saved bindings become Electron menu accelerators; null removes the accelerator. Standard native editing and window roles remain available. Shortcuts reserved for those roles cannot be reassigned. Native key interpretation follows the operating system's keyboard layout; legacy KeyK/Digit1 spellings remain aliases for the corresponding accelerator key. This supersedes ADR 0060's physical-key interpretation.

The renderer publishes only a bounded list of available known command IDs and its current keymap revision over sender-validated IPC. Main enables matching menu items only at that revision. Open dialogs publish no available commands. Navigation, renderer loss, and window closure clear the menu context. A successful settings save rebuilds native accelerators, with commands disabled until the renderer publishes the matching revision.

Menu activation emits a typed command event with its source and keymap revision. The renderer rechecks the revision, mounted control, disabled state, and open dialogs before executing its existing control. Accelerator events additionally respect text-editing context; an explicit menu click can select an action while a text field is focused. This context is a presentation/interaction guard, not a substitute for Git/provider operation validation. Native command events arriving from the Git utility process are discarded.

Global command shortcuts have one owner: the native menu. The previous renderer keydown listener is removed. Main suppresses menu accelerators during repeated/composing input and observed AltGraph use; blur resets AltGraph tracking. Palette input keeps its own navigation and composition guards.

## Verification approach

A diagnostic established that Playwright's page keyboard API uses CDP input which does not reach Electron's `before-input-event` or native menu accelerators. The shortcut test helper instead uses `webContents.sendInputEvent` on the focused window. Palette text/arrow/Enter interactions continue to use page input. This exercises the production native path without adding a second shortcut implementation for tests.

Real Electron coverage inspects native menu labels, accelerators and availability; activates menu actions into existing dialogs; changes/unbinds shortcuts; checks modal/text-editing restrictions, repeat suppression, single invocation, and renderer reload recovery. Existing command persistence and restart tests use native accelerator input too. Native execution is verified on Linux; macOS/Windows and international keyboard layouts still need platform acceptance.

## Public API references

- [Electron MenuItem](https://www.electronjs.org/docs/latest/api/menu-item)
- [Electron keyboard shortcuts](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts)
- [Electron webContents input and menu shortcut controls](https://www.electronjs.org/docs/latest/api/web-contents)
- [Electron accelerator source metadata](https://www.electronjs.org/docs/latest/api/structures/keyboard-event)
