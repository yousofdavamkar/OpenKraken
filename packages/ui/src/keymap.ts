import { shortcutStroke } from '@openkraken/ipc-contract';
export { bindingFor, emptyKeymap, parseKeymap } from '@openkraken/ipc-contract';
export function matchesShortcut(event: KeyboardEvent, value: string) {
  const expected = shortcutStroke(value, /Mac|iPhone|iPad/.test(navigator.platform));
  return (
    event.code === expected.code &&
    event.ctrlKey === expected.ctrl &&
    event.metaKey === expected.meta &&
    event.altKey === expected.alt &&
    event.shiftKey === expected.shift
  );
}
