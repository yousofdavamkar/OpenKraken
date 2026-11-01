export function isTrustedDocument(
  frame: { url: string; parent: unknown } | null,
  expectedUrl: string,
  isMainFrame: boolean,
): boolean {
  return !!frame && isMainFrame && frame.parent === null && frame.url === expectedUrl;
}
export const windowPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  webviewTag: false,
} as const;
