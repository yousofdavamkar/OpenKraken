import { copyFile, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { sha256 } from './package-security.mjs';

// Timestamped signatures give each build its own bytes. Move the complete
// image into place before atomically switching the receipt to its digest.
export async function saveSignedInstaller(output, artifact, manifest) {
  const temporary = await mkdtemp(join(output, '.installer-save-'));
  try {
    const staged = join(temporary, 'installer.part');
    await copyFile(artifact, staged);
    if (
      (await stat(staged)).size !== manifest.artifact.size ||
      (await sha256(staged)) !== manifest.artifact.sha256
    )
      throw new Error('Staged installer differs from its build receipt');
    const ext = extname(artifact);
    const file = basename(artifact, ext) + '-' + manifest.artifact.sha256 + ext;
    const receipt = { ...manifest, artifact: { ...manifest.artifact, file } };
    const receiptPath = join(temporary, 'manifest.json');
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    await rename(staged, join(output, file));
    await rename(receiptPath, join(output, 'manifest.json'));
    return file;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
