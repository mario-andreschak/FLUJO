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
 const host=require(path.join(sourceRoot,'src/backend/services/mcp/trustedHost.ts'));
 const binding=require(path.join(sourceRoot,'src/backend/services/mcp/goalEnduranceFixtureEnvironment.ts'));
 const tokenName=binding.GOAL_ENDURANCE_FIXTURE_TOKEN_ENV;
 const vars=['PERSONA_GOAL_ENDURANCE_PROFILE','PERSONA_GOAL_ENDURANCE_FIXTURE_URL','PERSONA_GOAL_ENDURANCE_AGENT_ROOT','PERSONA_GOAL_ENDURANCE_RUN_ID',binding.FIXTURE_ENTRY_ENV,binding.FIXTURE_SOURCE_DIGEST_ENV,tokenName];
 const saved=Object.fromEntries(vars.map(name=>[name,process.env[name]]));
 const fixture=installTrustedHostProfile({name:'goal-endurance',nodeSource:'// Fingerprinted synthetic fixture; not executed.',args:['http://127.0.0.1:1','synthetic-agent-root','synthetic-run'],environmentNames:[tokenName]});
 try{
  Object.assign(fixture.config,{rootPath:process.cwd(),source:{type:'local'}});
  Object.assign(process.env,{PERSONA_GOAL_ENDURANCE_PROFILE:'structured-tools',PERSONA_GOAL_ENDURANCE_FIXTURE_URL:'http://127.0.0.1:1',PERSONA_GOAL_ENDURANCE_AGENT_ROOT:'synthetic-agent-root',PERSONA_GOAL_ENDURANCE_RUN_ID:'synthetic-run',[binding.FIXTURE_ENTRY_ENV]:fixture.config.trustedHost.entryPoint,[binding.FIXTURE_SOURCE_DIGEST_ENV]:fixture.config.trustedHost.sourceDigest,[tokenName]:'synthetic-runtime-only-token'});
  fixture.approve();
  assert.equal(host.resolveTrustedHostLaunch(fixture.config).env[tokenName],'synthetic-runtime-only-token');
  for(const key of [tokenName,tokenName.toLowerCase(),'FLUJO_SNAPSHOT_CONTROL_TOKEN','flujo_snapshot_control_token']){
   const forged={...fixture.config,env:{...fixture.config.env,[key]:'synthetic-persisted-forgery'},trustedHost:{...fixture.config.trustedHost,environmentNames:[...fixture.config.trustedHost.environmentNames.filter(name=>name.toUpperCase()!==key.toUpperCase()),key]}};
   fixture.approve(forged);
   assert.throws(()=>host.resolveTrustedHostLaunch(forged),e=>e.code==='HOST_POLICY_INVALID');
  }
  fixture.approve();
  for(const key of [binding.FIXTURE_ENTRY_ENV,binding.FIXTURE_SOURCE_DIGEST_ENV,'PERSONA_GOAL_ENDURANCE_RUN_ID']){
   const previous=process.env[key];process.env[key]='unmatched-runner-binding';
   assert.equal(host.resolveTrustedHostLaunch(fixture.config).env[tokenName],undefined);process.env[key]=previous;
  }
  const undeclared={...fixture.config,trustedHost:{...fixture.config.trustedHost,environmentNames:fixture.config.trustedHost.environmentNames.filter(name=>name!==tokenName)}};
  fixture.approve(undeclared);assert.throws(()=>host.resolveTrustedHostLaunch(undeclared),e=>e.code==='HOST_POLICY_INVALID');fixture.approve();
  const start=performance.now();let heartbeatDelay;
  const heartbeat=new Promise(resolve=>setImmediate(()=>{heartbeatDelay=performance.now()-start;resolve();}));
  const times=[];for(let i=0;i<5;i++){const before=performance.now();policy.trustedHostMcpPolicyDigest(fixture.config);times.push(performance.now()-before);}
  await heartbeat;
  const before=performance.now();host.resolveTrustedHostLaunch(fixture.config);const launchAdmissionMs=performance.now()-before;
  console.log(JSON.stringify({sourceControl:'trusted-host-runtime-token',actualPrivateGrantAccepted:true,stagedRunnerTokenOnly:true,persistedTokenCaseVariantsRefused:true,entryRevisionAudienceDriftWithheld:true,undeclaredRuntimeNameRefused:true,digestMs:times,eventLoopDelayMs:heartbeatDelay,launchAdmissionMs,scope:'Source transpilation/nonmatching SDK graph; no fixture execution, installed qualification, worker provenance or cancellation claim'}));
 }finally{for(const[name,value]of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}fixture.restore();}
})().catch(error=>{console.error(error);process.exitCode=1;});
