import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { comparePayload, payloadManifest } from './package-security.mjs';
import { validateWindowsPayloadAccess } from './windows-payload.mjs';

const user = 'S-1-5-21-100-200-300-1001';
const run = promisify(execFile);
const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function windowsFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-windows-payload-'));
  directories.push(directory);
  // Restrict only this test-owned directory. Child files inherit the fixture
  // user's permissions, independent of a runner's temporary-directory defaults.
  await powershell(
    directory,
    `
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $env:OPENKRAKEN_ACL_FIXTURE -AclObject $acl
  `,
  );
  return directory;
}

async function powershell(directory, script) {
  await run(
    join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, 'utf16le').toString('base64'),
    ],
    { env: { ...process.env, OPENKRAKEN_ACL_FIXTURE: directory }, windowsHide: true },
  );
}
function report(rules = []) {
  return {
    currentUserSid: user,
    entries: [{ path: '', type: 'directory', owner: user, daclPresent: true, rules }],
  };
}

test('Windows payload policy rejects write access granted to Everyone', () => {
  expect(() =>
    validateWindowsPayloadAccess(
      report([{ sid: 'S-1-1-0', type: 'allow', rights: 2, inheritOnly: false }]),
    ),
  ).toThrow('Unsafe Windows payload access');
});

test.each([
  null,
  {},
  { currentUserSid: user, entries: [] },
  {
    currentUserSid: user,
    entries: [
      {
        path: '',
        type: 'directory',
        owner: user,
        daclPresent: true,
        rules: [{ sid: user, type: 'allow' }],
      },
    ],
  },
])('Windows payload policy fails closed on an incomplete access report: %j', (invalid) => {
  expect(() => validateWindowsPayloadAccess(invalid)).toThrow(
    'Invalid Windows payload access report',
  );
});

test.each([2, 4, 16, 64, 256, 65536, 262144, 524288, 0x10000000, 0x40000000])(
  'Windows payload policy rejects non-owner mutation rights %i',
  (rights) => {
    expect(() =>
      validateWindowsPayloadAccess(
        report([{ sid: 'S-1-5-32-545', type: 'allow', rights, inheritOnly: false }]),
      ),
    ).toThrow('Unsafe Windows payload access');
  },
);

test('Windows payload policy permits shared reading and trusted owner/system/administrator writes', () => {
  const access = report([
    { sid: 'S-1-1-0', type: 'allow', rights: 0x1200a9, inheritOnly: false },
    ...[user, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4'].map((sid) => ({
      sid,
      type: 'allow',
      rights: 0x1f01ff,
      inheritOnly: false,
    })),
  ]);
  expect(validateWindowsPayloadAccess(access)).toEqual(new Map([['', 'directory']]));
});

test('Windows payload policy rejects an untrusted owner even with no write rules', () => {
  const access = report();
  access.entries[0].owner = 'S-1-5-21-100-200-300-9999';
  expect(() => validateWindowsPayloadAccess(access)).toThrow('Unsafe Windows payload access');
});

test('Windows payload policy rejects a null DACL', () => {
  const access = report();
  access.entries[0].daclPresent = false;
  expect(() => validateWindowsPayloadAccess(access)).toThrow('Unsafe Windows payload access');
});

test.each([
  '../outside',
  'resources/../../outside',
  'C:/outside',
  'resources\\helper.exe',
  '/absolute',
  'missing-parent/helper.exe',
])('Windows payload policy rejects redirected or incomplete paths: %s', (path) => {
  const access = report();
  access.entries.push({ ...access.entries[0], path, type: 'file' });
  expect(() => validateWindowsPayloadAccess(access)).toThrow(
    'Invalid Windows payload access report',
  );
});

test('Windows payload policy rejects ambiguous case-insensitive entries', () => {
  const access = report();
  access.entries.push({ ...access.entries[0], path: 'Helper.exe', type: 'file' });
  access.entries.push({ ...access.entries[0], path: 'helper.exe', type: 'file' });
  expect(() => validateWindowsPayloadAccess(access)).toThrow(
    'Invalid Windows payload access report',
  );
});

test('Windows payload policy checks inherited child access even when the parent rule is inherit-only', () => {
  const access = report([{ sid: 'S-1-1-0', type: 'allow', rights: 2, inheritOnly: true }]);
  validateWindowsPayloadAccess(access);
  access.entries.push({
    ...access.entries[0],
    path: 'helper.exe',
    type: 'file',
    rules: [{ ...access.entries[0].rules[0], inheritOnly: false }],
  });
  expect(() => validateWindowsPayloadAccess(access)).toThrow(
    'Unsafe Windows payload access: helper.exe',
  );
});

test('Windows payload policy does not assume that deny rules cancel unsafe grants', () => {
  const access = report([
    { sid: 'S-1-1-0', type: 'deny', rights: 2, inheritOnly: false },
    { sid: 'S-1-5-32-545', type: 'allow', rights: 2, inheritOnly: false },
  ]);
  expect(() => validateWindowsPayloadAccess(access)).toThrow('Unsafe Windows payload access');
});

test.skipIf(process.platform !== 'win32')(
  'native Windows payload verification accepts owned files and the MSI read-only attribute',
  async () => {
    const directory = await windowsFixture();
    const file = join(directory, 'helper.exe');
    await writeFile(file, 'native helper fixture');
    const before = await payloadManifest(directory);
    expect(before['helper.exe'].type).toBe('file');
    expect(before['helper.exe'].mode).toBeUndefined();
    await chmod(file, 0o444);
    comparePayload(before, await payloadManifest(directory));
    await chmod(file, 0o666);
  },
);

test.skipIf(process.platform !== 'win32')(
  'native Windows payload verification rejects inherited Everyone write access',
  async () => {
    const directory = await windowsFixture();
    await writeFile(join(directory, 'helper.exe'), 'native helper fixture');
    await powershell(
      directory,
      `
    $acl = Get-Acl -LiteralPath $env:OPENKRAKEN_ACL_FIXTURE
    $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Write', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $env:OPENKRAKEN_ACL_FIXTURE -AclObject $acl
  `,
    );
    await expect(payloadManifest(directory)).rejects.toThrow('Unsafe Windows payload access');
  },
);

test.skipIf(process.platform !== 'win32')(
  'native Windows payload verification rejects a directory junction before traversal',
  async () => {
    const directory = await windowsFixture();
    const outside = await windowsFixture();
    await mkdir(join(outside, 'private'));
    await symlink(outside, join(directory, 'redirect'), 'junction');
    await expect(payloadManifest(directory)).rejects.toThrow(
      'Windows payload contains a reparse point',
    );
  },
);
