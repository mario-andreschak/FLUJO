const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const source = process.cwd();
const evidence = process.argv[2];
process.env.FLUJO_DATA_DIR = evidence + '/probe-data';
const installed = createRequire(path.join(source, 'package.json'));
const ts = installed('typescript');
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const mod = {exports:{}}; modules.set(file,mod);
  const emitted = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  new Function('require','module','exports','__dirname','__filename',emitted)(name=>{
    if(name==='@/utils/logger') return {createLogger:()=>({debug(){},info(){},warn(){},error(){},verbose(){}})};
    if(name.startsWith('.')||name.startsWith('@/')) {
      const candidate=name.startsWith('@/')?path.join(source,'src',name.slice(2)):path.resolve(path.dirname(file),name);
      for(const suffix of ['.ts','.tsx','/index.ts']) if(fs.existsSync(candidate+suffix)) return load(candidate+suffix);
      return installed(candidate);
    }
    return installed(name);
  },mod,mod.exports,path.dirname(file),file);
  return mod.exports;
}
const api=load(source+'/src/backend/execution/flow/handlers/summarizingCompaction.ts');
const store=load(source+'/src/backend/services/runResources/index.ts');
store._setRunResourcesDirForTests(evidence+'/probe-resources');
const options={keepTokens:20,conversationId:'anchor-case',projection:{conversationId:'anchor-case',view:'node-projected',handoffPolicy:'strip-v1',version:1},sourceDigest:'source',projectionDigest:'projection',policyVersion:'summary-v1'};
const sections=['## Objective','## Important Details','## Work State','## Next Move','## Relevant Files'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
(async()=>{
  const samples=[];
  for(let round=0;round<3;round++){
    const payload='x'.repeat(24*1024*1024)+' 🧭\ud800\\\n保留 flujo://run/exact/tail';
    const input=Object.freeze({id:'large',role:'assistant',content:payload,timestamp:1,metadata:{'2':'two','10':'ten',flags:[true,null,-0]}});
    const sourceHash=hash(payload);
    const expectedHash=hash(JSON.stringify([input]));
    global.gc(); const before=process.memoryUsage(); const started=performance.now();
    let atWriter,afterWriter,written;
    const result=await api.compactHistory([input,{id:'recent',role:'user',timestamp:1,content:'recent '.repeat(100)}],options,{
      summarize:async()=>sections.map(s=>s+'\n- None.').join('\n\n'),now:()=>1,uuid:()=>`artifact-${round}`,
      writeAnchor:async(sourceValue,metadata)=>{
        atWriter=process.memoryUsage();
        written=await store.writeRunResource({conversationId:'anchor-case',kind:'text',mimeType:'application/json',name:'anchor-'+round,
          data:typeof sourceValue==='string'?{text:sourceValue}:{json:sourceValue},producedBy:{source:'compaction-artifact',...metadata}});
        afterWriter=process.memoryUsage();
        if('skipped' in written)throw new Error('Anchor unexpectedly refused');
        return written.uri;
      }
    });
    if(!result||hash(input.content)!==sourceHash)throw new Error('Compaction/canonical history changed');
    const filename=path.join(evidence,'probe-resources','anchor-case',written.id+'.dat');
    const persisted=createHash('sha256');
    for await(const chunk of fs.createReadStream(filename))persisted.update(chunk);
    if(persisted.digest('hex')!==expectedHash||written.sha256!==expectedHash)throw new Error('Persisted JSON changed');
    global.gc();const retained=process.memoryUsage();
    samples.push({round,before,atWriter,afterWriter,retained,elapsedMs:performance.now()-started,size:written.size,
      writerEntryHeapGrowth:atWriter.heapUsed-before.heapUsed,writerExitHeapGrowth:afterWriter.heapUsed-before.heapUsed,
      writerExitExternalGrowth:afterWriter.external-before.external});
  }
  const report={utc:new Date().toISOString(),complete:true,revision:process.env.FLUJO_TEST_REVISION,provenance:api.provenance,
    samples,withinEnvelope:samples.every(s=>s.writerEntryHeapGrowth<16*1024*1024&&s.writerExitHeapGrowth<16*1024*1024&&s.writerExitExternalGrowth<8*1024*1024),
    providerCalls:0,summaryDependency:'Injected deterministic summary; actual resource store and files, no provider or fidelity claim',forcedGc:'Before/after diagnostic samples only'};
  fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2));
  console.log(JSON.stringify({complete:true,withinEnvelope:report.withinEnvelope,samples:samples.map(s=>({round:s.round,writerEntryHeapGrowth:s.writerEntryHeapGrowth,writerExitExternalGrowth:s.writerExitExternalGrowth,elapsedMs:s.elapsedMs,size:s.size}))}));
  if(!report.withinEnvelope)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
