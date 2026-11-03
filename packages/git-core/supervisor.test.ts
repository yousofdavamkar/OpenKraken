import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configureProcessSupervisor, runProcess } from './src/runner.js';

configureProcessSupervisor(
  resolve(
    'apps/desktop/dist/helpers',
    process.platform === 'win32' ? 'openkraken-askpass.exe' : 'openkraken-askpass',
  ),
);

async function stopped(pid: number) {
  await expect
    .poll(async () => {
      if (process.platform === 'linux') {
        try {
          return /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'));
        } catch {
          return true;
        }
      }
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
}

test('supervised processes preserve binary stdin, streaming output, stderr and literal arguments', async () => {
  const input = Buffer.from(Array.from({ length: 512 * 1024 }, (_, index) => index % 256));
  const output: Buffer[] = [];
  const result = await runProcess(
    process.execPath,
    [
      '-e',
      'process.stderr.write(process.argv[1]); process.stdin.pipe(process.stdout)',
      'literal " ✓ $()',
    ],
    {
      stdin: input,
      maxBytes: 2 * 1024 * 1024,
      onStdout: (chunk) => {
        output.push(chunk);
      },
    },
  );
  expect(Buffer.concat(output)).toEqual(input);
  expect(result.stdout).toHaveLength(0);
  expect(result.stderr).toBe('literal " ✓ $()');
  expect(result.exitCode).toBe(0);
});

test('supervision preserves nonzero command outcomes and refuses an unavailable executable', async () => {
  expect(
    await runProcess(process.execPath, ['-e', 'process.exit(1)'], { allowedExitCodes: [0, 1] }),
  ).toMatchObject({ exitCode: 1 });
  await expect(runProcess(process.execPath, ['-e', 'process.exit(7)'])).rejects.toMatchObject({
    code: 'GIT_FAILED',
    exitCode: 7,
  });
  await expect(runProcess('openkraken-does-not-exist', [])).rejects.toMatchObject({
    code: 'GIT_FAILED',
    exitCode: 125,
  });
});

test('supervised execution retains output limits, timeouts and streaming parser failures', async () => {
  await expect(
    runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
      maxBytes: 10,
    }),
  ).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  await expect(
    runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }),
  ).rejects.toMatchObject({ code: 'TIMEOUT' });
  await expect(
    runProcess(process.execPath, ['-e', 'console.log("input")'], {
      onStdout: () => {
        throw new Error('parser failed');
      },
    }),
  ).rejects.toThrow('parser failed');
});

test('supervised cancellation kills a descendant that retains streams after its direct parent exits', async () => {
  const controller = new AbortController();
  let childPid = 0;
  let text = '';
  const descendant =
    'process.on("SIGTERM",()=>{}); console.log(process.pid); setInterval(()=>{},1000)';
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']}); child.unref(); process.exit(0);`;
  const result = runProcess(process.execPath, ['-e', script], {
    signal: controller.signal,
    onStdout: (chunk) => {
      text += chunk.toString();
      if (!text.includes('\n')) return;
      childPid = Number(text.trim());
      controller.abort();
    },
  });
  await expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(childPid).toBeGreaterThan(0);
  await stopped(childPid);
});
