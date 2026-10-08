import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import parser from 'postcss-selector-parser';
import { selectorSpecificity } from '@csstools/selector-specificity';

const require = createRequire(import.meta.url);

test('selector parsing preserves escaped, namespaced and nested production selectors', () => {
  for (const selector of [
    '#app .card:is(.active, #primary):not([hidden]) > a::before',
    ':where(.a, #id) [data-name="a.b"]',
    '.namespace\\:class:hover',
    'svg|a, *|*',
    '#foo:has(> .foo)',
  ]) {
    assert.equal(parser().processSync(selector), selector);
  }
  assert.equal(parser(ast => ast.walkClasses(node => { node.value = 'renamed'; }))
    .processSync('#app .card:not(.inactive)'), '#app .renamed:not(.renamed)');
});

test('the existing specificity consumer accepts the patched selector AST', () => {
  for (const [selector, expected] of [
    ['#foo:has(> .foo)', { a: 1, b: 1, c: 0 }],
    [':where(#foo, .bar) .baz', { a: 0, b: 1, c: 0 }],
    [':is(.class, #primary) a', { a: 1, b: 0, c: 1 }],
  ]) {
    assert.deepEqual(selectorSpecificity(parser().astSync(selector)), expected);
  }
});

test('the advisory flat-selector payload completes within a bounded child process', () => {
  // GHSA-rj75-hqrm-r3gf: the old quadratic index scans take tens of seconds
  // for this 400 KB flat selector; a separate process bounds a regression.
  const child = spawnSync(process.execPath, ['-e', `
    const parser = require(${JSON.stringify(require.resolve('postcss-selector-parser'))});
    const selector = '.a'.repeat(200000);
    const ast = parser().astSync(selector);
    process.stdout.write(JSON.stringify({
      classes: ast.first.nodes.length, roundTrip: ast.toString() === selector,
    }));
  `], { encoding: 'utf8', timeout: 8000, maxBuffer: 4096, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { classes: 200000, roundTrip: true });
});
