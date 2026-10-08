import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCanonicalDataRoot } from './canonical-data-root.mjs';

const sameDirectory = (expected, actual) => actual.isDirectory() && !actual.isSymbolicLink()
  && ['dev', 'ino', 'birthtimeNs'].every(field => expected[field] === actual[field]);
function removeOwnedFixture(fixture, parent, identity, parentIdentity) {
  assert.equal(path.dirname(fixture), parent);
  assert.match(path.basename(fixture), /^flujo-canonical-data-[A-Za-z0-9]+$/);
  assert.equal(fs.realpathSync.native(parent), parent);
  assert.equal(sameDirectory(parentIdentity, fs.lstatSync(parent, { bigint: true })), true, 'Fixture parent identity changed');
  assert.equal(sameDirectory(identity, fs.lstatSync(fixture, { bigint: true })), true, 'Fixture root identity changed');
  fs.rmSync(fixture, { recursive: true });
}

test('producer establishes genuine native spelling and refuses an actual linked parent', async () => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const parentIdentity = fs.lstatSync(parent, { bigint: true });
  const fixture = fs.mkdtempSync(path.join(parent, 'flujo-canonical-data-'));
  const identity = fs.lstatSync(fixture, { bigint: true });
  let primaryError;
  try {
    let input = fixture;
    if (process.platform === 'win32') {
      const program = String.raw`
        $ErrorActionPreference = 'Stop'
        Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class NativeShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder result, uint length); }'
        $filename = [Console]::In.ReadToEnd() | ConvertFrom-Json
        $buffer = [Text.StringBuilder]::new(32768)
        $length = [NativeShortPath]::GetShortPathName($filename, $buffer, 32768)
        if ($length -eq 0 -or $length -ge 32768) { throw 'Native short-path inspection failed' }
        $buffer.ToString() | ConvertTo-Json -Compress
      `;
      const inspected = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', program], {
          input: JSON.stringify(fixture), encoding: 'utf8', windowsHide: true, timeout: 10_000,
        });
      assert.equal(inspected.status, 0);
      input = JSON.parse(inspected.stdout.trim());
      // Do not silently claim alias coverage on a volume without 8.3 names.
      assert.match(input, /~[0-9]/);
    }
    const requested = path.join(input, 'data');
    const canonical = prepareCanonicalDataRoot(requested);
    assert.equal(canonical, fs.realpathSync.native(requested));
    assert.equal(canonical, await fs.promises.realpath(requested));
    assert.equal(fs.statSync(requested, { bigint: true }).ino, fs.statSync(canonical, { bigint: true }).ino);
    if (process.platform === 'win32') assert.notEqual(canonical.toLowerCase(), requested.toLowerCase());
    const target = path.join(fixture, 'target'), linked = path.join(fixture, 'linked-parent');
    fs.mkdirSync(target);
    fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => prepareCanonicalDataRoot(path.join(linked, 'unexpected-data')), /Linked data root refused/);
    assert.equal(fs.existsSync(path.join(target, 'unexpected-data')), false);
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { removeOwnedFixture(fixture, parent, identity, parentIdentity); }
    catch (cleanup) { if (primaryError) throw new AggregateError([primaryError, cleanup], 'Fixture failed and owned cleanup was refused.', { cause: primaryError }); throw cleanup; }
  }
});

test('owned cleanup refuses a genuine replacement directory and preserves its sentinel', () => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const parentIdentity = fs.lstatSync(parent, { bigint: true });
  const fixture = fs.mkdtempSync(path.join(parent, 'flujo-canonical-data-'));
  const identity = fs.lstatSync(fixture, { bigint: true });
  const held = `${fixture}.held`, preserved = `${fixture}.preserved`;
  let primaryError;
  try {
    assert.equal(path.dirname(held), parent); assert.equal(path.dirname(preserved), parent);
    assert.equal(fs.existsSync(held), false); assert.equal(fs.existsSync(preserved), false);
    assert.equal(sameDirectory(identity, fs.lstatSync(fixture, { bigint: true })), true);
    fs.renameSync(fixture, held);
    fs.mkdirSync(fixture);
    const replacement = fs.lstatSync(fixture, { bigint: true });
    const sentinel = path.join(fixture, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'preserve replacement');
    assert.throws(() => removeOwnedFixture(fixture, parent, identity, parentIdentity), /Fixture root identity changed/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve replacement');
    fs.renameSync(fixture, preserved);
    fs.renameSync(held, fixture);
    // Only after proving preservation, dispose of the test's exact sentinel
    // and empty replacement non-recursively under its separate captured proof.
    assert.equal(sameDirectory(replacement, fs.lstatSync(preserved, { bigint: true })), true);
    assert.equal(sameDirectory(parentIdentity, fs.lstatSync(parent, { bigint: true })), true);
    assert.equal(fs.readFileSync(path.join(preserved, 'sentinel.txt'), 'utf8'), 'preserve replacement');
    fs.unlinkSync(path.join(preserved, 'sentinel.txt')); fs.rmdirSync(preserved);
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { removeOwnedFixture(fixture, parent, identity, parentIdentity); }
    catch (cleanup) { if (primaryError) throw new AggregateError([primaryError, cleanup], 'Replacement control failed and owned cleanup was refused.', { cause: primaryError }); throw cleanup; }
  }
});
