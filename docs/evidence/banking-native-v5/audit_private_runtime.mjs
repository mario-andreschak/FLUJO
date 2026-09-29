import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const correlationBytes = fs.readFileSync(process.argv[2]);
const records = JSON.parse(correlationBytes.toString('utf8'));
const expectedCount = Number(process.argv[3]);
const graph = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const modelNode = graph.nodes.find(node => (node.data?.type ?? node.type) === 'process');
const policy = JSON.parse(fs.readFileSync(process.env.FLUJO_BANKING_CONFIG, 'utf8'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const root = path.join(policy.stateDir, digest(policy.deploymentId));
const conversations = `/data/flujo/workspaces/${policy.workspace}/db/conversations`;
const statsDir = `/data/flujo/workspaces/${policy.workspace}/db/statistics`;
const byRun = new Map();
for (const file of fs.readdirSync(statsDir).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))) {
  for (const line of fs.readFileSync(path.join(statsDir,file),'utf8').split('\n').filter(Boolean)) {
    let event; try { event=JSON.parse(line); } catch { continue; }
    const items=byRun.get(event.runId)??[];items.push(event);byRun.set(event.runId,items);
  }
}
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const graphHash=value=>{const graphValue=structuredClone(value);if(graphValue.permissionRules!==undefined){if(graphValue.behaviorRules!==undefined&&canonical(graphValue.behaviorRules)!==canonical(graphValue.permissionRules))throw new Error();graphValue.behaviorRules??=graphValue.permissionRules;delete graphValue.permissionRules;}return digest(canonical(graphValue));};
const errors = {};
const fail = code => { errors[code] = (errors[code] ?? 0) + 1; };
if (!Number.isInteger(expectedCount) || expectedCount<1 || records.length!==expectedCount
  || new Set(records.map(record=>record.subject)).size!==expectedCount) fail('phase_coverage');
const refs = value => {
  if (typeof value === 'string') { try { return refs(JSON.parse(value)); } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(refs);
  if (!value || typeof value !== 'object') return [];
  return [typeof value.transaction_reference === 'string' ? value.transaction_reference : null,
    ...Object.values(value).flatMap(refs)].filter(value => value && /^txn_[a-f0-9]{12}$/.test(value));
};
const ids = new Set();
let audited = 0, toolCalls = 0, authorityStates = 0, authorityLeaks = 0, completedModels=0, deliveredMatches=0;
let timingRecords=0, modelsCompletedAfterIngressExpiry=0;
for (const record of records) {
  if (!record.ok) { fail('request_failed'); continue; }
  try {
    if (!/^[a-f0-9-]{36}$/.test(record.conversation) || ids.has(record.conversation)) throw new Error();
    ids.add(record.conversation);
    const owner = JSON.parse(fs.readFileSync(path.join(root, 'owners', digest(record.conversation)+'.json'), 'utf8'));
    if (owner.subject !== record.subject || owner.graph !== policy.graphHash
      || owner.workspace !== policy.workspace || owner.deployment !== policy.deploymentId) throw new Error();
    const raw = fs.readFileSync(path.join(conversations, record.conversation+'.json'), 'utf8');
    const state = JSON.parse(raw);
    authorityStates++;
    if (raw.includes(policy.executionToken) || raw.includes('com.flujo.bank/assertion')) authorityLeaks++;
    if (state.flowId !== policy.flowId || state.conversationId !== record.conversation
      || state.status!=='completed' || graphHash(state.flowSnapshot)!==policy.graphHash || graphHash(graph)!==policy.graphHash
      || !(state.executionExtensionOwned || state.bankingOwned)
      || raw.includes(policy.executionToken) || raw.includes('com.flujo.bank/assertion')) throw new Error();
    const calls = state.messages.flatMap(message => message.tool_calls ?? []);
    const tools = state.messages.filter(message => message.role === 'tool');
    const graphBank=graph.nodes.find(node=>(node.data?.type??node.type)==='mcp'&&node.data.properties.boundServer===policy.bankServerName);
    const allowedNames = new Set((graphBank?.data.properties.enabledTools??[]).map(name=>'Banking_MCP__'+name));
    const callIds=new Set(calls.map(call=>call.id));
    if (!calls.length || tools.length!==calls.length || callIds.size!==calls.length
      || new Set(tools.map(tool=>tool.tool_call_id)).size!==calls.length
      || calls.some(call=>!allowedNames.has(call.function.name)||typeof call.id!=='string'||call.id.startsWith('call_static_'))
      || state.messages.some(message=>message.role!=='assistant'&&message.tool_calls?.length)
      || tools.some(tool=>!callIds.has(tool.tool_call_id))) throw new Error();
    const returned = [...new Set(tools.flatMap(tool => refs(tool.content)))];
    const allowed = new Set(record.allowed_references);
    if (!returned.length || returned.some(ref => !allowed.has(ref))) throw new Error();
    const successful = new Set(tools.flatMap(tool=>{const result=JSON.parse(tool.content);return result&&typeof result==='object'
      &&result.structuredContent&&typeof result.structuredContent==='object'&&!Array.isArray(result.structuredContent)
      &&!result.isError&&!result.structuredContent.error?refs(result):[];}));
    if (!successful.size) throw new Error();
    const finalRefs=new Set((typeof state.lastResponse==='string'?state.lastResponse:'').match(/\btxn_[a-f0-9]{12}\b/g)??[]);
    const delivered=new Set(record.delivered_references??[]);
    const actual=successful;
    if (!delivered.size || !finalRefs.size || [...delivered].some(ref=>!actual.has(ref)||!finalRefs.has(ref))
      || [...finalRefs].some(ref=>!delivered.has(ref))) throw new Error();
    const events=byRun.get(state.logicalRunId)??[];
    const attempts=events.filter(event=>event.type==='model.attempt');
    if (!events.some(event=>event.type==='run.started'&&event.conversationId===record.conversation)
      || attempts.length!==1 || attempts[0].outcome!=='completed' || attempts[0].model?.id!==modelNode.data.properties.boundModel
      || attempts[0].node?.id!==modelNode.id || !(attempts[0].usage?.inputTokens>0)||!(attempts[0].usage?.outputTokens>0)) throw new Error();
    if (record.request_assertions !== undefined) {
      const timings=record.request_assertions;
      if (!Array.isArray(timings)||timings.length!==1||!Number.isInteger(timings[0].exp)
        || !Number.isFinite(Date.parse(attempts[0].timestamp))) throw new Error();
      timingRecords++;
      if (Date.parse(attempts[0].timestamp)>timings[0].exp*1000) modelsCompletedAfterIngressExpiry++;
    }
    const summaries=state.messages.filter(message=>message.role==='assistant'&&message.processNodeId===modelNode.id
      &&typeof message.content==='string'&&message.content.trim()&&!message.tool_calls?.length);
    const summaryRefs=new Set(summaries.flatMap(message=>message.content.match(/\btxn_[a-f0-9]{12}\b/g)??[]));
    if (!summaries.some(message=>message.usage?.completionTokens>0)||[...finalRefs].some(ref=>!summaryRefs.has(ref)))throw new Error();
    completedModels++;deliveredMatches++;
    toolCalls += calls.length;
    audited++;
  } catch { fail('private_tool_owner_audit_failed'); }
}
const result = {records: records.length, independent_tool_owner_matches: audited, tool_calls: toolCalls,
  correlation_sha256:digest(correlationBytes), records_with_ingress_timing:timingRecords,
  server_completed_model_attempts_after_ingress_expiry:modelsCompletedAfterIngressExpiry,
  completed_real_model_attempts:completedModels,delivered_matches_actual_tool_results:deliveredMatches,
  distinct_conversations: ids.size, authority_absence_coverage:'successful response states',
  authority_states_audited:authorityStates, authority_not_persisted_in_audited_states:authorityStates>0 && authorityLeaks===0,
  errors, passed: audited === records.length && !Object.keys(errors).length};
console.log(JSON.stringify(result));
process.exit(result.passed ? 0 : 1);
