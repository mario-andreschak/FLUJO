import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FORMAL_DIR, TLA_TOOLS, classifyExit, javaCommand, javaMajorVersion, parseExpectation } from './check-formal.mjs';

test('reads the expectation from the first line only', () => {
  assert.equal(parseExpectation('\\* expect: ok\nCONSTANTS'), 'ok');
  assert.equal(parseExpectation('\\* expect: violation\r\nCONSTANTS'), 'violation');
  assert.equal(parseExpectation('CONSTANTS\n\\* expect: ok'), undefined);
  assert.equal(parseExpectation('\\* expect: maybe'), undefined);
});

test('maps TLC exit codes to outcomes', () => {
  assert.equal(classifyExit(0), 'ok');
  for (const code of [11, 12, 13, 14]) assert.equal(classifyExit(code), 'violation');
  for (const code of [1, 10, 150, 255, null]) assert.equal(classifyExit(code), 'error');
});

test('reads both old and new Java version strings', () => {
  assert.equal(javaMajorVersion('java version "1.8.0_151"'), 8);
  assert.equal(javaMajorVersion('openjdk version "17.0.12" 2024-07-16'), 17);
  assert.equal(javaMajorVersion('openjdk version "26" 2026-03-17'), 26);
  assert.equal(javaMajorVersion('command not found'), undefined);
});

test('prefers JAVA_HOME over PATH', () => {
  assert.equal(javaCommand({}), 'java');
  assert.match(javaCommand({ JAVA_HOME: path.join('opt', 'jdk') }), /opt[\\/]jdk[\\/]bin[\\/]java(?:\.exe)?$/);
});

test('pins the official TLA+ tools release by version and digest', () => {
  assert.match(TLA_TOOLS.url, /^https:\/\/github\.com\/tlaplus\/tlaplus\/releases\/download\/v\d+\.\d+\.\d+\/tla2tools\.jar$/);
  assert.ok(TLA_TOOLS.url.includes(`/${TLA_TOOLS.version}/`));
  assert.match(TLA_TOOLS.sha256, /^[0-9a-f]{64}$/);
});

test('every model configuration states what TLC must find, and the model keeps both kinds', async () => {
  const configs = (await readdir(FORMAL_DIR)).filter((name) => name.endsWith('.cfg'));
  const expectations = await Promise.all(configs.map(async (name) => parseExpectation(await readFile(path.join(FORMAL_DIR, name), 'utf8'))));
  assert.ok(expectations.every(Boolean), 'start every .cfg with "\\* expect: ok" or "\\* expect: violation"');
  assert.ok(expectations.includes('ok') && expectations.includes('violation'));
});
