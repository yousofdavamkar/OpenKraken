/** Offer a native way out of an unconfirmed launch even if its renderer is stuck. */
export function watchAppImageStartup(
  pending: () => Promise<boolean>,
  askToClose: (signal: AbortSignal) => Promise<boolean>,
  close: () => void,
) {
  const controller = new AbortController();
  const { signal } = controller;
  const check = async () => {
    try {
      if (!(await pending()) || signal.aborted) return;
      const shouldClose = await askToClose(signal);
      if (signal.aborted) return;
      if (shouldClose) {
        if ((await pending()) && !signal.aborted) close();
      } else timer = setTimeout(check, 60000);
    } catch {
      // An unavailable journal or native dialog leaves the running application in place.
    }
  };
  let timer = setTimeout(check, 60000);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}
