'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const sourceRoot=path.resolve(process.argv[2]||path.join(__dirname,'../..')),ts=require(path.join(sourceRoot,'node_modules/typescript'));
const resolve=Module._resolveFilename;
Module._resolveFilename=function(name,...args){return resolve.call(this,name.startsWith('@/')?path.join(sourceRoot,'src',name.slice(2)):name,...args);};
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
const {closeAndRestoreFixture}=require('./owned-source-fixture-cleanup.cjs');
(async()=>{
 const {installTrustedHostProfile}=require(path.join(sourceRoot,'__tests__/mcp/fixtures/trustedHostProfile.ts'));
 const vars=['FLUJO_WORKER_MODE','FLUJO_SNAPSHOT_CONTROL_TOKEN','FLUJO_APP_ROOT','FLUJO_BASE_URL'];
 for(const simultaneousFailure of[false,true]){
  const saved=Object.fromEntries(vars.map(name=>[name,process.env[name]])),fixture=installTrustedHostProfile(),ownedPath=fixture.config.cwd,ownedOwner=process.env.FLUJO_OWNER_AUTH_FILE;
  const closeError=new Error('Forced close rejection'),primaryError=new Error('Primary Source failure'),restoreError=new Error('Forced environment callback rejection');let restored=false,restoreAttempted=false,secondaryError;
  const restoreEnvironment=()=>{for(const[name,value]of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}};
  const restoreFixture=()=>{if(!restoreAttempted){restoreAttempted=true;fixture.restore();restored=true;}};
  try{
  for(const name of vars)process.env[name]='synthetic-fault-value';
  await assert.rejects(closeAndRestoreFixture({close:async()=>{throw closeError;}},()=>{restoreEnvironment();if(simultaneousFailure)throw restoreError;},restoreFixture,simultaneousFailure?primaryError:undefined),error=>simultaneousFailure?error instanceof AggregateError&&error.cause===primaryError&&error.errors[0]===primaryError&&error.errors.includes(closeError)&&error.errors.includes(restoreError):error===closeError);
  assert.equal(restored,true);assert.equal(fs.existsSync(ownedPath),false);assert.equal(fs.existsSync(ownedOwner),false);for(const[name,value]of Object.entries(saved))assert.equal(process.env[name],value);
  }catch(error){secondaryError=error;throw error;}finally{await closeAndRestoreFixture(undefined,restoreEnvironment,restoreFixture,secondaryError);}
 }
 console.log(JSON.stringify({sourceControl:'owned-source-fixture-cleanup',forcedCloseFailurePreserved:true,workerTokenModeAppAudienceEnvironmentRestored:true,actualOwnedPrivateFixtureRemoved:true,simultaneousEnvironmentFailureDoesNotSkipFixtureRestore:true,primaryErrorPreservedAsAggregateCause:true,scope:'Actual Source owned-fixture cleanup with injected close failure; no SDK close-failure simulation or production authority claim'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
