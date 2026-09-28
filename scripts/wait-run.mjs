#!/usr/bin/env node
// Wait on an existing detached run without inference, dispatch or result collection.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const [runId, seconds = '60'] = process.argv.slice(2);
if (!/^run_[a-zA-Z0-9_-]+$/.test(runId ?? '')) throw new Error('Usage: node scripts/wait-run.mjs RUN_ID [SECONDS]');
const duration = Number(seconds);
if (!Number.isFinite(duration) || duration < 1 || duration > 60) throw new Error('Wait must be between 1 and 60 seconds');
const state = resolve(process.env.WIMZO_STATE_DIR ?? join(import.meta.dirname, '../.wimzo'));
const path = join(state, 'runs', runId, 'status.json');
if (!existsSync(path)) throw new Error(`Run status is missing: ${runId}. Inspect the saved run; do not relaunch blindly.`);
const until = Date.now() + duration * 1000;
let status;
let processPresent;
do {
  status = JSON.parse(readFileSync(path, 'utf8'));
  if (['completed', 'failed', 'paused', 'canceled'].includes(status.state)) break;
  const pid = status.wrapperPid ?? status.pid;
  processPresent = undefined;
  if (Number.isInteger(pid) && pid > 1) {
    try { process.kill(pid, 0); processPresent = true; }
    catch (error) { if (error.code === 'ESRCH') processPresent = false; }
  }
  if (processPresent === false || Date.now() >= until) break;
  await new Promise(resolve => setTimeout(resolve, 500));
} while (Date.now() <= until);
console.log(JSON.stringify({ runId, status, processPresent, timedOut: Date.now() >= until && !['completed', 'failed', 'paused', 'canceled'].includes(status.state), action: 'inspect or continue waiting on this same run; no work was restarted' }, null, 2));
