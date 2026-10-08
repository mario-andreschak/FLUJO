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
 const graph=require(path.join(sourceRoot,'src/backend/services/security/bundledMcpDependencyGraph.ts'));
 const copied=require(path.join(sourceRoot,'src/backend/services/mcp/shippedWorkspacePackages.ts'));
 const parent=path.resolve(process.platform==='win32'?process.env.LOCALAPPDATA:require('node:os').tmpdir());
 const owned=fs.mkdtempSync(path.join(parent,'flujo-bundle-inspection-'));
 const app=path.join(owned,'installation'),workspace=path.join(owned,'workspace');
 fs.mkdirSync(workspace,{recursive:true});
 const a=path.join(app,'node_modules/synthetic-a'),b=path.join(app,'node_modules/synthetic-b');
 for(const directory of[a,b,path.join(app,'mcp-servers/filesystem/dist')])fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(a,'package.json'),JSON.stringify({name:'synthetic-a',version:'1',dependencies:{'synthetic-b':'1'}}));
 fs.writeFileSync(path.join(b,'package.json'),JSON.stringify({name:'synthetic-b',version:'1',dependencies:{'synthetic-a':'1'}}));
 fs.writeFileSync(path.join(a,'index.js'),'throw new Error("Inspected code must never run");');
 fs.writeFileSync(path.join(b,'index.js'),'throw new Error("Dependency code must never run");');
 fs.writeFileSync(path.join(app,'mcp-servers/filesystem/package.json'),JSON.stringify({name:'@mario.andreschak/mcp-filesystem',version:'synthetic-inspection-only',dependencies:{'synthetic-a':'1'}}));
 fs.writeFileSync(path.join(app,'mcp-servers/filesystem/dist/index.js'),'throw new Error("Package code must never run");');
 try{
  await copied.ensureShippedWorkspacePackages(workspace,app,['filesystem']);
  const initial=await copied.inspectShippedWorkspaceProvenance(workspace,'filesystem',app);
  assert.equal(initial.dependencyGraph.packages.length,2);assert.equal(initial.dependencyGraph.edges.length,2);assert.equal(initial.dependencyLinks.length,1);
  assert.equal((await copied.inspectShippedWorkspaceProvenance(workspace,'filesystem',app)).dependencyGraph.digest,initial.dependencyGraph.digest);
  const originalOpen=fs.promises.open,originalA=fs.readFileSync(path.join(a,'index.js'));let changedDuringRead=false;
  fs.promises.open=async function(...args){const handle=await Reflect.apply(originalOpen,fs.promises,args);if(path.resolve(String(args[0]))===path.join(b,'index.js')&&!changedDuringRead){changedDuringRead=true;fs.appendFileSync(path.join(a,'index.js'),'\n// concurrent earlier-package change');}return handle;};
  try{await assert.rejects(graph.inspectBundledMcpDependencyGraph(app,[a]));assert.equal(changedDuringRead,true);}finally{fs.promises.open=originalOpen;fs.writeFileSync(path.join(a,'index.js'),originalA);originalA.fill(0);}
  const manifestFile=path.join(a,'package.json'),originalManifest=fs.readFileSync(manifestFile);let manifestChanged=false;
  fs.promises.open=async function(...args){const handle=await Reflect.apply(originalOpen,fs.promises,args);if(path.resolve(String(args[0]))===path.join(a,'index.js')&&!manifestChanged){manifestChanged=true;fs.writeFileSync(manifestFile,JSON.stringify({name:'synthetic-a',version:'1',dependencies:{'injected-dependency':'1'}}));}return handle;};
  try{await assert.rejects(graph.inspectBundledMcpDependencyGraph(app,[a]));assert.equal(manifestChanged,true);}finally{fs.promises.open=originalOpen;fs.writeFileSync(manifestFile,originalManifest);originalManifest.fill(0);}
  fs.appendFileSync(path.join(b,'index.js'),'\n// changed revision');
  assert.notEqual((await copied.inspectShippedWorkspaceProvenance(workspace,'filesystem',app)).dependencyGraph.digest,initial.dependencyGraph.digest);
  const link=path.join(workspace,'mcp-servers/filesystem/node_modules');fs.unlinkSync(link);fs.symlinkSync(b,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(copied.inspectShippedWorkspaceProvenance(workspace,'filesystem',app));
  fs.unlinkSync(link);fs.symlinkSync(path.join(app,'node_modules'),link,process.platform==='win32'?'junction':'dir');
  const foreign=path.join(owned,'foreign-package');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'package.json'),'{}');
  await assert.rejects(graph.inspectBundledMcpDependencyGraph(app,[foreign]));
  const hardlink=path.join(a,'hardlink.js');fs.linkSync(path.join(a,'index.js'),hardlink);await assert.rejects(graph.inspectBundledMcpDependencyGraph(app,[a]));fs.unlinkSync(hardlink);
  const large=path.join(a,'large-hash-only.bin');fs.writeFileSync(large,Buffer.alloc(8*1024*1024));
  const rssBefore=process.memoryUsage().rss;await graph.inspectBundledMcpDependencyGraph(app,[a]);const rssAfter=process.memoryUsage().rss;
  for(const operation of['rewrite','grow']){
   let changed=false;
   fs.promises.open=async function(...args){const handle=await Reflect.apply(originalOpen,fs.promises,args);if(path.resolve(String(args[0]))===large){const heldRead=handle.read.bind(handle);handle.read=async function(...readArgs){const result=await heldRead(...readArgs);if(result.bytesRead&&!changed){changed=true;if(operation==='grow')fs.appendFileSync(large,'growth');else{const fd=fs.openSync(large,'r+');try{fs.writeSync(fd,Buffer.from('changed'),0,7,0);}finally{fs.closeSync(fd);}}}return result;};}return handle;};
   try{await assert.rejects(graph.inspectBundledMcpDependencyGraph(app,[a]));assert.equal(changed,true);}finally{fs.promises.open=originalOpen;fs.unlinkSync(large);fs.writeFileSync(large,Buffer.alloc(8*1024*1024));}
  }
  fs.truncateSync(large,257*1024*1024);await assert.rejects(graph.inspectBundledMcpDependencyGraph(app,[a]),/byte bound/);fs.unlinkSync(large);
  console.log(JSON.stringify({sourceControl:'bounded-streaming-dependency-inspection',actualEightMiBFileInspected:true,actualHeldReadRewriteRefused:true,actualHeldReadSizeGrowthRefused:true,actualSparseFileOverGlobalByteBoundRefused:true,rssBefore,rssAfter,scope:'Actual Source inspection mechanics; observed RSS only, no general peak-memory or installed acceptance claim'}));
  const flatNamespace=path.join(owned,'installed/node_modules'),flatApp=path.join(flatNamespace,'flujo-ai'),flatWorkspace=path.join(owned,'flat-workspace');
  fs.mkdirSync(flatApp,{recursive:true});fs.mkdirSync(flatWorkspace);fs.writeFileSync(path.join(flatApp,'package.json'),JSON.stringify({name:'flujo-ai'}));
  fs.cpSync(path.join(app,'mcp-servers'),path.join(flatApp,'mcp-servers'),{recursive:true});
  fs.cpSync(a,path.join(flatNamespace,'synthetic-a'),{recursive:true});fs.cpSync(b,path.join(flatNamespace,'synthetic-b'),{recursive:true});
  await copied.ensureShippedWorkspacePackages(flatWorkspace,flatApp,['filesystem']);
  const flattened=await copied.inspectShippedWorkspaceProvenance(flatWorkspace,'filesystem',flatApp);
  assert.equal(flattened.installation,fs.realpathSync(flatApp));assert.equal(flattened.dependencyNamespaceRoot,fs.realpathSync(flatNamespace));assert.equal(flattened.dependencyGraph.packages.length,2);
  fs.writeFileSync(path.join(flatApp,'package.json'),JSON.stringify({name:'foreign-app'}));await assert.rejects(copied.inspectShippedWorkspaceProvenance(flatWorkspace,'filesystem',flatApp));
  console.log(JSON.stringify({sourceControl:'flattened-bundled-provenance',actualSiblingDependencyNamespace:true,applicationAssetsRemainSeparatelyBound:true,foreignApplicationNameRefused:true,scope:'Synthetic inspection mechanics; no packed installed functional acceptance'}));
  fs.appendFileSync(path.join(workspace,'mcp-servers/filesystem/dist/index.js'),'\n// workspace edit');
  await assert.rejects(copied.inspectShippedWorkspaceProvenance(workspace,'filesystem',app));
  console.log(JSON.stringify({sourceControl:'bundled-provenance-inspection',actualWorkspaceCopyAndDependencyJunction:true,actualDeclaredTransitiveCycleBounded:true,actualEarlierDependencyMutationWhileLaterReadRefused:changedDuringRead,actualParsedManifestChangeBeforeTreeReadRefused:manifestChanged,dependencyRevisionSensitive:true,retargetedJunctionRefused:true,foreignInstallationRootRefused:true,hardlinkRefused:true,editedWorkspaceAssetRefused:true,inspectedCodeNeverExecuted:true,scope:'Synthetic inspection mechanics only; no grant issuance, arbitrary import closure, installed functional acceptance or scanner clearance'}));
 }finally{assert.equal(path.dirname(owned),parent);assert.match(path.basename(owned),/^flujo-bundle-inspection-/);assert.equal(fs.lstatSync(owned).isSymbolicLink(),false);fs.rmSync(owned,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
