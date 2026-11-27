import { app, dialog } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CrashReports } from './crash-reports.js';
import type { Diagnostics } from './diagnostics.js';
import type { UpdateConfiguration } from './update-protocol.js';

declare const __OPENKRAKEN_SENTRY_DSN__: string | null;
declare const __OPENKRAKEN_UPDATE_CONFIG__: UpdateConfiguration | null;

if (
  __OPENKRAKEN_UPDATE_CONFIG__?.channel === 'beta' &&
  !app.commandLine.hasSwitch('user-data-dir')
) {
  const profile = join(app.getPath('appData'), 'OpenKraken Beta');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  const profile = app.getPath('userData');
  const runtime = { version: app.getVersion(), platform: process.platform, arch: process.arch };
  const crashReports = new CrashReports(profile, __OPENKRAKEN_SENTRY_DSN__, runtime);
  const reportingReady = crashReports.start();
  let diagnostics: Diagnostics | undefined;
  // Observe failures without replacing Node/Electron's exception handling or
  // inspecting the error object. Fatal exits are recovered through the marker.
  process.on('uncaughtExceptionMonitor', (_error, origin) => {
    const reason = origin === 'unhandledRejection' ? 'unhandled-rejection' : 'unhandled-exception';
    diagnostics?.failure('main', reason);
    void crashReports.capture('main', reason);
  });
  app.on('child-process-gone', (_event, details) => {
    const kind =
      details.name === 'OpenKraken Git'
        ? 'git'
        : details.name === 'OpenKraken Terminal'
          ? 'terminal'
          : details.type === 'GPU'
            ? 'gpu'
            : null;
    if (kind) {
      diagnostics?.failure(kind, details.reason);
      void crashReports.capture(kind, details.reason);
    }
  });
  const failStartup = (reason: 'unhandled-exception' | 'unhandled-rejection') => {
    diagnostics?.failure('main', reason);
    const delivery = crashReports.capture('main', reason);
    try {
      dialog.showErrorBox(
        'OpenKraken could not start',
        'The desktop could not be initialized. Reopen OpenKraken to try again.',
      );
    } finally {
      // A failed startup owns the single-instance lock but has no usable window.
      // Allow the five-second report attempt and marker cleanup, even after early failure.
      const deadline = setTimeout(() => app.exit(1), 6000);
      void delivery
        .catch(() => {})
        .then(() => {
          crashReports.close();
          return Promise.all([crashReports.idle(), diagnostics?.close()]);
        })
        .finally(() => {
          clearTimeout(deadline);
          app.exit(1);
        });
    }
  };
  // The desktop registers its macOS URL listener synchronously before ready.
  try {
    const { Diagnostics } = require('./diagnostics') as typeof import('./diagnostics.js');
    diagnostics = new Diagnostics(join(profile, 'diagnostics'), runtime);
    const { startDesktop } = require('./main') as typeof import('./main.js');
    void startDesktop(crashReports, reportingReady, diagnostics).catch(() =>
      failStartup('unhandled-rejection'),
    );
  } catch {
    failStartup('unhandled-exception');
  }
}
