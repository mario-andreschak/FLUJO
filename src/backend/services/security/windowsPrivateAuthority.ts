import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// Native PowerShell startup and fresh ancestor ACL reads can exceed five seconds on busy hosts.
const NATIVE_INSPECTION_TIMEOUT_MS = 30_000;

// Static program, no profiles/modules or input-selected commands. The filename
// travels as JSON on stdin and is only passed to native filesystem ACL APIs.
const inspect = String.raw`
$ErrorActionPreference = 'Stop'
$phase = 'input'
try {
# Avoid PowerShell utility-module autoload for JSON on every fresh inspection.
# Bind the system framework assembly by its complete strong name; no user path,
# profile, module, or request-selected assembly participates in resolution.
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
$json.MaxJsonLength = 65536
$json.RecursionLimit = 16
$request = $json.DeserializeObject([Console]::In.ReadToEnd())
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
  $phase = 'native-acl'
  $acl = $current.GetAccessControl()
  # Serialize this freshly read native descriptor once. The authorization and
  # evidence record must use the same snapshot, with no cross-request reuse.
  $binary = $acl.GetSecurityDescriptorBinaryForm()
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($binary, 0)
  $phase = 'owner-dacl'
  if ($null -eq $raw.DiscretionaryAcl -or $allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Unprotected authority' }
  $phase = 'outsider-access'
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
  $record = $current.FullName + ':' + [Convert]::ToBase64String($binary)
  $phase = 'evidence-bounds'
  if ($records.Count -ge 128 -or $record.Length -gt 8192) { throw 'Bounded authority evidence refused' }
  $records.Add($record)
  if ($file) { $current = $current.Directory } else { $current = $current.Parent }
  $file = $false
}
}
[Console]::Out.WriteLine($json.Serialize(@{schemaVersion=1; records=$records.ToArray()}))
} catch {
  [Console]::Error.WriteLine('FLUJO_AUTHORITY_REFUSED:' + $phase)
  exit 1
}
`;

function traceNativeRefusal(reason: 'spawn' | 'stdin' | 'deadline' | 'abort' | 'abort-before-spawn' | 'bounds' | 'exit' | 'evidence', stderr = '') {
  try {
    if (process.env.FLUJO_MCP_WORKLOAD_TRACE !== '1') return;
    console.info('[private-authority-native]', 'refused', nativePhase(stderr) ?? reason);
  } catch { /* Diagnostics cannot change authority disposition. */ }
}

function nativePhase(stderr: string) {
  return /^FLUJO_AUTHORITY_REFUSED:(input|native-acl|owner-dacl|outsider-access|evidence-bounds)\s*$/.exec(stderr)?.[1];
}

export type WindowsAuthorityFailure = 'unavailable' | 'cancelled' | 'deadline' | 'bounds' | 'spawn' | 'stdin' | 'exit' | 'evidence' | 'refused';

/**
 * Says why native inspection failed, without paths or ACL contents. A
 * `transient` failure (the helper could not start, lost its input, died early,
 * or could not read an ACL while a file was being replaced) may pass on a fresh
 * attempt. A policy refusal, cancellation, the deadline or the output bound is
 * never transient. Readers outside this module check the own `transient` field.
 */
export class WindowsAuthorityInspectionError extends Error {
  readonly transient: boolean;
  readonly code?: string;
  constructor(message: string, readonly nativeFailure: WindowsAuthorityFailure, cause?: unknown) {
    super(message);
    this.name = 'WindowsAuthorityInspectionError';
    this.transient = ['spawn', 'stdin', 'exit', 'evidence'].includes(nativeFailure);
    const descriptor = cause && typeof cause === 'object' ? Object.getOwnPropertyDescriptor(cause, 'code') : undefined;
    const code: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code)) this.code = code;
  }
}

/** A native phase that judged the ACL is a refusal; any other non-zero exit is the helper failing. */
function exitFailure(stderr: string): WindowsAuthorityInspectionError {
  const phase = nativePhase(stderr);
  return new WindowsAuthorityInspectionError('Windows authority inspection refused',
    phase === 'owner-dacl' || phase === 'outsider-access' || phase === 'evidence-bounds' ? 'refused' : 'exit');
}

function authorityEvidence(stdout: string): string {
  const malformed = () => new WindowsAuthorityInspectionError('Windows authority inspection refused', 'evidence');
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw malformed(); }
  const evidence = value as { schemaVersion?: unknown; records?: unknown };
  if (!evidence || evidence.schemaVersion !== 1 || !Array.isArray(evidence.records)
      || evidence.records.length < 2 || evidence.records.length > 128
      || evidence.records.some(item => typeof item !== 'string' || item.length > 8192)) throw malformed();
  return createHash('sha256').update(JSON.stringify(evidence.records)).digest('hex');
}

const STOP_MESSAGES = {
  spawn: 'Windows authority inspection could not start',
  stdin: 'Windows authority inspection lost its input',
  deadline: 'Windows authority inspection cancelled or exceeded bounds',
  abort: 'Windows authority inspection cancelled or exceeded bounds',
  bounds: 'Windows authority inspection cancelled or exceeded bounds',
} as const;

/**
 * DACL evidence supplements stable file identity; 0600 is not a Windows ACL.
 * Every call obtains fresh native ACL evidence; cancellation waits for exit.
 */
export async function windowsPrivateAuthorityStampAsync(filename: string | readonly string[], signal?: AbortSignal): Promise<string> {
  const unavailable = () => new WindowsAuthorityInspectionError('Windows authority inspection unavailable', 'unavailable');
  if (process.platform !== 'win32' || signal?.aborted) {
    if (process.platform === 'win32' && signal?.aborted) {
      traceNativeRefusal('abort-before-spawn');
      throw new WindowsAuthorityInspectionError('Windows authority inspection unavailable', 'cancelled');
    }
    throw unavailable();
  }
  const filenames = typeof filename === 'string' ? [filename] : filename;
  if (filenames.length < 1 || filenames.length > 4 || filenames.some(item => !path.isAbsolute(item) || item.length > 4096 || item.includes('\0'))) throw unavailable();
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw unavailable();
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!(await fs.promises.stat(executable)).isFile()) throw unavailable();
  if (signal?.aborted) { traceNativeRefusal('abort-before-spawn'); throw new WindowsAuthorityInspectionError('Windows authority inspection cancelled', 'cancelled'); }
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', inspect], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { NODE_ENV: 'production', SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, 'System32') },
      });
    } catch (error) {
      // Node throws instead of emitting 'error' for some process-creation
      // failures (for example ENOMEM or EPERM while the machine is under load).
      traceNativeRefusal('spawn');
      reject(new WindowsAuthorityInspectionError(STOP_MESSAGES.spawn, 'spawn', error));
      return;
    }
    let failure: Error | undefined;
    let bytes = 0;
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const stop = (reason: keyof typeof STOP_MESSAGES, cause?: unknown) => {
      traceNativeRefusal(reason);
      failure ??= new WindowsAuthorityInspectionError(STOP_MESSAGES[reason], reason === 'abort' ? 'cancelled' : reason, cause);
      child.kill();
    };
    const abort = () => stop('abort');
    const timer = setTimeout(() => stop('deadline'), NATIVE_INSPECTION_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => stop('spawn', error));
    child.stdin.on('error', error => stop('stdin', error));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { stop('bounds'); return; }
      if (stream === child.stdout) output.push(chunk);
      else errors.push(chunk);
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const stderr = Buffer.concat(errors).toString('utf8');
      try {
        if (failure) throw failure;
        if (signal?.aborted) throw new WindowsAuthorityInspectionError('Windows authority inspection cancelled', 'cancelled');
        if (code !== 0 || exitSignal) throw exitFailure(stderr);
        resolve(authorityEvidence(Buffer.concat(output).toString('utf8')));
      } catch (error) { traceNativeRefusal(code === 0 ? 'evidence' : 'exit', stderr); reject(error); }
      finally { for (const chunk of [...output, ...errors]) chunk.fill(0); }
    });
    const request = typeof filename === 'string' ? { filename: path.resolve(filename) } : { filenames: filename.map(item => path.resolve(item)) };
    child.stdin.end(JSON.stringify(request));
    if (signal?.aborted) abort();
  });
}
