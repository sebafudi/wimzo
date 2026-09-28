import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { App } from '../src/app.ts';

test('the app tightens a loose state directory and opens an already private one without chmod',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wimzo-app-state-'));
  const loose=join(root,'loose');mkdirSync(loose,{mode:0o755});
  let app=new App(loose);await app.close();
  assert.equal(statSync(loose).mode&0o777,0o700);
  app=new App(loose);await app.close();
  assert.equal(statSync(loose).mode&0o777,0o700);
});
