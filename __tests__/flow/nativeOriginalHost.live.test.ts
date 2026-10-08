import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runWithWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { modelService } from '@/backend/services/model';
import { createPersonaFromRole } from '@/backend/services/enduringAgents/factory';
import { createRoleVersion, savePersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { createPersonaWorkItem } from '@/backend/services/enduringAgents/workItems';
import { PersonaFlowDispatcher, personaFlowDispatchId } from '@/backend/services/enduringAgents/personaDispatcher';
import { stopPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntime';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { buildTestRoleVersion, ensureTestRole } from '../enduringAgents/fixtures/personaFactory';

const output=process.env.FLUJO_LIVE_CODEX_ORIGINAL_RECEIPT;
const live=output?it:it.skip;
live('completes actual Luna/medium under a genuine Persona lease and saved Original without SDK or provider mocks',async()=>{
  if(!path.isAbsolute(output!)||!process.env.FLUJO_DATA_DIR)throw new Error('Private live receipt/data paths required');
  const relative=path.relative(process.cwd(),output!);
  if(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('Live receipt must remain outside Git');
  const startedAt=new Date().toISOString();
  await runWithWorkspace('source-codex-original-live-qualification',async()=>{
    stopPersonaGoalRuntime();
    const modelId='live-luna-original';
    if(!await modelService.getModel(modelId))expect((await modelService.addModel({id:modelId,name:'gpt-6-luna',
      displayName:'Local Luna Original qualification',provider:'codex',adapter:'codex-cli',ApiKey:'',
      reasoningEffort:'medium',maxTurns:1})).success).toBe(true);
    await ensureTestRole();const version=buildTestRoleVersion();
    version.id='rolever_live_original_qualification';version.version=3;
    version.coreFlowTemplate!.nodes=version.coreFlowTemplate!.nodes.filter(node=>node.data.type!=='finish');
    version.coreFlowTemplate!.edges=version.coreFlowTemplate!.edges.filter(edge=>edge.target!=='test_core_finish');
    const processNode=version.coreFlowTemplate!.nodes.find(node=>node.data.type==='process')!;
    processNode.data.properties={...processNode.data.properties,boundModel:modelId,maxTurns:1,
      promptTemplate:'Local qualification only. Reply exactly READY. Do not use any tools or perform business work.'};
    await createRoleVersion(version);
    const {persona}=await createPersonaFromRole({name:'Local Original qualification',idempotencyKey:'live-original-qualification',
      autonomyLevel:'locked',roleVersionId:version.id});
    const goal=await createPersonaWorkItem({personaId:persona.id,title:'Local process qualification only',
      goal:{successCriteria:'One completed saved Original with actual Luna/medium output',continuationIntervalMs:10000}});
    const key='live-original-'+Date.now();const dispatchId=personaFlowDispatchId(persona.id,key);
    await savePersonaWorkItem({...goal,goal:{...goal.goal!,rounds:1,roundsInWindow:1,pendingTaskId:goal.id,
      pendingDispatchId:dispatchId,pendingAttemptKey:key,pendingPrompt:'Reply exactly READY.',pendingPriority:'normal'}});
    let observed=false,failure:unknown;
    const dispatcher=new PersonaFlowDispatcher({dependencies:{runFlow:async input=>{
      observed=true;const result=await runFlow(input);
      try {expect(result.status).toBe('completed');expect(result.outputText.trim()).toBe('READY');}
      catch(error){failure=error;}return result;
    }}});
    try {
      await dispatcher.submit({personaId:persona.id,idempotencyKey:key,kind:'assignment',source:{kind:'assignment',sourceId:goal.id},
        flowInput:{source:'internal',prompt:'Reply exactly READY.',mode:'conversation',requireApproval:false,onApprovalRequired:'fail'}},
        {startPump:false});
      await dispatcher.pump(persona.id);expect(observed).toBe(true);
      if(failure)throw failure;
      const folder=path.join(getWorkspaceDataDir(),'db','native-session-origins','host-ledger');
      const records=await fs.readdir(folder);const ledgers=await Promise.all(records.filter(file=>file.endsWith('.json')).map(async file=>
        JSON.parse(await fs.readFile(path.join(folder,file),'utf8'))));
      const reservations=ledgers.flatMap(ledger=>ledger.reservations).filter(value=>value.owner.modelId===modelId);
      const reservation=reservations.at(-1);
      expect(reservation).toMatchObject({state:'released',sdkOutcome:'completed',exit:{code:0,signal:null},
        sdkUsage:{source:'codex-app-server-usage',appServerTurns:1}});
      await fs.writeFile(output!,JSON.stringify({kind:'live-source-persona-original-qualification',startedAt,
        observedAt:new Date().toISOString(),model:'gpt-6-luna',effort:'medium',reservation,
        output:'READY',billedCostUsd:null,countsAsRequestedSwarm:false,countsAsBusinessWork:false},null,2),{mode:0o600});
    } catch(error) {
      // Jest removes its private workspace after this test. Preserve only the
      // bounded qualification refusal, never account files, before teardown.
      const directory=path.join(getWorkspaceDataDir(),'db','codex-runtime','native-profiles');
      const files=await fs.readdir(directory).catch(()=>[]);
      const refusals=files.filter(file=>/^[a-f0-9]{64}\.[a-f0-9]{32}\.qualification-refusal\.json$/.test(file));
      if(refusals.length===1) {
        const diagnostic=JSON.parse(await fs.readFile(path.join(directory,refusals[0]),'utf8'));
        await fs.writeFile(output!+'.refusal.json',JSON.stringify(diagnostic,null,2),{flag:'wx',mode:0o600});
      }
      throw error;
    } finally {await dispatcher.quiesce(persona.id);stopPersonaGoalRuntime();}
  });
},180000);
