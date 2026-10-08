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
 const ordinary=require(path.join(sourceRoot,'src/backend/services/mcp/connection.ts'));
 const beta=require(path.join(sourceRoot,'src/backend/services/mcp/betaClient.ts'));
 const policy=require(path.join(sourceRoot,'src/backend/services/security/trustedHostMcp.ts'));
 const workspace=require(path.join(sourceRoot,'src/utils/workspace.ts'));
 for(const era of ['v1','beta']) {
  const fixture=installTrustedHostProfile({name:'runtime-home-'+era,runtimeHome:'isolated',environment:{HOME:'approved-original-home'}});
  let transport;
  try {
   transport=era==='v1'?ordinary.createStdioTransport(fixture.config,{isolateRuntimeHome:true}):beta.createBetaTransport(fixture.config,{isolateRuntimeHome:true});
   const params=transport._serverParams;
   assert.notEqual(params.env.HOME,'approved-original-home');
   assert.equal(params.env.USERPROFILE,params.env.HOME);
   assert.equal(params.cwd,fixture.config.cwd);
   assert.equal(params.command,fixture.config.command);
   assert.equal(fs.statSync(params.env.HOME).isDirectory(),true);
   assert.throws(()=>ordinary.resolveStdioLaunch(fixture.config,{isolateRuntimeHome:false}),e=>e.code==='HOST_POLICY_INVALID');
   const runtimeContainer=path.join(workspace.getWorkspaceDataDir(),'userdata','mcp-runtime');
   const deniedConfig={...fixture.config,name:fixture.config.name+'-occupied'};
   fixture.approve(deniedConfig);
   const anchor=path.join(runtimeContainer,require('node:crypto').createHash('sha256').update(deniedConfig.name).digest('hex').slice(0,24));
   fs.writeFileSync(anchor,'occupied-synthetic-anchor');
   assert.throws(()=>ordinary.resolveStdioLaunch(deniedConfig,{isolateRuntimeHome:true}),e=>e.code==='UNSAFE_MCP_RUNTIME_DIRECTORY');
   assert.equal(fs.readFileSync(anchor,'utf8'),'occupied-synthetic-anchor');
   const oldDigest=policy.trustedHostMcpPolicyDigest(deniedConfig);
   assert.notEqual(policy.trustedHostMcpPolicyDigest({...deniedConfig,runtimeHomeMode:'host'}),oldDigest);
   console.log(JSON.stringify({sourceControl:'trusted-host-runtime-home',sdk:era,actualPrivateDirectoryAdmission:true,namedPrivateEnvironment:true,approvedSourceCwdRetained:true,unapprovedModeRefused:true,occupiedAnchorRefusedWithoutReplacement:true,modeBoundToConsent:true,scope:'Source transpilation, nonmatching local SDK graph; no installed artifact or server execution'}));
  } finally {if(transport)await transport.close();fixture.restore();}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
