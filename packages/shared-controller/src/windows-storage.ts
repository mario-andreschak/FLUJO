import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

// Standalone controller boundary: adapt the native owner/ancestor checks used by
// Security without loading its runtime, keyring, workspace or execution modules.
// All input is JSON data on stdin. No profile, module, shell interpolation or
// input-selected command participates in native ACL inspection.
const program = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  $json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
  $json.MaxJsonLength = 16384
  $json.RecursionLimit = 8
  $inputReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false,$true))
  $request = $json.DeserializeObject($inputReader.ReadToEnd())
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) { throw 'Use an unelevated controller account' }
  $sid = $identity.User
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $filename = [string]$request.filename
  if ($filename -notmatch '^[A-Za-z]:\\' -or $filename.Length -gt 4096) { throw 'Local absolute path required' }
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($filename))
  if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -notin @('NTFS','ReFS')) { throw 'Local ACL filesystem required' }
  $directory = [bool]$request.directory
  $privateLeaf = [bool]$request.privateLeaf
  $protect = [bool]$request.protect
  if ($protect -and (-not $directory -or -not $privateLeaf)) { throw 'Invalid protection operation' }
  $target = if ($directory) { [IO.DirectoryInfo]::new($filename) } else { [IO.FileInfo]::new($filename) }

  function Check-Tree([bool]$unprotectedLeaf) {
    $current = $target
    $leaf = $true
    $count = 0
    while ($null -ne $current) {
      $current.Refresh()
      if (-not $current.Exists -or (++$count -gt 128) -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe path' }
      $acl = $current.GetAccessControl()
      $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
      $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      if ($null -eq $raw.DiscretionaryAcl -or $trusted -notcontains $owner) { throw 'Unprotected owner or DACL' }
      if ($leaf -and $privateLeaf -and $owner -ne $sid.Value) { throw 'Controller account must own storage' }
      foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $trusted -contains $rule.IdentityReference.Value) { continue }
        if ($leaf -and $unprotectedLeaf) { continue }
        # Private directories must also protect inherited child files (SQLite
        # journals, credentials, temporary config). Do not ignore InheritOnly here.
        if ($leaf -and $privateLeaf) { throw 'Foreign private storage access' }
        if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        $mask = [long]$rule.FileSystemRights -band 0xffffffffL
        $dangerous = 0x000c0040L -bor 0x10000000L
        if ($leaf -or $null -ne $current.Parent) { $dangerous = $dangerous -bor 0x00010000L }
        if ($mask -band $dangerous) { throw 'Replaceable ancestor' }
      }
      if ($leaf -and -not $directory) { $current = $current.Directory } else { $current = $current.Parent }
      $leaf = $false
    }
  }
  Check-Tree $protect
  if ($protect) {
    $acl = $target.GetAccessControl()
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($rule in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($rule) }
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    $target.SetAccessControl($acl)
    Check-Tree $false
  }
  [Console]::Out.Write('private')
} catch { [Console]::Error.Write('Windows controller storage refused.'); exit 1 }
`;

export function windowsStorage(filename: string, options: { directory: boolean; privateLeaf: boolean; protect?: boolean }): void {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== 'win32' || !systemRoot || !isAbsolute(systemRoot)
      || !/^[A-Za-z]:\\/.test(filename) || filename.length > 4096 || filename.includes('\0')
      || filename.slice(2).includes(':')) throw new Error('Windows controller storage refused.');
  const result = spawnSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
      input: JSON.stringify({ filename, ...options }), encoding: 'utf8', windowsHide: true,
      timeout: 30_000, maxBuffer: 4096,
      env: { NODE_ENV: 'production', SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32') },
    });
  if (result.error || result.status !== 0 || result.signal || result.stdout !== 'private') {
    throw new Error('Windows controller storage refused.');
  }
}
