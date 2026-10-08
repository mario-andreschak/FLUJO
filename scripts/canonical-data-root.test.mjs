import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCanonicalDataRoot } from './canonical-data-root.mjs';

test('producer establishes genuine native spelling and refuses an actual linked parent', async () => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(parent, 'flujo-canonical-data-'));
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
  } finally {
    assert.equal(path.dirname(fixture), parent);
    assert.match(path.basename(fixture), /^flujo-canonical-data-[A-Za-z0-9]+$/);
    assert.equal(fs.lstatSync(fixture).isSymbolicLink(), false);
    fs.rmSync(fixture, { recursive: true });
  }
});
