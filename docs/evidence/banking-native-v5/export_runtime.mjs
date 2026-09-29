/** Read-only, privacy-filtered export. No model requests or tool dispatch. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

try {
  const [correlationFile, graphFile, expectedText, workspaceData = '/data/flujo/workspaces'] = process.argv.slice(2);
  const expected = Number(expectedText);
  const bytes = fs.readFileSync(correlationFile);
  const records = JSON.parse(bytes);
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const policyBytes = fs.readFileSync(process.env.FLUJO_BANKING_CONFIG);
  const policy = JSON.parse(policyBytes);
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  const graphHash = v => {
    const x = structuredClone(v);
    if (x.permissionRules !== undefined) {
      if (x.behaviorRules !== undefined && canonical(x.behaviorRules) !== canonical(x.permissionRules)) throw Error();
      x.behaviorRules ??= x.permissionRules;
      delete x.permissionRules;
    }
    return sha(canonical(x));
  };
  const check = condition => { if (!condition) throw Error(); };
  check(expected === 500 && records.length === expected);
  check(graphHash(graph) === policy.graphHash);
  const processNode = graph.nodes.find(n => (n.data?.type ?? n.type) === 'process');
  const bankNode = graph.nodes.find(n => (n.data?.type ?? n.type) === 'mcp' && n.data?.properties?.boundServer === policy.bankServerName);
  check(processNode && bankNode && !graph.nodes.some(n => (n.data?.type ?? n.type) === 'static'));
  const allowedTools = new Set(bankNode.data.properties.enabledTools.map(n => 'Banking_MCP__' + n));
  const db = path.join(workspaceData, policy.workspace, 'db');
  const owners = path.join(policy.stateDir, sha(policy.deploymentId), 'owners');
  const eventsByRun = new Map();
  for (const file of fs.readdirSync(path.join(db, 'statistics')).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))) {
    for (const line of fs.readFileSync(path.join(db, 'statistics', file), 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const entries = eventsByRun.get(e.runId) ?? []; entries.push(e); eventsByRun.set(e.runId, entries);
    }
  }
  const labels = new Map();
  const label = (kind, raw) => {
    check(typeof raw === 'string' && raw.length > 0);
    let values = labels.get(kind); if (!values) { values = new Map(); labels.set(kind, values); }
    if (!values.has(raw)) values.set(raw, kind + '-' + String(values.size + 1).padStart(4, '0'));
    return values.get(raw);
  };
  const refs = v => {
    if (typeof v === 'string') { try { return refs(JSON.parse(v)); } catch { return []; } }
    if (Array.isArray(v)) return v.flatMap(refs);
    if (!v || typeof v !== 'object') return [];
    return [typeof v.transaction_reference === 'string' ? v.transaction_reference : null,
      ...Object.values(v).flatMap(refs)].filter(x => x && /^txn_[a-f0-9]{12}$/.test(x));
  };
  const unique = v => [...new Set(v)];
  const referenceLabels = v => unique(v).map(x => label('reference', x)).sort();
  const origin = Math.min(...records.map(r => r.request_assertions[0].created_at));
  const rows = [];
  for (const [i, r] of records.entries()) {
    check(r.ok === true && /^[a-f0-9-]{36}$/.test(r.conversation));
    const owner = JSON.parse(fs.readFileSync(path.join(owners, sha(r.conversation) + '.json'), 'utf8'));
    const raw = fs.readFileSync(path.join(db, 'conversations', r.conversation + '.json'), 'utf8');
    const state = JSON.parse(raw);
    check(owner.subject === r.subject && owner.graph === policy.graphHash && owner.workspace === policy.workspace && owner.deployment === policy.deploymentId);
    check(state.status === 'completed' && state.flowId === policy.flowId && state.conversationId === r.conversation);
    check(graphHash(state.flowSnapshot) === policy.graphHash && (state.executionExtensionOwned || state.bankingOwned));
    check(!raw.includes(policy.executionToken) && !raw.includes('com.flujo.bank/assertion'));
    const calls = state.messages.flatMap(m => m.tool_calls ?? []);
    const results = state.messages.filter(m => m.role === 'tool');
    check(calls.length > 0 && calls.length === results.length && new Set(calls.map(c => c.id)).size === calls.length);
    check(new Set(results.map(t => t.tool_call_id)).size === calls.length);
    check(calls.every(c => allowedTools.has(c.function.name) && !c.id.startsWith('call_static_')));
    check(state.messages.every(m => m.role === 'assistant' || !m.tool_calls?.length));
    const successfulRefs = [];
    const publicTools = calls.map(c => {
      const t = results.find(v => v.tool_call_id === c.id); check(t);
      const parsed = JSON.parse(t.content);
      check(parsed.structuredContent && typeof parsed.structuredContent === 'object' && !Array.isArray(parsed.structuredContent)
        && !parsed.isError && !parsed.structuredContent.error
        && parsed.structuredContent.synthetic === false && parsed.structuredContent.operator_test === false);
      const actual = refs(parsed); check(actual.length > 0 && actual.every(v => r.allowed_references.includes(v)));
      successfulRefs.push(...actual);
      return { call: label('tool-call', c.id), result_call: label('tool-call', t.tool_call_id),
        tool: c.function.name, success: true, references: referenceLabels(actual),
        synthetic: false, operator_test: false };
    });
    const finalRefs = unique(String(state.lastResponse ?? '').match(/\btxn_[a-f0-9]{12}\b/g) ?? []);
    const delivered = unique(r.delivered_references ?? []);
    check(delivered.length > 0 && finalRefs.length > 0 && delivered.every(v => successfulRefs.includes(v) && finalRefs.includes(v)) && finalRefs.every(v => delivered.includes(v)));
    const events = eventsByRun.get(state.logicalRunId) ?? [];
    const started = events.find(e => e.type === 'run.started');
    const attempts = events.filter(e => e.type === 'model.attempt');
    check(started?.conversationId === r.conversation && attempts.length === 1);
    const model = attempts[0];
    check(model.outcome === 'completed' && model.model?.id === processNode.data.properties.boundModel && model.node?.id === processNode.id);
    check(model.usage?.inputTokens > 0 && model.usage?.outputTokens > 0);
    const summaries = state.messages.filter(m => m.role === 'assistant' && m.processNodeId === processNode.id && typeof m.content === 'string' && !m.tool_calls?.length);
    check(summaries.some(m => m.usage?.completionTokens > 0));
    check(finalRefs.every(v => summaries.some(m => m.content.includes(v))));
    check(r.request_assertions.length === 1);
    const a = r.request_assertions[0];
    check(Number.isInteger(a.iat) && Number.isInteger(a.exp) && a.exp > a.iat && a.exp - a.iat <= 120 && a.iat <= a.created_at && a.created_at < a.exp && a.exp <= r.session_exp);
    const terminal = Date.parse(model.timestamp) / 1000;
    check(Number.isFinite(terminal) && Number.isFinite(r.completed_at) && Number.isFinite(r.full_response_seconds));
    rows.push({ request: i + 1, expected_owner: label('owner', r.subject), stored_owner: label('owner', owner.subject),
      request_conversation: label('conversation', r.conversation), stored_conversation: label('conversation', state.conversationId),
      run_conversation: label('conversation', started.conversationId), session: label('session', r.session_id),
      logical_run: label('run', state.logicalRunId), run_event: label('run', started.runId),
      expected_flow: label('flow', policy.flowId), stored_flow: label('flow', state.flowId), graph_sha256: graphHash(state.flowSnapshot),
      configured_model: label('model', processNode.data.properties.boundModel),
      model: { id: label('model', model.model.id), outcome: model.outcome, input_tokens: model.usage.inputTokens,
        output_tokens: model.usage.outputTokens, terminal_seconds: terminal - origin },
      tools: publicTools, oracle_references: referenceLabels(r.allowed_references),
      successful_tool_references: referenceLabels(successfulRefs), persisted_reply_references: referenceLabels(finalRefs),
      delivered_references: referenceLabels(delivered), completed_state: true, ownership_marker: true,
      checked_authority_markers_absent: true, full_response_seconds: r.full_response_seconds,
      timing: { assertion_iat_seconds: a.iat - origin, assertion_exp_seconds: a.exp - origin,
        header_created_seconds: a.created_at - origin, session_exp_seconds: r.session_exp - origin,
        client_completed_seconds: r.completed_at - origin, assertions: r.request_assertions.length } });
  }
  check(new Set(rows.map(r => r.request_conversation)).size === expected && new Set(rows.map(r => r.expected_owner)).size === expected);
  console.log(JSON.stringify({ schema: 'banking-native-export/v1', captured_at: new Date().toISOString(),
    source_correlation_sha256: sha(bytes), policy_sha256: sha(policyBytes), expected_graph_sha256: policy.graphHash,
    relative_time_origin_utc: new Date(origin * 1000).toISOString(), requests: rows }));
} catch {
  console.error('native_evidence_export_failed');
  process.exitCode = 1;
}
