import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { locateGo } from './build-askpass.mjs';

// The desktop build already requires Go. Its TLS example generates a fresh
// short-lived certificate and key in the test's private temporary directory.
const directory = process.argv[2];
if (!directory) throw new Error('Pass the temporary test directory');
const go = await locateGo();
const root = execFileSync(go, ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
execFileSync(
  go,
  [
    'run',
    join(root, 'src', 'crypto', 'tls', 'generate_cert.go'),
    '-host',
    'localhost,127.0.0.1',
    '-ca',
    '-duration',
    '24h',
    '-ecdsa-curve',
    'P256',
  ],
  { cwd: directory, env: { ...process.env, GOTOOLCHAIN: 'local' } },
);
