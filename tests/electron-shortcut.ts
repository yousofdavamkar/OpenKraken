import type { KeyboardInputEvent } from 'electron';
import type { ElectronApplication } from '@playwright/test';

/** CDP page keyboard input bypasses Electron menu accelerators. Use the native window input path. */
export async function pressShortcut(app: ElectronApplication, shortcut: string, repeat = false) {
  const parts = shortcut.split('+');
  const keyCode = parts.pop()!;
  const modifiers: NonNullable<KeyboardInputEvent['modifiers']> = parts.map((part) => {
    switch (part) {
      case 'Control':
        return 'control';
      case 'Shift':
        return 'shift';
      case 'Alt':
        return 'alt';
      case 'Meta':
        return 'meta';
      default:
        throw new Error(`Unsupported test modifier: ${part}`);
    }
  });
  if (repeat) modifiers.push('isautorepeat');
  await app.evaluate(
    ({ BrowserWindow }, input) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.focus();
      window.webContents.sendInputEvent({ type: 'keyDown', ...input });
      window.webContents.sendInputEvent({ type: 'keyUp', ...input });
    },
    { keyCode, modifiers },
  );
}
