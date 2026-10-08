import assert from 'node:assert/strict';
import test from 'node:test';
import { launcherPort } from '../bin/launcher-port.mjs';

for (const [input, expected] of [['1', '1'], ['4200', '4200'], ['65535', '65535'], ['004200', '4200']]) {
  test(`canonical launcher port ${input}`, () => assert.equal(launcherPort(input), expected));
}

for (const [label, input] of [
  ['empty', ''], ['zero', '0'], ['above range', '65536'], ['negative', '-1'],
  ['fraction', '4200.5'], ['exponent', '42e2'], ['hexadecimal', '0x1068'],
  ['leading space', ' 4200'], ['trailing space', '4200 '], ['line feed', '4200\n'],
  ['carriage return', '4200\r'], ['non-ASCII digits', '４２００'],
  ['separator', '4200&echo marker'], ['pipe', '4200|echo marker'],
  ['expansion', '4200%USERNAME%'], ['delayed expansion', '4200!USERNAME!'],
  ['quote', '4200"'], ['escape', '4200^'], ['overflow', '9'.repeat(400)],
  ['missing', undefined], ['null', null], ['number', 4200],
]) {
  test(`reject launcher port ${label}`, () => assert.throws(() => launcherPort(input), /Invalid FLUJO port/));
}
