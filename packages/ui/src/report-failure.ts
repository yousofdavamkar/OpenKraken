// Never accept an Error, message, stack, rejection value or source location.
// Reporting failures are swallowed here to avoid recursive rejection events.
export function reportRendererFailure(reason: 'unhandled-exception' | 'unhandled-rejection') {
  try {
    void window.openkraken
      .request({ id: crypto.randomUUID(), method: 'rendererFailure', reason })
      .catch(() => {});
  } catch {
    /* A missing/destroyed bridge must not cause another error event. */
  }
}
window.addEventListener('error', () => reportRendererFailure('unhandled-exception'));
window.addEventListener('unhandledrejection', () => reportRendererFailure('unhandled-rejection'));
