import { execFile } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function readWindowsPayloadAccess(directory) {
  if (process.platform !== 'win32') throw new Error('Windows access checks require native Windows');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot))
    throw new Error('Windows system directory is unavailable');
  const { stdout } = await run(
    join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('./read-windows-payload-access.ps1', import.meta.url)),
      '-Directory',
      resolve(directory),
    ],
    { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return validateWindowsPayloadAccess(JSON.parse(stdout.trim()));
}

// Windows file mode bits do not represent account access. Validate the DACL
// separately from the portable payload hashes; never treat chmod as an ACL.
export function validateWindowsPayloadAccess(report) {
  const invalid = () => {
    throw new Error('Invalid Windows payload access report');
  };
  const sid = (value) => typeof value === 'string' && /^S-\d+(?:-\d+)+$/.test(value);
  if (
    !report ||
    !sid(report.currentUserSid) ||
    !Array.isArray(report.entries) ||
    !report.entries.length
  )
    invalid();
  const paths = new Map();
  const foldedPaths = new Set();
  for (const entry of report.entries) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      /[\\:]/.test(entry.path) ||
      [...entry.path].some((character) => character.codePointAt(0) < 32) ||
      (entry.path !== '' &&
        entry.path.split('/').some((part) => !part || part === '.' || part === '..')) ||
      !['file', 'directory'].includes(entry.type) ||
      !sid(entry.owner) ||
      typeof entry.daclPresent !== 'boolean' ||
      !Array.isArray(entry.rules) ||
      foldedPaths.has(entry.path.toLowerCase())
    )
      invalid();
    for (const rule of entry.rules)
      if (
        !rule ||
        !sid(rule.sid) ||
        !['allow', 'deny'].includes(rule.type) ||
        typeof rule.inheritOnly !== 'boolean' ||
        !Number.isInteger(rule.rights) ||
        rule.rights < -2147483648 ||
        rule.rights > 0xffffffff
      )
        invalid();
    paths.set(entry.path, entry.type);
    foldedPaths.add(entry.path.toLowerCase());
  }
  if (paths.get('') !== 'directory') invalid();
  for (const path of paths.keys())
    if (path && paths.get(path.split('/').slice(0, -1).join('/')) !== 'directory') invalid();
  const trusted = new Set([report.currentUserSid, 'S-1-5-18', 'S-1-5-32-544']);
  for (const entry of report.entries) {
    if (!entry.daclPresent || !trusted.has(entry.owner))
      throw new Error(`Unsafe Windows payload access: ${entry.path || '.'}`);
    for (const rule of entry.rules) {
      // Write data/attributes, append, delete, change permissions/owner, and
      // generic write/all. Read/execute access may be shared with other users.
      const writes = 0x500d0156;
      if (
        rule.type === 'allow' &&
        !rule.inheritOnly &&
        (rule.rights & writes) !== 0 &&
        !trusted.has(rule.sid) &&
        rule.sid !== 'S-1-3-4'
      )
        throw new Error(`Unsafe Windows payload access: ${entry.path || '.'}`);
    }
  }
  return paths;
}
