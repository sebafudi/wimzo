import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {lexer} from 'marked';
// Browser module is plain JavaScript, shared with this DOM verification.
// @ts-ignore
import {markdownRenderer} from '../src/markdown.js';
const setup = () => markdownRenderer(lexer, parseHTML('<!doctype html><html><body></body></html>').document);

test('renders realistic Markdown structure without exposing source syntax', () => {
  const view = setup().render('# Product\n\nA **clear** goal and *context* with `code`.\n\n## Tasks\n\n- First\n  - Nested\n- [x] Done\n\n| Item | Status |\n| --- | --- |\n| Preview | Ready |\n\n> A quote\n\n```ts\nconst value = "<safe>";\n```\n\n[Docs](https://example.com/docs)');
  assert.equal(view.querySelector('h1').textContent,'Product');
  assert.equal(view.querySelector('strong').textContent,'clear');
  assert.equal(view.querySelector('ul ul li').textContent,'Nested');
  assert.equal(view.querySelector('input').checked,true);
  assert.equal(view.querySelector('td').textContent,'Preview');
  assert.equal(view.querySelector('pre code').textContent,'const value = "<safe>";');
  assert.equal(view.querySelector('a').getAttribute('rel'),'noopener noreferrer');
});

test('untrusted HTML, unsafe links and images cannot create executable or remote content', () => {
  const view = setup().render('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) [data](data:text/html,bad) [relative](../secret) ![pixel](https://example.com/tracker)\n\n&lt;svg onload=alert(1)&gt;');
  assert.equal(view.querySelectorAll('img,script,svg,iframe,a').length,0);
  assert.match(view.textContent, /<img src=x onerror/);
  assert.match(view.textContent, /Image: pixel/);
  assert.match(view.textContent, /<svg onload/);
});

test('formatted diff preserves context and highlights complete removed and added blocks', () => {
  const renderer = setup();
  const view = renderer.compare('# Product\n\nKeep this.\n\n**Old** behavior.\n\n- one\n- two\n', '# Product\n\nKeep this.\n\n**New** behavior.\n\n- one\n- three\n');
  assert.equal(view.querySelectorAll('.removed').length,2);
  assert.equal(view.querySelectorAll('.added').length,2);
  assert.equal(view.querySelector('.removed strong').textContent,'Old');
  assert.equal(view.querySelector('.added strong').textContent,'New');
  assert.ok([...view.querySelectorAll('.unchanged')].some(el=>el.textContent.includes('Keep this.')));
  assert.match(renderer.compare('[Guide][r]\n\n[r]: https://old.example', '[Guide][r]\n\n[r]: https://new.example').querySelector('.added a').href,/new.example/);
  assert.match(renderer.compare('same\n','same\n\n').textContent,/rendered content is unchanged/);
  assert.ok(renderer.compare('Removed file',null).querySelector('.removed'));
  assert.ok(renderer.compare(null,'New file').querySelector('.added'));
  assert.throws(()=>renderer.render('x'.repeat(200001)),/too large/);
});
