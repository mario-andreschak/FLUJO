'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const sourceRoot = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const fixtureBase = path.resolve(process.argv[3] || require('node:os').tmpdir());
if (process.platform !== 'win32') throw new Error('This native DACL control requires Windows');
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(name,...args) { return Reflect.apply(originalResolve,this,[name.startsWith('@/')?path.join(sourceRoot,'src',name.slice(2)):name,...args]); };
const ts = require(path.join(sourceRoot, 'node_modules/typescript'));
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { windowsPrivateAuthorityStamp } = require(path.join(sourceRoot, 'src/backend/services/security/windowsPrivateAuthority.ts'));
const { readPrivateApproval } = require(path.join(sourceRoot, 'src/backend/services/security/trustedHostMcp.ts'));
const directory = path.resolve(fs.mkdtempSync(path.join(fixtureBase, 'FLUJO-windows-authority-')));
const filename = path.join(directory, 'synthetic-owner.json');
process.env.FLUJO_DATA_DIR=path.join(directory,'data');
delete process.env.FLUJO_PARENT_DATA_DIR;
const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
function configure(mode) {
  const script = String.raw`
  $ErrorActionPreference='Stop'
  $request=[Console]::In.ReadToEnd()|ConvertFrom-Json
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($request.mode -eq 'private') {
    $acl=[IO.DirectoryInfo]::new([string]$request.directory).GetAccessControl()
    $acl.SetAccessRuleProtection($true,$false)
    foreach($existing in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($existing) }
    foreach ($principal in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
      $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($principal),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
    }
    [IO.DirectoryInfo]::new([string]$request.directory).SetAccessControl($acl)
  } else {
    $target=if($request.mode -eq 'foreign-parent'){[IO.DirectoryInfo]::new([string]$request.directory)}else{[IO.FileInfo]::new([string]$request.filename)}
    $acl=$target.GetAccessControl()
    $rights=if($request.mode -eq 'foreign-parent'){'Delete'}else{'ReadData'}
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),$rights,'Allow')
    $acl.AddAccessRule($rule)
    $target.SetAccessControl($acl)
  }`;
  const result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{
    input:JSON.stringify({directory,filename,mode}),encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:65536,
  });
  assert.equal(result.status,0,result.stderr);
}
try {
  fs.writeFileSync(filename,'{"ownerId":"synthetic-only"}',{mode:0o600});
  configure('foreign-file');
  assert.throws(()=>windowsPrivateAuthorityStamp(filename));
  assert.throws(()=>readPrivateApproval(filename));
  configure('private');
  fs.unlinkSync(filename);fs.writeFileSync(filename,'{"ownerId":"synthetic-only"}');
  const stamp=windowsPrivateAuthorityStamp(filename);
  assert.match(stamp,/^[a-f0-9]{64}$/);
  assert.equal(windowsPrivateAuthorityStamp(filename),stamp);
  assert.deepEqual(readPrivateApproval(filename),{ownerId:'synthetic-only'});
  configure('foreign-file');
  assert.throws(()=>windowsPrivateAuthorityStamp(filename));
  // Recreate only the owned file to restore inherited private fixture rules.
  fs.unlinkSync(filename);fs.writeFileSync(filename,'{"ownerId":"synthetic-only"}');
  assert.match(windowsPrivateAuthorityStamp(filename),/^[a-f0-9]{64}$/);
  configure('foreign-parent');
  assert.throws(()=>windowsPrivateAuthorityStamp(filename));
  configure('private');
  assert.match(windowsPrivateAuthorityStamp(filename),/^[a-f0-9]{64}$/);
  const originalRead=fs.readSync;
  let changed=false;
  fs.readSync=function(...args){const count=Reflect.apply(originalRead,fs,args);if(!changed&&count>0){changed=true;configure('foreign-file');}return count;};
  try{assert.throws(()=>readPrivateApproval(filename));assert.equal(changed,true);}finally{fs.readSync=originalRead;}
  console.log(JSON.stringify({sourceControl:'windows-private-authority',nativeSidDaclInspection:true,foreignReadableAclRefused:true,ownedPrivateAclAccepted:true,stableAclStamp:true,foreignReadDenied:true,parentRenameAuthorityDenied:true,actualPrivateReaderIntegrated:true,daclChangeDuringActualReadRefused:true,scope:'Source runtime reader; not installed artifact or whole suite qualification'}));
} finally {
  if(path.dirname(directory)!==fixtureBase||!/^FLUJO-windows-authority-[A-Za-z0-9]+$/.test(path.basename(directory))||fs.lstatSync(directory).isSymbolicLink())throw Error('Unsafe owned cleanup');
  fs.rmSync(directory,{recursive:true,force:true});
}
