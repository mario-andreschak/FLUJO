import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

// Static native ACL traversal: only a path supplied as JSON is interpreted.
// This module never rewrites operator ACLs or starts the package runner.
const program = String.raw`
$ErrorActionPreference = 'Stop'
$inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ([string]$inputValue.root -eq '' -or ([string]$inputValue.root).Length -gt 2048) { throw 'Bounded root refused' }
$root = [IO.Path]::GetFullPath([string]$inputValue.root)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$allowed = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')
$records = [Collections.Generic.List[string]]::new()
$script:evidenceCharacters = 0
function Add-Evidence([string]$name, $acl) {
  if (-not $acl.AreAccessRulesCanonical) { throw 'Noncanonical ACL refused' }
  $securityBytes = $acl.GetSecurityDescriptorBinaryForm()
  if ($securityBytes.Length -gt 6144) { throw 'ACL evidence bound exceeded' }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($securityBytes,0)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'Unprotected raw ACL' }
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or
        ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -and
         $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessDenied)) { throw 'Unsupported raw ACL entry' }
  }
  $record = $name + ':' + [Convert]::ToBase64String($securityBytes)
  if ($record.Length -gt 8192 -or $records.Count -ge 32768 -or
      $script:evidenceCharacters + $record.Length -gt 4194304) { throw 'Native evidence bound exceeded' }
  $script:evidenceCharacters += $record.Length
  $records.Add($record)
}
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($root)
$count = 0
while ($pending.Count -gt 0) {
  $name = $pending.Pop()
  $item = Get-Item -LiteralPath $name -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked stage member' }
  $count++
  if ($count -gt 32768) { throw 'Stage member bound exceeded' }
  $acl = Get-Acl -LiteralPath $name
  if ($allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Foreign stage owner' }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'Unprotected stage ACL' }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    if ($allowed -notcontains $rule.IdentityReference.Value) { throw 'Foreign stage access' }
  }
  Add-Evidence $name $acl
  if ($item.PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $name -Force) {
      if ($pending.Count -ge 32768) { throw 'Native traversal bound exceeded' }
      $pending.Push($child.FullName)
    }
  }
}
# Ancestors may be shared for reading, never for replacing owned stage objects.
$parent = [IO.Directory]::GetParent($root)
while ($null -ne $parent) {
  $item = Get-Item -LiteralPath $parent.FullName -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked stage parent' }
  $acl = Get-Acl -LiteralPath $parent.FullName
  if ($allowed -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Foreign parent owner' }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'Unprotected parent ACL' }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -or
        $allowed -contains $rule.IdentityReference.Value) { continue }
    if (([long]$rule.FileSystemRights -band 0x100d0156L) -ne 0) { throw 'Foreign parent mutation authority' }
  }
  Add-Evidence $parent.FullName $acl
  $parent = $parent.Parent
}
$hash = [Security.Cryptography.SHA256]::Create()
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]::Join([char]10, ($records | Sort-Object)))
  $digest = [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
} finally { $hash.Dispose() }
[pscustomobject]@{schemaVersion=1;members=$count;sha256=$digest} | ConvertTo-Json -Compress
`;

export async function inspectPackageRunnerNativeStage(root: string, signal?: AbortSignal): Promise<string> {
  if (process.platform !== 'win32' || !path.isAbsolute(root) || root.length > 2048 || root.includes('\0')
      || !process.env.SystemRoot || !path.isAbsolute(process.env.SystemRoot)) {
    throw new Error('Native protected runner stage inspection unavailable');
  }
  signal?.throwIfAborted();
  const systemRoot = process.env.SystemRoot;
  const child = spawn(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', program], { windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: systemRoot, WINDIR: systemRoot,
        PATH: path.join(systemRoot, 'System32') } });
  let output = '';
  let outputBytes = 0;
  let combinedBytes = 0;
  let stdoutEnded = false;
  let stderrEnded = false;
  let failure: Error | undefined;
  const terminate = () => { failure ??= new Error('Native stage inspection cancelled or exceeded bound'); child.kill(); };
  const streamFailure = (error: Error) => { failure ??= error; child.kill(); };
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  const timeout = setTimeout(terminate, 5_000);
  signal?.addEventListener('abort', terminate, { once: true });
  child.on('error', streamFailure);
  child.stdin.on('error', streamFailure);
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length; combinedBytes += chunk.length;
    if (outputBytes > 4096 || combinedBytes > 64 * 1024) { terminate(); return; }
    output += chunk.toString('utf8');
  });
  child.stdout.on('end', () => { stdoutEnded = true; });
  child.stdout.on('error', streamFailure);
  child.stderr.on('data', (chunk: Buffer) => { combinedBytes += chunk.length; if (combinedBytes > 64 * 1024) terminate(); });
  child.stderr.on('end', () => { stderrEnded = true; });
  child.stderr.on('error', streamFailure);
  // Covers cancellation between the first check and listener installation.
  if (signal?.aborted) terminate();
  child.stdin.end(JSON.stringify({ root: path.resolve(root) }));
  try {
    const code = await closed;
    if (failure || signal?.aborted || code !== 0 || !stdoutEnded || !stderrEnded) {
      throw new Error('Native protected runner stage refused', { cause: failure });
    }
    const value = JSON.parse(output);
    if (value.schemaVersion !== 1 || !Number.isInteger(value.members) || value.members < 1 || value.members > 32768
        || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Invalid native stage evidence');
    return createHash('sha256').update(JSON.stringify([path.resolve(root), value.members, value.sha256])).digest('hex');
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', terminate); }
}
