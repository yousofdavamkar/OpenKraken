import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  decodeHistoryPage,
  decodeSnapshotBodies,
  expandGitServiceResult,
  type ServiceResult,
  type Result,
} from '../../packages/ipc-contract/src/index.js';
import { createFixture, fixtureGit } from '../../packages/test-fixtures/src/index.js';

test('serialized responses retain Git text, paging and errors through the sandbox bridge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-serialized-ipc-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 2003);
  const summary = 'Résumé 🌱 "quoted" \\ path';
  const body = 'First line\nSecond line\twith a tab';
  fixtureGit(repository, ['tag', '-d', 'v0.1.0', 'annotated']);
  fixtureGit(repository, ['commit', '--amend', '--allow-empty', '-m', summary, '-m', body]);
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open a repository', exact: true }).waitFor();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    const raw = await page.evaluate(() =>
      window.openkraken.request({ id: crypto.randomUUID(), method: 'open' }, 'json'),
    );
    expect(typeof raw).toBe('string');
    const opened: Result = JSON.parse(raw);
    if (opened.kind !== 'snapshot') throw new Error('Expected repository snapshot');
    expect(opened.snapshot.commits).toHaveLength(2000);
    expect(opened.snapshot.commits[0]).toMatchObject({
      summary,
      body: `${summary}\n\n${body}\n`,
    });
    const pageRequest = {
      method: 'page' as const,
      repoId: opened.snapshot.repository.id,
      cursor: opened.snapshot.cursor,
      offset: 2000,
      count: 5000,
    };
    const next: Result = JSON.parse(
      await page.evaluate(
        (request) => window.openkraken.request({ id: crypto.randomUUID(), ...request }, 'json'),
        pageRequest,
      ),
    );
    expect(next).toMatchObject({ kind: 'page', offset: 2000, hasMore: false });
    if (next.kind !== 'page') throw new Error('Expected history page');
    expect(next.commits.map((commit) => commit.summary)).toEqual([
      'Commit 3 — linear',
      'Commit 2 — linear',
      'Commit 1 — linear',
    ]);
    const stale: Result = JSON.parse(
      await page.evaluate(
        (request) => window.openkraken.request({ id: crypto.randomUUID(), ...request }, 'json'),
        pageRequest,
      ),
    );
    expect(stale).toMatchObject({ kind: 'error', code: 'STALE_PAGE' });
    await expect(
      page.evaluate(
        (request) =>
          window.openkraken.request({ id: crypto.randomUUID(), ...request, count: 5001 }, 'json'),
        pageRequest,
      ),
    ).rejects.toThrow();
    await expect(
      page.evaluate(() =>
        Reflect.apply(window.openkraken.request, window.openkraken, [
          { id: crypto.randomUUID(), method: 'commandPreferences' },
          'yaml',
        ]),
      ),
    ).rejects.toThrow('Invalid response format');
    const split = await page.evaluate(async (old) => {
      const refreshed = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'refresh',
        repoId: old.repoId,
      });
      if (refreshed.kind !== 'snapshot') throw new Error('Expected refreshed snapshot');
      const page = { ...old, cursor: refreshed.snapshot.cursor };
      const transferred = await window.openkraken.request(
        { id: crypto.randomUUID(), ...page },
        'history-page',
      );
      const stale = await window.openkraken.request(
        { id: crypto.randomUUID(), ...page },
        'history-page',
      );
      return { transferred, cursor: refreshed.snapshot.cursor, stale };
    }, pageRequest);
    expect(decodeHistoryPage(split.transferred)).toEqual({ ...next, cursor: split.cursor });
    expect(split.stale).toMatchObject({ kind: 'error', code: 'STALE_PAGE' });
    for (const [method, format] of [
      ['open', 'history-page'],
      ['commandPreferences', 'snapshot-json'],
      ['commandPreferences', 'snapshot-transfer'],
      ['commandPreferences', 'snapshot-bodies'],
    ]) {
      await expect(
        page.evaluate(
          ([method, format]) =>
            Reflect.apply(window.openkraken.request, window.openkraken, [
              { id: crypto.randomUUID(), method },
              format,
            ]),
          [method, format],
        ),
      ).rejects.toThrow('Invalid response format');
    }
    const firstPage = await page.evaluate(
      (repoId) =>
        window.openkraken.request(
          { id: crypto.randomUUID(), method: 'refresh', repoId },
          'snapshot-bodies',
        ),
      opened.snapshot.repository.id,
    );
    expect(typeof firstPage).toBe('object');
    const restored = decodeSnapshotBodies(firstPage);
    if (restored.kind !== 'snapshot') throw new Error('Expected split commit bodies');
    expect(restored.snapshot.commits).toEqual(opened.snapshot.commits);
    const preferences = await page.evaluate(async () => {
      const request = { id: crypto.randomUUID(), method: 'commandPreferences' as const };
      return {
        object: await window.openkraken.request(request),
        serialized: JSON.parse(
          await window.openkraken.request({ ...request, id: crypto.randomUUID() }, 'json'),
        ),
      };
    });
    expect(preferences.serialized).toEqual(preferences.object);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('large Git snapshots round-trip their ordered reference records through all snapshot response formats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkraken-large-refs-ipc-'));
  const repository = createFixture(join(root, 'repo'), 'linear', 5);
  const head = fixtureGit(repository, ['rev-parse', 'HEAD']);
  fixtureGit(
    repository,
    ['update-ref', '--stdin'],
    Array.from({ length: 10000 }, (_, i) => `create refs/tags/fixture-${i} ${head}\n`).join(''),
  );
  fixtureGit(repository, ['pack-refs', '--all']);
  fixtureGit(repository, ['branch', 'Ångström/🌱']);
  const names = fixtureGit(repository, ['for-each-ref', '--format=%(refname)']).split('\n');
  const app = await electron.launch({
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, repository);
    const result = await page.evaluate(async () => {
      const opened = await window.openkraken.request({ id: crypto.randomUUID(), method: 'open' });
      if (opened.kind !== 'snapshot') throw new Error('Expected an ordinary snapshot');
      const refreshed: Result = JSON.parse(
        await window.openkraken.request(
          { id: crypto.randomUUID(), method: 'refresh', repoId: opened.snapshot.repository.id },
          'json',
        ),
      );
      if (refreshed.kind !== 'snapshot') throw new Error('Expected a serialized snapshot');
      return {
        refs: opened.snapshot.refs,
        compact: await window.openkraken.request(
          { id: crypto.randomUUID(), method: 'refresh', repoId: opened.snapshot.repository.id },
          'snapshot-json',
        ),
        transfer: await window.openkraken.request(
          { id: crypto.randomUUID(), method: 'refresh', repoId: opened.snapshot.repository.id },
          'snapshot-transfer',
        ),
        bodies: await window.openkraken.request(
          { id: crypto.randomUUID(), method: 'refresh', repoId: opened.snapshot.repository.id },
          'snapshot-bodies',
        ),
        commits: opened.snapshot.commits,
        same: JSON.stringify(opened.snapshot.refs) === JSON.stringify(refreshed.snapshot.refs),
        branch: opened.snapshot.refs.find((ref) => ref.shortName === 'Ångström/🌱'),
        annotated: opened.snapshot.refs.find((ref) => ref.name === 'refs/tags/annotated'),
      };
    });
    const wire: ServiceResult = JSON.parse(result.compact);
    expect(wire.kind).toBe('compactSnapshot');
    if (wire.kind !== 'compactSnapshot') throw new Error('Expected self-contained ref rows');
    expect(
      wire.snapshot.refs.filter((row) => typeof row === 'string').length,
    ).toBeGreaterThanOrEqual(10000);
    const transfer: ServiceResult = JSON.parse(result.transfer);
    if (transfer.kind !== 'compactSnapshot') throw new Error('Expected compact renderer transfer');
    expect(transfer.snapshot.refs).toContain('refs/tags/fixture-9999');
    expect(wire.snapshot.refs).toContain(head + ':refs/tags/fixture-9999');
    const split = decodeSnapshotBodies(result.bodies);
    if (split.kind !== 'compactSnapshot')
      throw new Error('Expected compact refs with split bodies');
    expect(split.snapshot.refs).toEqual(transfer.snapshot.refs);
    expect(split.snapshot.commits).toEqual(result.commits);
    const displayed = expandGitServiceResult(transfer);
    if (displayed.kind !== 'snapshot') throw new Error('Expected expanded renderer snapshot');
    expect(displayed.snapshot.refs).toEqual(result.refs);
    const expanded = expandGitServiceResult(wire);
    if (expanded.kind !== 'snapshot') throw new Error('Expected reference records');
    expect(expanded.snapshot.refs).toEqual(result.refs);
    expect(result.refs.map((ref) => ref.name)).toEqual(names);
    expect(result.same).toBe(true);
    expect(result.branch).toMatchObject({
      kind: 'local',
      objectType: 'commit',
      target: head,
      isHead: false,
    });
    expect(result.annotated).toMatchObject({
      kind: 'tag',
      objectType: 'tag',
      peeledType: 'commit',
      peeled: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const format of ['snapshot-transfer', 'snapshot-bodies'] as const) {
  test(`large annotated alias runs retain every tag field through ${format}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkraken-annotation-ipc-'));
    const repository = createFixture(join(root, 'repo'), 'linear', 3);
    const target = fixtureGit(repository, ['rev-parse', 'refs/tags/annotated']);
    const peeled = fixtureGit(repository, ['rev-parse', 'refs/tags/annotated^{}']);
    const names = Array.from(
      { length: 10000 },
      (_, i) => 'refs/tags/版本-' + String(i).padStart(5, '0'),
    );
    fixtureGit(
      repository,
      ['update-ref', '--stdin'],
      names.map((name) => `create ${name} ${target}\n`).join(''),
    );
    fixtureGit(repository, ['pack-refs', '--all']);
    const entry = join(root, 'observe-transfer.cjs');
    writeFileSync(
      entry,
      `
    const { utilityProcess } = require('electron');
    const fork = utilityProcess.fork.bind(utilityProcess);
    utilityProcess.fork = (...args) => {
      const child = fork(...args);
      if (args[0].endsWith('git-service.cjs')) {
        utilityProcess.fork = fork;
        child.on('message', (message) => {
          if (message?.snapshotPart === 'tagAliases')
            globalThis.annotationAliases = message.refs.filter(row => typeof row === 'string').length;
        });
      }
      return child;
    };
    require(${JSON.stringify(resolve('apps/desktop/dist/main.cjs'))});
  `,
    );
    const app = await electron.launch({
      args: [entry, `--user-data-dir=${join(root, 'profile')}`],
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, repository);
      const payload = await page.evaluate((format) => {
        const request = { id: crypto.randomUUID(), method: 'open' as const };
        return format === 'snapshot-transfer'
          ? window.openkraken.request(request, 'snapshot-transfer')
          : window.openkraken.request(request, 'snapshot-bodies');
      }, format);
      const wire = decodeSnapshotBodies(payload);
      if (format === 'snapshot-bodies') {
        expect(wire.kind).toBe('tagAliasSnapshot');
        if (wire.kind !== 'tagAliasSnapshot') throw Error('Missing compact annotated tags');
        expect(
          wire.snapshot.refs.filter((row) => typeof row === 'string').length,
        ).toBeGreaterThanOrEqual(9999);
      } else expect(wire.kind).toBe('snapshot');
      const result = expandGitServiceResult(wire);
      if (result.kind !== 'snapshot') throw Error('Expected ordinary snapshot');
      const aliases = result.snapshot.refs.filter((ref) => ref.name.startsWith('refs/tags/版本-'));
      expect(aliases.map((ref) => ref.name)).toEqual(names);
      expect(
        aliases.every(
          (ref) =>
            ref.shortName === ref.name.slice(10) &&
            ref.target === target &&
            ref.peeled === peeled &&
            ref.kind === 'tag' &&
            ref.peeledType === 'commit' &&
            ref.objectType === 'tag' &&
            !ref.upstream &&
            !ref.isHead,
        ),
      ).toBe(true);
      expect(
        await app.evaluate(() => Reflect.get(globalThis, 'annotationAliases')),
      ).toBeGreaterThanOrEqual(9999);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const interruption of ['early cancel', 'late cancel', 'stop utility'] as const) {
  test(`a staged opening waits for the native outcome and can reuse the request ID (${interruption})`, async () => {
    test.skip(
      interruption === 'early cancel' && process.platform === 'win32',
      'This fixture holds a native Git walk using a POSIX shell',
    );
    const root = mkdtempSync(join(tmpdir(), 'openkraken-interrupted-refs-'));
    const repository = createFixture(join(root, 'repo'), 'linear', 5);
    const head = fixtureGit(repository, ['rev-parse', 'HEAD']);
    fixtureGit(
      repository,
      ['update-ref', '--stdin'],
      Array.from({ length: 10000 }, (_, i) => `create refs/tags/open-${i} ${head}\n`).join(''),
    );
    fixtureGit(repository, ['pack-refs', '--all']);
    const git = join(root, 'hold-history');
    if (interruption === 'early cancel') {
      writeFileSync(
        git,
        '#!/bin/sh\ncase " $* " in *" rev-list "*" --parents "*) while [ -f "$0.gate" ]; do sleep 1; done;; esac\nexec git "$@"\n',
        { mode: 0o755 },
      );
      writeFileSync(git + '.gate', '');
    }
    const app = await electron.launch({
      env: interruption === 'early cancel' ? { ...process.env, OPENKRAKEN_GIT: git } : undefined,
      args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'profile')}`],
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(
        ({ dialog, utilityProcess }, { path, holdComplete }) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
          const fork = utilityProcess.fork.bind(utilityProcess);
          utilityProcess.fork = (...args) => {
            const child = fork(...args);
            if (!args[0].endsWith('git-service.cjs')) return child;
            utilityProcess.fork = fork;
            const emit = child.emit.bind(child);
            child.emit = (event, ...values) => {
              const message = values[0];
              if (event === 'message' && message?.snapshotPart === 'refs') {
                Reflect.set(globalThis, 'observedRefCount', message.refs.length);
              } else if (
                holdComplete &&
                event === 'message' &&
                message?.snapshotPart === 'complete'
              ) {
                child.emit = emit;
                Reflect.set(globalThis, 'releaseSnapshot', (stop: boolean) =>
                  stop ? child.kill() : emit(event, ...values),
                );
                return true;
              }
              return emit(event, ...values);
            };
            return child;
          };
        },
        { path: repository, holdComplete: interruption !== 'early cancel' },
      );
      // The app prestarts its first Git utility before creating the window. Observe its replacement.
      await app.evaluate(async ({ app }) => {
        const service = app.getAppMetrics().find((metric) => metric.name === 'OpenKraken Git');
        if (!service) throw Error('Missing prestarted Git utility');
        const gone = new Promise<void>((resolve) =>
          app.once('child-process-gone', () => resolve()),
        );
        process.kill(service.pid, 'SIGKILL');
        await gone;
      });
      const id = await page.evaluate(() => crypto.randomUUID());
      let settled = false;
      const opening = page
        .evaluate((id) => window.openkraken.request({ id, method: 'open' }), id)
        .then((result) => {
          settled = true;
          return result;
        });
      if (interruption !== 'early cancel') {
        await expect
          .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseSnapshot')))
          .toBe('function');
      }
      await expect
        .poll(() => app.evaluate(() => Reflect.get(globalThis, 'observedRefCount') ?? 0))
        .toBeGreaterThanOrEqual(10000);
      expect(settled).toBe(false);
      if (interruption !== 'stop utility')
        await page.evaluate((id) => window.openkraken.cancel(id), id);
      if (interruption === 'early cancel') {
        expect(await opening).toMatchObject({ kind: 'cancelled' });
        rmSync(git + '.gate');
      } else {
        await app.evaluate(
          (_, stop) => Reflect.get(globalThis, 'releaseSnapshot')(stop),
          interruption === 'stop utility',
        );
        expect(await opening).toMatchObject(
          interruption === 'late cancel'
            ? { kind: 'snapshot' }
            : { kind: 'error', code: 'SERVICE_EXIT' },
        );
      }
      const retry = await page.evaluate(async (id) => {
        const result = await window.openkraken.request({ id, method: 'open' });
        if (result.kind !== 'snapshot') throw Error('Retry did not return a complete snapshot');
        return {
          count: result.snapshot.refs.length,
          last: result.snapshot.refs.find((ref) => ref.shortName === 'open-9999')?.target,
        };
      }, id);
      expect(retry.count).toBeGreaterThanOrEqual(10000);
      expect(retry.last).toBe(head);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
