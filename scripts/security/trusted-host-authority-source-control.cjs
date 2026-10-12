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
 const fixture=installTrustedHostProfile({environment:{SECRET:'synthetic-credential-a'}});
 const candidate=fixture.config.command;
 const retained=path.join(fixture.config.cwd,'retained-original');
 try{
  const first=policy.trustedHostMcpPolicyDigest(fixture.config);
  assert.equal(policy.trustedHostMcpPolicyDigest(fixture.config),first);
  assert.notEqual(policy.trustedHostMcpPolicyDigest({...fixture.config,env:{...fixture.config.env,SECRET:'synthetic-credential-b'}}),first);
  assert.equal(policy.trustedHostMcpApproval(fixture.config).digest,first);
  const originalOpen=fs.openSync,originalRead=fs.readSync;
  let targetFd,swapped=false,reads=0;
  fs.openSync=function(...args){const fd=Reflect.apply(originalOpen,fs,args);if(path.resolve(String(args[0]))===candidate&&!swapped){targetFd=fd;swapped=true;try{fs.renameSync(candidate,retained);fs.writeFileSync(candidate,'unapproved-replacement');}catch(error){fs.closeSync(fd);throw error;}}return fd;};
  fs.readSync=function(...args){if(args[0]===targetFd)reads++;return Reflect.apply(originalRead,fs,args);};
  try{assert.throws(()=>policy.fingerprintTrustedHostExecutable(candidate),e=>e.code==='HOST_SOURCE_CHANGED');assert.equal(swapped,true);assert.equal(reads,0);}
  finally{fs.openSync=originalOpen;fs.readSync=originalRead;if(fs.existsSync(retained)){fs.unlinkSync(candidate);fs.renameSync(retained,candidate);}}
  const originalAsyncOpen=fs.promises.open;
  swapped=false;reads=0;
  fs.promises.open=async function(...args){const handle=await Reflect.apply(originalAsyncOpen,fs.promises,args);if(path.resolve(String(args[0]))===candidate&&!swapped){swapped=true;const read=handle.read.bind(handle);handle.read=(...readArgs)=>{reads++;return read(...readArgs);};try{await fs.promises.rename(candidate,retained);await fs.promises.writeFile(candidate,'unapproved-async-replacement');}catch(error){await handle.close();throw error;}}return handle;};
  try{await assert.rejects(policy.verifyTrustedHostMcp(fixture.config),e=>e.code==='HOST_SOURCE_CHANGED');assert.equal(swapped,true);assert.equal(reads,0);}
  finally{fs.promises.open=originalAsyncOpen;if(fs.existsSync(retained)){fs.unlinkSync(candidate);fs.renameSync(retained,candidate);}}
  await policy.verifyTrustedHostMcp(fixture.config);
  console.log(JSON.stringify({sourceControl:'trusted-host-authority',actualPrivateGrantAccepted:true,credentialCommitmentStableAndSensitive:true,syncActualFdPathSwapRefusedBeforeRead:true,asyncActualFdPathSwapRefusedBeforeRead:true,restoredRevisionAccepted:true,scope:'Source transpilation, nonmatching local SDK graph; no scanner clearance, installed artifact or inspected code execution'}));
 }finally{fixture.restore();}
})().catch(error=>{console.error(error);process.exitCode=1;});
