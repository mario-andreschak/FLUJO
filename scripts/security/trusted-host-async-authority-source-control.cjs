'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const sourceRoot = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const ts = require(path.join(sourceRoot, 'node_modules/typescript'));
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
  // This Source-only CJS transpilation selects the package's documented import
  // entry for its ESM-only exports. It does not modify the installed package.
  if (name === 'mcp-stdio-oauth' || name.startsWith('mcp-stdio-oauth/')) {
    const packageRoot = path.join(sourceRoot, 'node_modules/mcp-stdio-oauth');
    const spec = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const key = name === 'mcp-stdio-oauth' ? '.' : `./${name.slice('mcp-stdio-oauth/'.length)}`;
    return resolve.call(this, path.join(packageRoot, spec.exports[key].import), ...args);
  }
  return resolve.call(this, name.startsWith('@/') ? path.join(sourceRoot, 'src', name.slice(2)) : name, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
(async()=>{
 const {installTrustedHostProfile}=require(path.join(sourceRoot,'__tests__/mcp/fixtures/trustedHostProfile.ts'));
 const policy=require(path.join(sourceRoot,'src/backend/services/security/trustedHostMcp.ts'));
 const fixture=installTrustedHostProfile();
 try{
  const expected=policy.trustedHostMcpPolicyDigest(fixture.config);
  assert.equal(await policy.trustedHostMcpPolicyDigestAsync(fixture.config),expected);
  let maxDelay=0,count=0,last=performance.now();
  const timer=setInterval(()=>{const now=performance.now();maxDelay=Math.max(maxDelay,now-last);last=now;count++;},10);
  const start=performance.now();let authority;
  try{authority=await policy.verifyTrustedHostMcp(fixture.config);}finally{clearInterval(timer);}
  assert.equal(authority.digest,expected);assert.ok(count>0);
  const duration=performance.now()-start;
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(policy.verifyTrustedHostMcp(fixture.config,cancelled.signal),e=>e.code==='HOST_CONSENT_REQUIRED');
  const during=new AbortController();const cancelStart=performance.now();const cancelTimer=setTimeout(()=>during.abort(),30);
  try{await assert.rejects(policy.verifyTrustedHostMcp(fixture.config,during.signal),e=>e.code==='HOST_CONSENT_REQUIRED');}finally{clearTimeout(cancelTimer);}
  const cancellationMs=performance.now()-cancelStart;
  const filename=process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
  const originalRead=fs.readSync;let mutated=false;
  fs.readSync=function(...args){const read=Reflect.apply(originalRead,fs,args);if(read>0&&!mutated){mutated=true;fs.writeFileSync(filename,'{"schemaVersion":999}',{mode:0o600});}return read;};
  try{await assert.rejects(policy.readPrivateApprovalAsync(filename));assert.equal(mutated,true);}finally{fs.readSync=originalRead;fixture.approve();}
  let nativeAclChangeRefused;
  if(process.platform==='win32'){
   const nativeScript=String.raw`$ErrorActionPreference='Stop'; $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; $f=[IO.FileInfo]::new([string]$r.filename); $acl=$f.GetAccessControl(); if($r.action -eq 'foreign'){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow));$f.SetAccessControl($acl)} elseif($r.action -eq 'restore'){$acl.SetSecurityDescriptorSddlForm([string]$r.sddl,[Security.AccessControl.AccessControlSections]::Access);$f.SetAccessControl($acl)} else {$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)}`;
   const run=(action,sddl)=>{const result=require('node:child_process').spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',nativeScript],{input:JSON.stringify({filename,action,sddl}),encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:65536});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
   const sddl=run('capture');mutated=false;
   fs.readSync=function(...args){const read=Reflect.apply(originalRead,fs,args);if(read>0&&!mutated){mutated=true;run('foreign');}return read;};
   try{await assert.rejects(policy.readPrivateApprovalAsync(filename));assert.equal(mutated,true);nativeAclChangeRefused=true;}finally{fs.readSync=originalRead;run('restore',sddl);}
  }
  await policy.verifyTrustedHostMcp(fixture.config);
  let exclusiveParentAclDriftRefused;
  if(process.platform==='win32'){
   const windows=require(path.join(sourceRoot,'src/backend/services/security/windowsPrivateAuthority.ts'));
   const originalStamp=windows.windowsPrivateAuthorityStampAsync;
   const previousApproval=process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
   const parent=path.join(path.dirname(previousApproval),'exclusive-approval-parent');fs.mkdirSync(parent,{mode:0o700});
   const exclusiveApproval=path.join(parent,'grant.json');process.env.FLUJO_MCP_TRUSTED_HOST_FILE=exclusiveApproval;fixture.approve();
   const nativeScript=String.raw`$ErrorActionPreference='Stop';$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;$d=[IO.DirectoryInfo]::new([string]$r.parent);if($r.action -eq 'capture'){$f=[IO.FileInfo]::new([string]$r.child);$fa=$f.GetAccessControl();$fa.SetAccessRuleProtection($true,$true);$f.SetAccessControl($fa)};$acl=$d.GetAccessControl();if($r.action -eq 'foreign'){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,[Security.AccessControl.AccessControlType]::Allow));$d.SetAccessControl($acl)}elseif($r.action -eq 'restore'){$acl.SetSecurityDescriptorSddlForm([string]$r.sddl,[Security.AccessControl.AccessControlSections]::Access);$d.SetAccessControl($acl)}else{$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)}`;
   const run=(action,sddl)=>{const result=require('node:child_process').spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',nativeScript],{input:JSON.stringify({parent,child:exclusiveApproval,action,sddl}),encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:65536});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
   const sddl=run('capture');let approvalCalls=0,ownerCalls=0,release,approvalDone;
   const barrier=new Promise(resolve=>{release=resolve;});const checked=new Promise(resolve=>{approvalDone=resolve;});
   windows.windowsPrivateAuthorityStampAsync=async function(target,signal){const stamp=await originalStamp(target,signal);if(target===exclusiveApproval&&++approvalCalls===2)approvalDone();if(target===process.env.FLUJO_OWNER_AUTH_FILE&&++ownerCalls===2)await barrier;return stamp;};
   let pending;
   try{
    pending=policy.trustedHostMcpApprovalAsync(fixture.config);
    await Promise.race([checked,pending.then(()=>{throw new Error('Approval completed before exclusive-parent barrier');})]);
    const before=fs.lstatSync(exclusiveApproval,{bigint:true});run('foreign');const after=fs.lstatSync(exclusiveApproval,{bigint:true});
    for(const key of ['dev','ino','size','mtimeNs','ctimeNs','mode'])assert.equal(after[key],before[key]);
    release();await assert.rejects(pending,e=>e.code==='HOST_CONSENT_REQUIRED');exclusiveParentAclDriftRefused=true;
   }finally{release();if(pending)await pending.catch(()=>{});windows.windowsPrivateAuthorityStampAsync=originalStamp;run('restore',sddl);process.env.FLUJO_MCP_TRUSTED_HOST_FILE=previousApproval;fixture.approve();}
  }
  const originalOpen=fs.openSync,ownerFilename=process.env.FLUJO_OWNER_AUTH_FILE,grantBytes=fs.readFileSync(filename);
  let ownerFd,crossReaderChanged=false;
  fs.openSync=function(...args){const fd=Reflect.apply(originalOpen,fs,args);if(path.resolve(String(args[0]))===path.resolve(ownerFilename))ownerFd=fd;return fd;};
  fs.readSync=function(...args){const read=Reflect.apply(originalRead,fs,args);if(read>0&&args[0]===ownerFd&&!crossReaderChanged){crossReaderChanged=true;fs.writeFileSync(filename,grantBytes,{mode:0o600});}return read;};
  try{await assert.rejects(policy.trustedHostMcpApprovalAsync(fixture.config),e=>e.code==='HOST_CONSENT_REQUIRED');assert.equal(crossReaderChanged,true);}finally{fs.openSync=originalOpen;fs.readSync=originalRead;grantBytes.fill(0);fixture.approve();}
  await policy.verifyTrustedHostMcp(fixture.config);
  console.log(JSON.stringify({sourceControl:'trusted-host-async-authority',matchingScryptCommitment:true,actualPrivateGrantAccepted:true,eventLoopTicks:count,maximumHeartbeatIntervalMs:maxDelay,verificationMs:duration,cancellationMs,preCancelledRefused:true,duringCheckCancelledRefused:true,actualPrivateReadMutationRefused:true,nativeAclChangeRefused,exclusiveParentAclDriftRefused,crossReaderGrantRewriteRefused:crossReaderChanged,restoredGrantAccepted:true,scope:'Source transpilation/nonmatching SDK graph; no installed qualification or maximum-load latency claim'}));
 }finally{fixture.restore();}
})().catch(error=>{console.error(error);process.exitCode=1;});
