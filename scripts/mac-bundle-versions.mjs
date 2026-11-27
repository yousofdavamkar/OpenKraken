import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseVersionSchema } from '../apps/desktop/src/update-protocol.ts';

export function macBundleVersions({ version, macBuildNumber }) {
  releaseVersionSchema.parse(version);
  const [appVersion, beta] = version.split('-');
  // Stable receipts created before build numbers used the release version in both fields.
  if (macBuildNumber === undefined && beta === undefined)
    return { appVersion, buildVersion: appVersion };
  if (!Number.isSafeInteger(macBuildNumber) || macBuildNumber < 1)
    throw new Error('Expected a positive macBuildNumber in the release metadata');
  return { appVersion, buildVersion: String(macBuildNumber) };
}

export function macPackagerOptions(release) {
  const versions = macBundleVersions(release);
  if (versions.appVersion === release.version) return versions;
  return {
    ...versions,
    // Packager also writes appVersion into its working copy of package.json.
    // Restore the release identity before ASAR creation and integrity hashing.
    beforeAsar: [
      async ({ buildPath }) => {
        const path = join(buildPath, 'package.json');
        const app = JSON.parse(await readFile(path, 'utf8'));
        app.version = release.version;
        await writeFile(path, JSON.stringify(app));
      },
    ],
  };
}
