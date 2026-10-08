import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// Static program, no profiles/modules or input-selected commands. The filename
// travels as JSON on stdin and is only passed to native filesystem ACL APIs.
const inspect = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$allowed = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$records = [Collections.Generic.List[string]]::new()
$filenames = if ($null -ne $request.filenames) { @($request.filenames) } else { @($request.filename) }
if ($filenames.Count -lt 1 -or $filenames.Count -gt 4) { throw 'Bounded authority input refused' }
foreach ($filename in $filenames) {
$target = [IO.FileInfo]::new([string]$filename)
$current = $target
$file = $true
while ($null -ne $current) {
  $acl = $current.GetAccessControl()
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl -or $allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Unprotected authority' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    if ($allowed -contains $rule.IdentityReference.Value) { continue }
    $mask = [long]$rule.FileSystemRights -band 0xffffffffL
    # A file must grant no outsider access. Ancestors must deny authority
    # replacement: changing DACL/owner, deleting children, or renaming themselves.
    $dangerous = 0x000c0040L
    if ($file -or $null -ne $current.Parent) { $dangerous = $dangerous -bor 0x00010000L }
    if ($file -or ($mask -band ($dangerous -bor 0x10000000L))) { throw 'Foreign authority access' }
  }
  $record = $current.FullName + ':' + [Convert]::ToBase64String($acl.GetSecurityDescriptorBinaryForm())
  if ($records.Count -ge 128 -or $record.Length -gt 8192) { throw 'Bounded authority evidence refused' }
  $records.Add($record)
  if ($file) { $current = $current.Directory } else { $current = $current.Parent }
  $file = $false
}
}
[pscustomobject]@{schemaVersion=1; records=$records.ToArray()} | ConvertTo-Json -Compress
`;

/** DACL evidence supplements stable file identity; 0600 is not a Windows ACL. */
export function windowsPrivateAuthorityStamp(filename: string | readonly string[]): string {
  if (process.platform !== 'win32') throw new Error('Windows authority inspection unavailable');
  const filenames = typeof filename === 'string' ? [filename] : filename;
  if (filenames.length < 1 || filenames.length > 4 || filenames.some(item => !path.isAbsolute(item) || item.length > 4096 || item.includes('\0'))) throw new Error('Windows authority inspection unavailable');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('Windows authority inspection unavailable');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.statSync(executable).isFile()) throw new Error('Windows authority inspection unavailable');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inspect], {
    input: JSON.stringify(typeof filename === 'string' ? { filename: path.resolve(filename) } : { filenames: filenames.map(item => path.resolve(item)) }), encoding: 'utf8',
    windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024,
    env: { NODE_ENV: 'production', SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, 'System32') },
  });
  if (result.error || result.status !== 0 || result.signal) throw new Error('Windows authority inspection refused');
  return authorityEvidence(result.stdout);
}

function authorityEvidence(stdout: string): string {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error('Windows authority inspection refused'); }
  const evidence = value as { schemaVersion?: unknown; records?: unknown };
  if (!evidence || evidence.schemaVersion !== 1 || !Array.isArray(evidence.records)
      || evidence.records.length < 2 || evidence.records.length > 128
      || evidence.records.some(item => typeof item !== 'string' || item.length > 8192)) throw new Error('Windows authority inspection refused');
  return createHash('sha256').update(JSON.stringify(evidence.records)).digest('hex');
}

/** Every call obtains fresh native ACL evidence; cancellation waits for exit. */
export async function windowsPrivateAuthorityStampAsync(filename: string | readonly string[], signal?: AbortSignal): Promise<string> {
  if (process.platform !== 'win32' || signal?.aborted) throw new Error('Windows authority inspection unavailable');
  const filenames = typeof filename === 'string' ? [filename] : filename;
  if (filenames.length < 1 || filenames.length > 4 || filenames.some(item => !path.isAbsolute(item) || item.length > 4096 || item.includes('\0'))) throw new Error('Windows authority inspection unavailable');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('Windows authority inspection unavailable');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!(await fs.promises.stat(executable)).isFile()) throw new Error('Windows authority inspection unavailable');
  if (signal?.aborted) throw new Error('Windows authority inspection cancelled');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inspect], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { NODE_ENV: 'production', SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, 'System32') },
    });
    let failure: Error | undefined;
    let bytes = 0;
    const output: Buffer[] = [];
    const stop = () => { failure ??= new Error('Windows authority inspection cancelled or exceeded bounds'); child.kill(); };
    const timer = setTimeout(stop, 5000);
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', error => { failure = error; stop(); });
    child.stdin.on('error', error => { failure = error; stop(); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { stop(); return; }
      if (stream === child.stdout) output.push(chunk);
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      try {
        if (failure || code !== 0 || exitSignal || signal?.aborted) throw failure ?? new Error('Windows authority inspection refused');
        resolve(authorityEvidence(Buffer.concat(output).toString('utf8')));
      } catch (error) { reject(error); }
      finally { for (const chunk of output) chunk.fill(0); }
    });
    const request = typeof filename === 'string' ? { filename: path.resolve(filename) } : { filenames: filename.map(item => path.resolve(item)) };
    child.stdin.end(JSON.stringify(request));
    if (signal?.aborted) stop();
  });
}
