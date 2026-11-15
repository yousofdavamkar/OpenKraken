import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrashReports } from './src/crash-reports.js';
import { reportDestination } from './src/report-destination.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('interrupted main sessions are attempted once after restart with the original release', async () => {
  const directory = await fixture();
  const first = new CrashReports(directory, dsn, runtime);
  await first.start();
  await first.save(true, (await first.read()).revision);
  const received: Record<string, unknown>[] = [];
  const next = new CrashReports(
    directory,
    dsn,
    { ...runtime, version: '0.2.0' },
    async (_url, init) => {
      received.push(JSON.parse(String(init?.body).trim().split('\n')[2]!));
      return new Response(null);
    },
  );
  await next.start();
  await expect.poll(() => received.length).toBe(1);
  expect(received[0]).toMatchObject({
    level: 'warning',
    release: 'openkraken@0.1.0',
    tags: { process: 'main', reason: 'unclean-exit' },
  });
  await next.start();
  expect(received).toHaveLength(1);
  next.close();
  await next.idle();
  await expect(stat(join(directory, 'reporting-session.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const clean = new CrashReports(directory, dsn, runtime, async () => {
    throw new Error('Unexpected upload after clean exit');
  });
  await clean.start();
  expect((await clean.read()).delivery).toBe('idle');
  clean.close();
  await clean.idle();
});

test('renewing consent cancels the old in-flight generation without leaving a sending status', async () => {
  let signal: AbortSignal | null | undefined;
  const reports = new CrashReports(await fixture(), dsn, runtime, async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  });
  await reports.save(true, (await reports.read()).revision);
  const sending = reports.capture('renderer', 'crashed');
  await expect.poll(() => signal).toBeDefined();
  await reports.save(true, (await reports.read()).revision);
  await sending;
  expect(signal?.aborted).toBe(true);
  expect(await reports.read()).toMatchObject({ enabled: true, delivery: 'idle' });
});

test('old consent is reset and opting out removes the local session marker', async () => {
  const directory = await fixture();
  const reports = new CrashReports(directory, dsn, runtime);
  await reports.save(true, (await reports.read()).revision);
  const file = join(directory, 'crash-reporting.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  delete saved.nonce;
  saved.version = 1;
  await writeFile(file, JSON.stringify(saved));
  const upgraded = new CrashReports(directory, dsn, runtime);
  expect(await upgraded.read()).toMatchObject({ enabled: false, warning: null });
  await upgraded.start();
  await expect(stat(join(directory, 'reporting-session.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await upgraded.save(true, (await upgraded.read()).revision);
  const firstConsent = (await upgraded.read()).revision;
  await upgraded.save(false, firstConsent);
  await expect(stat(join(directory, 'reporting-session.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await upgraded.save(true, (await upgraded.read()).revision);
  expect((await upgraded.read()).revision).not.toBe(firstConsent);
  upgraded.close();
  await upgraded.idle();
});

test('opting out persists across restart when session cleanup cannot remove a changed marker', async () => {
  const directory = await fixture();
  const send = vi.fn<typeof fetch>(async () => new Response(null));
  const reports = new CrashReports(directory, dsn, runtime, send);
  await reports.start();
  const enabled = await reports.save(true, (await reports.read()).revision);
  const marker = join(directory, 'reporting-session.json');
  const changed = JSON.stringify({
    ...JSON.parse(await readFile(marker, 'utf8')),
    session: crypto.randomUUID(),
  });
  await writeFile(marker, changed);
  expect(await reports.save(false, enabled.revision)).toMatchObject({
    enabled: false,
    warning: 'cleanup',
  });
  expect(await readFile(marker, 'utf8')).toBe(changed);
  // Simulate a process exit immediately after the preference was acknowledged.
  const next = new CrashReports(directory, dsn, runtime, send);
  await next.start();
  expect(await next.read()).toMatchObject({ enabled: false });
  await next.capture('renderer', 'crashed');
  expect(send).not.toHaveBeenCalled();
  expect(await readFile(marker, 'utf8')).toBe(changed);
});

test('session startup failure still allows the user to revoke a valid saved consent', async () => {
  const directory = await fixture();
  const enabled = new CrashReports(directory, dsn, runtime);
  await enabled.save(true, null);
  const marker = join(directory, 'reporting-session.json');
  await writeFile(marker, 'unreadable session');
  const next = new CrashReports(directory, dsn, runtime);
  await next.start();
  const disabled = await next.read();
  expect(disabled).toMatchObject({ enabled: false, warning: 'session' });
  await next.save(false, disabled.revision);
  expect(JSON.parse(await readFile(join(directory, 'crash-reporting.json'), 'utf8')).enabled).toBe(
    false,
  );
  expect(await readFile(marker, 'utf8')).toBe('unreadable session');
});

test('shutdown drains an admitted opt-out before closing reporting storage', async () => {
  const directory = await fixture();
  const reports = new CrashReports(directory, dsn, runtime);
  await reports.start();
  const enabled = await reports.save(true, null);
  const revoking = reports.save(false, enabled.revision);
  reports.close();
  expect((await revoking).enabled).toBe(false);
  await reports.idle();
  const next = new CrashReports(directory, dsn, runtime);
  expect((await next.read()).enabled).toBe(false);
  await expect(reports.save(false, null)).rejects.toThrow(/closed/);
});

test('a failed first opt-in leaves consent disabled on the next launch', async () => {
  const directory = await fixture();
  const marker = join(directory, 'reporting-session.json');
  await writeFile(marker, 'unreadable session');
  const reports = new CrashReports(directory, dsn, runtime);
  await reports.start();
  await expect(reports.save(true, null)).rejects.toThrow();
  expect((await reports.read()).enabled).toBe(false);
  await rm(marker);
  const next = new CrashReports(directory, dsn, runtime);
  await next.start();
  expect((await next.read()).enabled).toBe(false);
});

test('consent survives restart, is bound to the exact destination, and revocation persists', async () => {
  const directory = await fixture();
  const reports = new CrashReports(directory, dsn, runtime);
  await reports.save(true, (await reports.read()).revision);
  const restarted = new CrashReports(directory, dsn, runtime);
  expect((await restarted.read()).enabled).toBe(true);
  const changed = new CrashReports(directory, dsn.replace('/123', '/456'), runtime);
  expect((await changed.read()).enabled).toBe(false);
  await restarted.save(false, (await restarted.read()).revision);
  expect((await new CrashReports(directory, dsn, runtime).read()).enabled).toBe(false);
  await expect(reports.save(true, null)).rejects.toThrow(/changed/);
});

test('events before consent are discarded and concurrent crashes cannot bypass the session cap', async () => {
  let count = 0;
  const reports = new CrashReports(await fixture(), dsn, runtime, async () => {
    count++;
    return new Response(null);
  });
  const initial = await reports.read();
  const enabling = reports.save(true, initial.revision);
  const earlier = reports.capture('renderer', 'crashed');
  await Promise.all([enabling, earlier]);
  expect(count).toBe(0);
  await reports.capture('/home/private/repository', 'crashed');
  await reports.capture('git', 'secret-token: failed at private.ts');
  await reports.capture('renderer', 'clean-exit');
  await reports.capture('terminal', 'killed');
  expect(count).toBe(0);
  await Promise.all(Array.from({ length: 20 }, () => reports.capture('renderer', 'crashed')));
  expect(count).toBe(1);
  for (const process of ['git', 'terminal', 'gpu']) {
    for (const reason of ['crashed', 'oom']) await reports.capture(process, reason);
  }
  expect(count).toBe(5);
  await reports.capture('/home/private/repository', 'crashed');
  await reports.capture('git', 'secret-token: failed at private.ts');
  expect(count).toBe(5);
});

test('a stalled upload is aborted at five seconds without retrying', async () => {
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let calls = 0;
  const reports = new CrashReports(await fixture(), dsn, runtime, async (_url, init) => {
    calls++;
    start();
    return new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  });
  await reports.save(true, (await reports.read()).revision);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const sent = reports.capture('renderer', 'oom');
    await started;
    await vi.advanceTimersByTimeAsync(5000);
    await sent;
    expect((await reports.read()).delivery).toBe('failed');
    expect(calls).toBe(1);
  } finally {
    vi.useRealTimers();
    reports.close();
  }
});

test('redirected consent storage stays disabled and is never overwritten', async () => {
  const directory = await fixture();
  const target = join(directory, 'private-original');
  await writeFile(target, 'private original');
  await symlink(target, join(directory, 'crash-reporting.json'));
  const reports = new CrashReports(directory, dsn, runtime);
  expect(await reports.read()).toMatchObject({ enabled: false, warning: 'unreadable' });
  await expect(reports.save(true, null)).rejects.toThrow(/cannot be read/);
  expect(await readFile(target, 'utf8')).toBe('private original');
});

test('opt-out aborts an in-flight request and blocks reports even when saving fails', async () => {
  let signal: AbortSignal | undefined;
  let calls = 0;
  const directory = await fixture();
  const reports = new CrashReports(directory, dsn, runtime, async (_url, init) => {
    calls++;
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  });
  await reports.save(true, (await reports.read()).revision);
  const sending = reports.capture('git', 'crashed');
  await expect.poll(() => signal).toBeDefined();
  await writeFile(join(directory, 'crash-reporting.json'), 'external change');
  await expect(reports.save(false, (await reports.read()).revision)).rejects.toThrow(/changed/);
  await sending;
  expect(signal?.aborted).toBe(true);
  expect((await reports.read()).enabled).toBe(false);
  await reports.capture('renderer', 'crashed');
  expect(calls).toBe(1);
});

test('missing configuration, corrupt consent and external edits fail closed', async () => {
  const directory = await fixture();
  const missing = new CrashReports(directory, null, runtime);
  await expect(missing.save(true, (await missing.read()).revision)).rejects.toThrow(
    /no crash reporting destination/,
  );
  await writeFile(join(directory, 'crash-reporting.json'), '{"enabled":true}');
  const corrupt = new CrashReports(directory, dsn, runtime);
  expect(await corrupt.read()).toMatchObject({ enabled: false, warning: 'unreadable' });
  await expect(corrupt.save(true, null)).rejects.toThrow(/cannot be read/);
  expect(await readFile(join(directory, 'crash-reporting.json'), 'utf8')).toBe('{"enabled":true}');
});

test('transport failures are bounded and never expose server response text', async () => {
  let calls = 0;
  const reports = new CrashReports(await fixture(), dsn, runtime, async () => {
    calls++;
    return new Response('private-server-token', { status: 429 });
  });
  await reports.save(true, (await reports.read()).revision);
  await reports.capture('renderer', 'oom');
  await reports.capture('renderer', 'oom');
  expect(calls).toBe(1);
  expect((await reports.read()).delivery).toBe('failed');
  expect(JSON.stringify(await reports.read())).not.toContain('private-server-token');
});

test('Sentry destination parsing refuses insecure or credential-bearing destinations', () => {
  expect(reportDestination(null)).toBeNull();
  for (const invalid of [
    dsn.replace('https:', 'http:'),
    dsn.replace('@', ':secret@'),
    `${dsn}?token=private`,
    `${dsn}#fragment`,
    dsn.replace('/123', '/invalid'),
    dsn.replace('0123456789abcdef0123456789abcdef', 'private-name'),
  ])
    expect(() => reportDestination(invalid)).toThrow();
  expect(reportDestination(dsn.replace('/123', '/sentry/123'))?.endpoint).toBe(
    'https://reports.example.invalid/sentry/api/123/envelope/',
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'openkraken-crash-reports-'));
  directories.push(directory);
  return directory;
}
const dsn = 'https://0123456789abcdef0123456789abcdef@reports.example.invalid/123';
const runtime = { version: '0.1.0', platform: 'linux', arch: 'x64' };

test('reporting is off by default and explicit consent sends only an allowlisted failure summary', async () => {
  const directory = await fixture();
  const requests: { url: string; init?: RequestInit }[] = [];
  const reports = new CrashReports(directory, dsn, runtime, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  });
  const initial = await reports.read();
  expect(initial).toMatchObject({
    enabled: false,
    destination: 'https://reports.example.invalid',
    warning: null,
  });
  await reports.capture('renderer', 'crashed');
  expect(requests).toHaveLength(0);
  await expect(stat(join(directory, 'crash-reporting.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await reports.save(true, initial.revision);
  await reports.capture('renderer', 'crashed');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe('https://reports.example.invalid/api/123/envelope/');
  expect(requests[0]!.init).toMatchObject({
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
  });
  const [header, item, payload] = String(requests[0]!.init!.body)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(header).toEqual({ event_id: expect.stringMatching(/^[a-f0-9]{32}$/), dsn });
  expect(item).toEqual({ type: 'event', length: Buffer.byteLength(JSON.stringify(payload)) });
  expect(payload).toEqual({
    event_id: header.event_id,
    platform: 'native',
    level: 'fatal',
    release: 'openkraken@0.1.0',
    message: 'OpenKraken process failure',
    tags: { process: 'renderer', reason: 'crashed', os: 'linux', arch: 'x64' },
  });
  if (process.platform !== 'win32')
    expect((await stat(join(directory, 'crash-reporting.json'))).mode & 0o777).toBe(0o600);
  expect((await reports.read()).delivery).toBe('sent');
});
