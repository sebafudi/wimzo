import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
test('independent launch-boundary acceptance cases use synthetic local runtimes', { timeout: 60_000 }, async () => {
  const script = fileURLToPath(new URL('../scripts/verify-launch-boundaries.mjs', import.meta.url));
  const { stdout } = await exec(process.execPath, [script], { timeout: 55_000, maxBuffer: 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.ok(report.total >= 20);
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter((item: any) => !item.pass)));
});
