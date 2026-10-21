import { X509Certificate } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ControllerConfig } from './config.js';
import { certificateCommand } from './certificate-command.js';
import { localExecutable } from './local-executable.js';
import { localTLSRoot } from './local-tls.js';
import { assertStableDirectory, createPrivateDirectory } from './private-storage.js';

const windowsProgram = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  $json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
  $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true))
  $request = $json.DeserializeObject($reader.ReadToEnd())
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) { throw 'Unelevated account required' }
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String([string]$request.der))
  $hash = [Security.Cryptography.SHA256]::Create()
  function Fingerprint($cert) { return [BitConverter]::ToString($hash.ComputeHash($cert.RawData)).Replace('-','') }
  if ($certificate.HasPrivateKey -or (Fingerprint $certificate) -ne [string]$request.fingerprint) { throw 'Public certificate mismatch' }
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root',[Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
  try {
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    if ($request.remove) {
      foreach ($item in @($store.Certificates)) { if ((Fingerprint $item) -eq [string]$request.fingerprint) { $store.Remove($item) } }
    } else { $store.Add($certificate) }
    $found = $false
    foreach ($item in $store.Certificates) { if ((Fingerprint $item) -eq [string]$request.fingerprint) { $found = $true } }
    if ($found -eq [bool]$request.remove) { throw 'Trust update unconfirmed' }
    [Console]::Out.Write('confirmed')
  } finally { $store.Close(); $hash.Dispose(); $certificate.Dispose() }
} catch { [Console]::Error.Write('Local certificate trust update failed.'); exit 1 }
`;

function nssDirectory(selected: string | undefined, create: boolean): string {
  const home = resolve(homedir());
  const legacy = join(home, '.pki', 'nssdb');
  // Chromium M146 changed its default, retaining an existing legacy database.
  const directory = resolve(selected ?? (existsSync(legacy) ? legacy : join(home, '.local', 'share', 'pki', 'nssdb')));
  const child = relative(home, directory);
  if ((selected && !isAbsolute(selected)) || !child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) {
    throw new Error('Select a certificate database inside the current user home.');
  }
  let current = home;
  assertStableDirectory(current);
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      if (!create) return directory;
      createPrivateDirectory(current);
    }
    assertStableDirectory(current);
  }
  // Do not ask NSS to load a redirected or externally writable user store.
  for (const name of readdirSync(directory)) {
    const stat = lstatSync(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) {
      throw new Error('Unsafe local certificate database.');
    }
  }
  return directory;
}

/** Explicit operator action: install/remove only this pinned public CA, never a
 * private key, system-wide root or unrelated trust entry. No online verification. */
export async function updateLocalTrust(config: ControllerConfig, remove = false, database?: string): Promise<string> {
  const root = localTLSRoot(config, remove);
  const fingerprint = root.certificate.fingerprint256.replaceAll(':', '');
  if (process.platform === 'win32') {
    if (database || !process.env.SystemRoot || !isAbsolute(process.env.SystemRoot)) throw new Error('Invalid local trust target.');
    const result = await certificateCommand(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsProgram, 'utf16le').toString('base64')],
      config.tls!.directory, JSON.stringify({ der: root.certificate.raw.toString('base64'), fingerprint, remove }));
    if (result.toString() !== 'confirmed') throw new Error('Local trust update is unconfirmed.');
    return 'Windows current-user Root store';
  }
  if (process.platform !== 'linux') throw new Error('Automatic local trust is supported on Windows and Linux; import the public CA with the native certificate manager.');
  const executable = localExecutable('certutil');
  const directory = nssDirectory(database, !remove);
  if (remove && !existsSync(directory)) return directory;
  const target = `sql:${directory}`;
  const nickname = `FLUJO-local-${fingerprint}`;
  const run = (args: string[]) => certificateCommand(executable, ['-d', target, ...args], config.tls!.directory);
  if (!existsSync(join(directory, 'cert9.db'))) {
    if (remove) return directory;
    if (readdirSync(directory).length) throw new Error('Existing certificate database requires local recovery.');
    await run(['-N', '--empty-password']);
  }
  const listed = (await run(['-L'])).toString();
  if (listed.split(/\r?\n/).some(line => line.trim().split(/\s+/)[0] === nickname)) {
    const installed = new X509Certificate(await run(['-L', '-n', nickname, '-a']));
    if (!installed.raw.equals(root.certificate.raw)) throw new Error('Local trust identity mismatch.');
    if (remove) await run(['-D', '-n', nickname]);
  } else if (remove) return directory;
  if (!remove) await run(['-A', '-t', 'C,,', '-n', nickname, '-i', root.caFile]);
  const after = (await run(['-L'])).toString().split(/\r?\n/).find(line => line.trim().split(/\s+/)[0] === nickname);
  if (remove ? !!after : !after || !after.trim().slice(nickname.length).trim().split(',')[0].includes('C')) {
    throw new Error('Local trust update is unconfirmed.');
  }
  if (!remove && !new X509Certificate(await run(['-L', '-n', nickname, '-a'])).raw.equals(root.certificate.raw)) {
    throw new Error('Local trust identity mismatch.');
  }
  return directory;
}
