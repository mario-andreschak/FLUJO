// Controlled real-daemon probe; uses the production launch primitive and installed SDKs.
// No pull/build/network/credentials. Only the returned owned container is removed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const source = path.resolve(__dirname, '../../../src/backend/services/security/isolatedMcp.ts');
require.extensions['.ts'] = (module, filename) => {
  if (filename !== source) throw new Error('Unexpected source module');
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const { createIsolatedMcpLaunch, isolatedMcpPolicyDigest } = require(source);
const [dockerExecutable, daemon, image, expected = 'reaped'] = process.argv.slice(2);
if (!['zombie', 'reaped'].includes(expected)) throw new Error('Expected zombie or reaped probe mode');
const program = `
const fs = require('fs'), cp = require('child_process'), rl = require('readline');
let orphan;
function state(pid) { try { const s = fs.readFileSync('/proc/'+pid+'/status','utf8'); return { pid, ppid: Number(s.match(/^PPid:\\s+(\\d+)/m)[1]), state: s.match(/^State:\\s+(\\w)/m)[1] }; } catch { return {pid, absent:true}; } }
function reply(id, result) { console.log(JSON.stringify({jsonrpc:'2.0',id,result})); }
rl.createInterface({input:process.stdin}).on('line', async line => {
 const m=JSON.parse(line); if (m.id === undefined) return;
 if (m.method==='initialize') return reply(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owned-reaping-probe',version:'1.0.0'}});
 if(m.method==='tools/list') return reply(m.id,{tools:[{name:'probe',description:'owned process lifecycle',inputSchema:{type:'object',properties:{phase:{type:'string'}},required:['phase']}}]});
 if(m.method==='tools/call') {
  const phase=m.params.arguments.phase;
  if(phase==='spawn') {
   const childCode="const fs=require('fs'); fs.writeFileSync('/tmp/orphan-pid',String(process.pid)); const t=setInterval(()=>{if(fs.existsSync('/tmp/release-orphan')) { clearInterval(t);process.exit(0);}},20);";
   const parentCode="const cp=require('child_process'),fs=require('fs'); const c=cp.spawn(process.execPath,['-e',"+JSON.stringify(childCode)+"],{stdio:'ignore'}); c.unref(); const t=setInterval(()=>{if(fs.existsSync('/tmp/orphan-pid')) {clearInterval(t);process.exit(0);}},20);";
   const p=cp.spawn(process.execPath,['-e',parentCode],{stdio:'ignore'});
   await new Promise(r=>p.once('exit',r)); orphan=Number(fs.readFileSync('/tmp/orphan-pid','utf8'));
  }
  if(phase==='release') fs.writeFileSync('/tmp/release-orphan','release');
  const status=fs.readFileSync('/proc/self/status','utf8');
  return reply(m.id,{content:[{type:'text',text:JSON.stringify({serverPid:process.pid,orphan:state(orphan),uid:process.getuid(),cwd:process.cwd(),noCaps:/^CapEff:\\s+0+$/m.test(status),noNewPrivileges:/^NoNewPrivs:\\s+1$/m.test(status)})}]});
 }
});`;
(async () => {
 for (const era of ['v1', 'beta']) {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'flujo-mcp-reaping-'));
  let launch, client, transport;
  try {
   const grant=path.join(workspace,'storage/mcp-grants/probe');
   fs.mkdirSync(grant,{recursive:true}); fs.writeFileSync(path.join(grant,'server.cjs'),program);
   const policy={schemaVersion:1,kind:'docker-deny-egress',dockerExecutable,daemon,image,command:['node','/grants/probe/server.cjs'],environmentNames:[],mounts:[{name:'probe',source:'storage/mcp-grants/probe'}],memoryMiB:128,cpus:0.5,pidsLimit:32};
   launch=createIsolatedMcpLaunch(policy,isolatedMcpPolicyDigest(policy),workspace);
   const sdk=await import(era==='v1'?'@modelcontextprotocol/sdk/client/index.js':'@modelcontextprotocol/client');
   const stdio=await import(era==='v1'?'@modelcontextprotocol/sdk/client/stdio.js':'@modelcontextprotocol/client/stdio');
   client=new sdk.Client({name:'owned-probe',version:'1.0.0'});
   transport=new stdio.StdioClientTransport({command:launch.command,args:[...launch.args],env:launch.env,cwd:launch.cwd,stderr:'pipe'});
   await client.connect(transport, {timeout:10000});
   const call=async phase=>JSON.parse((await client.callTool({name:'probe',arguments:{phase}}, undefined, {timeout:10000})).content[0].text);
   const adopted=await call('spawn');
   if(adopted.orphan.ppid!==1 || adopted.orphan.state==='Z') throw new Error('Live orphan was not adopted by PID 1');
   await call('release');
   let after;
   for(let i=0;i<100;i++) { after=await call('status'); if(expected==='reaped'?after.orphan.absent:after.orphan.state==='Z') break; await new Promise(r=>setTimeout(r,30)); }
   if(expected==='reaped'?!after.orphan.absent:after.orphan.state!=='Z') throw new Error('Unexpected orphan exit state');
   const responsive=await call('status');
   const inspect=JSON.parse(execFileSync(dockerExecutable,[...launch.args.slice(0,4),'inspect',launch.containerId],
     {env:launch.env,encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:64*1024}))[0];
   const host=inspect.HostConfig;
   if(responsive.uid!==65534 || responsive.cwd!=='/' || !responsive.noCaps || !responsive.noNewPrivileges
     || host.NetworkMode!=='none' || !host.ReadonlyRootfs || host.Memory!==134217728
     || host.MemorySwap!==134217728 || host.NanoCpus!==500000000 || host.PidsLimit!==32
     || (expected==='reaped' ? host.Init!==true : host.Init===true)
     || inspect.Mounts.length!==1 || inspect.Mounts[0].Destination!=='/grants/probe' || inspect.Mounts[0].RW) throw new Error('Isolation restriction mismatch');
   await client.close(); client=undefined;
   const cleanup=launch.close(); if(cleanup.outcome==='unknown') throw new Error('Owned cleanup unobserved');
   console.log(JSON.stringify({era,expected,containerId:launch.containerId,adopted,after,responsive:true,init:host.Init,cleanup:cleanup.outcome,image}));
  } finally {
   if(client) await client.close().catch(()=>{});
   if(launch) {
    const finalCleanup=launch.close().outcome; console.log(JSON.stringify({era,finalCleanup}));
    // Preserve the mounted source if daemon cleanup cannot be observed.
    if(finalCleanup==='unknown') throw new Error('Owned cleanup unknown; grant workspace retained: '+workspace);
   }
   if(!/^flujo-mcp-reaping-[A-Za-z0-9]+$/.test(path.relative(path.resolve(os.tmpdir()),workspace))) throw new Error('Unsafe cleanup path');
   fs.rmSync(workspace,{recursive:true,force:true});
  }
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
