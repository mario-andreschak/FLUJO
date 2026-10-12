#!/usr/bin/env node
/**
 * Read-only, allowlisted evidence export for the October 11, 2026 live journeys.
 * Run from any directory with Node and access to the owned Docker container:
 *   node docs/journeys/evidence/export-journey-evidence.mjs --check
 * After the capture owner confirms completion:
 *   node docs/journeys/evidence/export-journey-evidence.mjs --snapshot
 * --check prints only a bounded inventory; --snapshot writes the adjacent JSON.
 * Neither mode changes runtime state or makes provider/network requests.
 * Runtime npm package 3.46.2 and documentation source 3.46.3 are distinct.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../../..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--snapshot'].includes(mode) || process.argv.length > 3) {
  throw new Error('Use --check or --snapshot; output is restricted to the evidence directory.');
}

const collector = String.raw`
import collections, datetime, gzip, hashlib, json, pathlib, re

ROOT = pathlib.Path('/workspace/flujo-data/workspaces/default-workspace/db')
PERSONA = 'persona_QoSV9cL3ctNoLVwagYE8JnLcXejTq_pRfnAJCT_Ya_I'
FIRST = '1c2db488-07bd-44c5-afcb-9efde2a57031'
MAYA = '8b10b7b3-3f7c-4ddc-9dff-834e63ac87f7'
GOAL = 'work_42d341982909416f8c4dfd5bbd559de5'
GUIDE = 'https://www.aboutcoffee.org/brewing/pour-over-coffee/'
PACKAGE = pathlib.Path('/opt/node-v24.21.0-linux-x64/lib/node_modules/flujo-ai/package.json')
read_versions = {}

def read_bytes(path):
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
        raise ValueError('Source changed during read; retry after the run settles.')
    read_versions[path] = (after.st_mtime_ns, after.st_size)
    return data

def read_json(path):
    return json.loads(read_bytes(path))

def utc(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.datetime.fromtimestamp(value / 1000, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return value

def selected(record, fields):
    return {key: record[key] for key in fields if key in record}

def dated(record, fields):
    out = selected(record, fields)
    for key in list(out):
        if key.endswith('At') or key in ('timestamp', 'nextRunAt', 'dailyWindowStartedAt'):
            out[key + 'Utc'] = utc(out.pop(key))
    return out

def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

def json_value(text):
    if not isinstance(text, str):
        return text
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None

def content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(part.get('text', '') for part in content if isinstance(part, dict) and isinstance(part.get('text'), str))
    return ''

def visible_message(message, event):
    role = message.get('role')
    if role not in ('user', 'assistant'):
        return None
    text = content_text(message.get('content'))
    if not text.strip():
        return None
    base = {'id': message.get('id'), 'role': role, 'timestampUtc': utc(message.get('timestamp')), 'eventSeq': event.get('seq'), 'eventTimestampUtc': utc(event.get('timestamp'))}
    if role == 'user' and text.lstrip().startswith('Advance this ongoing Persona goal autonomously'):
        return {**base, 'contentOmitted': 'Runtime-generated goal-round instruction; owner goal input is exported separately.'}
    # The old runtime could render a control tag in the assistant response.
    # Keep the user-facing response, recording this redaction explicitly.
    visible, removed = re.subn(r'<persona_activity_outcome\b[^>]*>.*?</persona_activity_outcome>', '', text, flags=re.S)
    if '<persona_activity_outcome' in visible:
        raise ValueError('Unclosed outcome control tag requires manual review.')
    base['content'] = visible
    if removed:
        base['transformations'] = ['Removed persona_activity_outcome control tag; activity outcome is exported as structured metadata.']
    return base

activity_records = [read_json(p) for p in sorted((ROOT / 'persona-activities' / PERSONA).glob('*.json'))]
work_records = [read_json(p) for p in sorted((ROOT / 'persona-work-items' / PERSONA).glob('*.json'))]
memory_records = [read_json(p) for p in sorted((ROOT / 'persona-memories' / PERSONA).glob('*.json'))]
goal_record = next(record for record in work_records if record.get('id') == GOAL)
conversation_ids = {FIRST, MAYA} | {record['conversationId'] for record in activity_records if record.get('conversationId')}

activities = []
for record in activity_records:
    out = dated(record, ['id', 'personaId', 'kind', 'status', 'conversationId', 'runId', 'createdAt', 'startedAt', 'updatedAt', 'completedAt'])
    out['sourceKind'] = (record.get('source') or {}).get('kind')
    if isinstance(record.get('outcome'), dict):
        out['outcome'] = dated(record['outcome'], ['resolution', 'summary', 'nextAction', 'goalAchieved', 'decisionSource', 'decidedAt'])
    activities.append(out)

work_items = []
for record in work_records:
    if record.get('id') != GOAL and record.get('parentGoalId') != GOAL:
        continue
    out = dated(record, ['id', 'personaId', 'parentGoalId', 'title', 'description', 'status', 'priority', 'nextAction', 'dependencyIds', 'createdAt', 'updatedAt'])
    if isinstance(record.get('goal'), dict):
        out['goal'] = dated(record['goal'], ['successCriteria', 'completionPolicy', 'state', 'rounds', 'progressSummary', 'consecutiveFailures', 'recoveryCount', 'lastActivityId', 'lastProgressAt', 'nextRunAt'])
    work_items.append(out)

memories = []
for record in memory_records:
    out = dated(record, ['id', 'personaId', 'kind', 'scope', 'status', 'content', 'confidence', 'importance', 'trust', 'reviewedAt', 'createdAt', 'updatedAt'])
    out['activeAtSnapshot'] = record.get('status') == 'active'
    memories.append(out)

# Capitalized ApiKey and all other credential/configuration fields are excluded.
models = [selected(m, ['id', 'name', 'displayName', 'provider', 'adapter', 'baseUrl']) for m in read_json(ROOT / 'models.json')]
argument_fields = {
    'fetch_readable': ['url', 'max_length', 'start_index'],
    'work_item_list': ['parent_goal_id', 'status', 'limit'],
    'work_item_create': ['title', 'description', 'priority', 'next_action', 'parent_goal_id'],
    'work_item_update': ['work_item_id', 'title', 'description', 'status', 'priority', 'next_action'],
    'work_item_complete': ['work_item_id', 'summary'],
    'remember': ['content', 'kind', 'scope', 'importance', 'confidence'],
    'recall': ['query', 'kind', 'scope', 'limit'],
    'report_activity_outcome': ['resolution', 'summary', 'next_action', 'goal_achieved'],
}
token_fields = ['promptTokens', 'completionTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens']

def tokens(events):
    usage = [event for event in events if event.get('type') == 'usage']
    return {'usageEventCount': len(usage), **{key: sum(event.get(key, 0) or 0 for event in usage) for key in token_fields}}

conversations = []
all_usage = []
for cid in sorted(conversation_ids):
    conversation = read_json(ROOT / 'conversations' / (cid + '.json'))
    event_bytes = read_bytes(ROOT / 'conversation-logs' / (cid + '.jsonl'))
    events = [json.loads(line) for line in event_bytes.decode('utf-8').splitlines() if line.strip()]
    if len({event['seq'] for event in events}) != len(events):
        raise ValueError('Duplicate event sequence; cannot safely aggregate usage.')
    events.sort(key=lambda event: event['seq'])
    all_usage.extend(event for event in events if event['type'] == 'usage')
    message_events = {event['message'].get('id'): event for event in events if event['type'] == 'message' and isinstance(event.get('message'), dict)}
    visible = [visible_message(message, message_events.get(message.get('id'), {})) for message in conversation.get('messages', [])]
    visible = [message for message in visible if message]
    tool_messages = {message.get('tool_call_id'): message for message in conversation.get('messages', []) if message.get('role') == 'tool'}
    calls = {event.get('toolCallId'): event for event in events if event['type'] == 'tool:call'}
    turns = []
    for path in sorted((ROOT / 'model-turns' / cid).glob('*.json.gz')):
        archive = json.loads(gzip.decompress(read_bytes(path)))
        entry = archive.get('entry') or {}
        turn = dated(entry, ['id', 'conversationId', 'runId', 'modelId', 'modelName', 'adapter', 'operation', 'timestamp', 'outcome', 'attempt', 'archiveVersion'])
        turn['providerModelId'] = (archive.get('sdkRequest') or {}).get('model')
        turns.append(turn)
    turns.sort(key=lambda turn: turn.get('timestampUtc') or '')
    clean_events = []
    for event in events:
        kind = event['type']
        if kind not in ('run:start', 'run:done', 'usage', 'tool:call', 'tool:result', 'model:dispatch', 'model:dispatch-result', 'message:removed'):
            continue
        out = {'type': kind, 'seq': event['seq'], 'timestampUtc': utc(event.get('timestamp'))}
        if kind == 'run:done':
            out['status'] = event.get('status')
        elif kind == 'usage':
            out.update(selected(event, token_fields))
            # 3.46.2 runFlow.accumulateUsage emits costUsd: 0 unconditionally.
            out['actualProviderCostUsd'] = None
        elif kind == 'model:dispatch':
            out['turn'] = dated(event.get('turn') or {}, ['id', 'runId', 'modelId', 'modelName', 'adapter', 'operation', 'timestamp', 'outcome', 'attempt'])
        elif kind == 'model:dispatch-result':
            out.update(selected(event, ['dispatchId', 'outcome']))
        elif kind == 'message:removed':
            out['messageId'] = event.get('messageId')
        elif kind in ('tool:call', 'tool:result'):
            name = event.get('name') or ''
            canonical = 'fetch_readable' if name.startswith('mcp_fetch_readable_') else name
            out.update({'toolCallId': event.get('toolCallId'), 'actualName': name, 'canonicalName': canonical})
            if kind == 'tool:call':
                args = json_value(event.get('args')) or {}
                out['arguments'] = selected(args, argument_fields.get(canonical, [])) if isinstance(args, dict) else {}
                if canonical not in argument_fields:
                    out['argumentsOmitted'] = 'Tool is outside the argument allowlist.'
            else:
                out['isError'] = event.get('isError', False)
                raw = content_text((tool_messages.get(event.get('toolCallId')) or {}).get('content'))
                out['fullResultAvailableInConversation'] = bool(raw)
                if raw:
                    out['resultSha256'] = sha(raw)
                    out['resultCharacters'] = len(raw)
                if canonical == 'fetch_readable':
                    args = json_value((calls.get(event.get('toolCallId')) or {}).get('args')) or {}
                    out['requestedUrl'] = args.get('url') if isinstance(args, dict) else None
                    payload = json_value(raw)
                    article = content_text(payload.get('content')) if isinstance(payload, dict) else ''
                    if article and not out['isError']:
                        out['retrievedTextCharacters'] = len(article)
                        out['retrievedTextSha256'] = sha(article)
                    out['resultContentOmitted'] = 'External source article is represented only by URL, length and hash.'
                else:
                    out['resultContentOmitted'] = 'Tool response omitted; public arguments and current task/memory/activity state are exported separately.'
        clean_events.append(out)
    runs = []
    pending = None
    for event in events:
        if event['type'] == 'run:start':
            if pending is not None:
                raise ValueError('Overlapping run events need manual review.')
            pending = event
        elif event['type'] == 'run:done' and pending is not None:
            run_events = [item for item in events if pending['seq'] <= item['seq'] <= event['seq']]
            run_ids = sorted({item.get('turn', {}).get('runId') for item in run_events if item['type'] == 'model:dispatch' and item.get('turn', {}).get('runId')})
            runs.append({'startSeq': pending['seq'], 'endSeq': event['seq'], 'startedAtUtc': utc(pending['timestamp']), 'completedAtUtc': utc(event['timestamp']), 'measuredRunMilliseconds': event['timestamp'] - pending['timestamp'], 'status': event.get('status'), 'runIds': run_ids, 'usage': tokens(run_events), 'toolCallCounts': dict(collections.Counter(item.get('name') for item in run_events if item['type'] == 'tool:call'))})
            pending = None
    if pending is not None:
        runs.append({'startSeq': pending['seq'], 'startedAtUtc': utc(pending['timestamp']), 'completedAtUtc': None, 'measuredRunMilliseconds': None, 'status': 'running'})
    conversations.append({'conversationId': cid, 'journey': 'first-helper' if cid == FIRST else 'maya', **dated(conversation, ['title', 'createdAt', 'updatedAt', 'status']), 'messages': visible, 'runs': runs, 'usage': tokens(events), 'events': clean_events, 'modelTurns': turns})

consistent = all((p.stat().st_mtime_ns, p.stat().st_size) == version for p, version in read_versions.items())
package = read_json(PACKAGE)
completed = goal_record.get('status') == 'completed' and goal_record.get('goal', {}).get('state') == 'completed'
pending_activities = [activity['id'] for activity in activities if activity.get('status') not in ('completed', 'failed', 'cancelled', 'canceled')]
open_runs = [conversation['conversationId'] for conversation in conversations if any(run['status'] == 'running' for run in conversation['runs'])]
output = {
    'schemaVersion': 1,
    'exportedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
    'provenance': {
        'runtimePackage': {'name': package['name'], 'version': package['version'], 'verification': 'Installed package.json read inside the owned container.'},
        'workspaceId': 'default-workspace',
        'readMethod': 'Read-only Docker exec; explicit field allowlists; no provider requests.',
        'sourcePathsRelativeToWorkspaceDb': ['conversations/<id>.json', 'conversation-logs/<id>.jsonl', 'model-turns/<id>/*.json.gz', 'persona-work-items/<personaId>/*.json', 'persona-activities/<personaId>/*.json', 'persona-memories/<personaId>/*.json', 'models.json (public metadata fields only)'],
        'sourceRecordsStableDuringRead': consistent,
        'scope': 'The first-helper conversation and every conversation referenced by this Maya persona activity store; setup tests outside these conversations are excluded.',
        'compressedDemonstration': True,
        'timingExplanation': 'Day 1, Day 2 and Day 3 are scenario labels for sessions recorded on the same actual UTC date. Per-run duration is measured from run:start to run:done; it excludes setup, reading, owner pauses and is not end-to-end journey duration.',
        'privacy': 'No credentials, full provider requests, internal goal instruction wrappers, instruction contexts, frozen/system prompts, source article body or arbitrary raw tool results.',
        'memoryInterpretation': 'activeAtSnapshot records durable active state. trust and reviewedAt distinguish model inferences, reviewed records and explicit_user corrections. The demo operator reviewed and accepted memories in the UI and corrected final details there.',
        'studyType': 'Agent-operated live software demonstration with operator-reviewed outputs; not a human usability study. Workshop venue, date, attendance and purchasing quantities are demonstration data.',
        'captureObservationsReportedByOperator': ['The Day 3 approval in the original chat was not available to a later goal conversation, which continued to ask for approval. The operator explicitly asked to remember approval, then used Correct in the UI to save the authoritative final quantities as explicit_user memory.', 'A later controller round completed the root goal. An additional operator prompt reconciled the four child tasks with approved final quantities.', 'The completed root goal retained a stale next action mentioning approval. Its completed state and all child task states are exported without rewriting that inconsistency.'],
    },
    'completion': {'rootGoalCompleted': completed, 'goalStatus': goal_record.get('status'), 'goalState': goal_record.get('goal', {}).get('state'), 'pendingActivityIds': pending_activities, 'openRunConversationIds': open_runs, 'incompleteChildTaskIds': [item['id'] for item in work_items if item.get('parentGoalId') == GOAL and item.get('status') != 'completed']},
    'configuredModels': models,
    'providerAccounting': {'usage': tokens(all_usage), 'actualProviderCostUsd': None, 'costStatus': 'not_recorded', 'storedZeroIsPlaceholder': True, 'costEvidence': 'flujo-ai 3.46.2 src/backend/execution/flow/runFlow.ts accumulateUsage emits costUsd: 0.', 'aggregation': 'Each usage event is counted once by conversationId + seq. Conversation/message usage fields are not summed. Cache counts are reported separately and are not added to totalTokens.'},
    'externalSource': {'guideUrl': GUIDE, 'mcpRepository': 'https://github.com/zcaceres/fetch-mcp', 'mcpPackageVersion': '1.1.2'},
    'personaId': PERSONA,
    'goalId': GOAL,
    'conversations': conversations,
    'activities': activities,
    'workItems': work_items,
    'memories': memories,
}
print(json.dumps(output, ensure_ascii=False))
`;

const result = spawnSync('docker', ['exec', '-i', 'kilntainer-agent-workstation-readme', 'python3', '-'], {
  input: collector, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
});
if (result.error || result.status !== 0) {
  // Raw runtime exceptions/records are deliberately not echoed.
  throw new Error(`Read-only collector failed (${result.status ?? 'spawn error'}); no snapshot was written.`);
}
const evidence = JSON.parse(result.stdout);
evidence.provenance.documentationSource = {
  packageVersion: JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8')).version,
  gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim(),
  relationship: 'Documentation checkout revision; it is not the installed runtime build.',
};
const recordedRuns = evidence.conversations.flatMap(conversation => conversation.runs);
const completedRuns = recordedRuns.filter(run => run.completedAtUtc);
const firstRunMs = Math.min(...recordedRuns.map(run => Date.parse(run.startedAtUtc)));
const lastRunMs = Math.max(...completedRuns.map(run => Date.parse(run.completedAtUtc)));
evidence.timingSummary = {
  firstRecordedRunAtUtc: new Date(firstRunMs).toISOString(),
  lastRecordedRunCompletedAtUtc: new Date(lastRunMs).toISOString(),
  measuredRecordedRunWindowMilliseconds: lastRunMs - firstRunMs,
  sumRecordedRunMilliseconds: completedRuns.reduce((sum, run) => sum + run.measuredRunMilliseconds, 0),
  interpretation: 'The recorded-run window includes gaps between runs and excludes installation before the first recorded run. The sum of run durations is processing time, not elapsed journey time.',
};
evidence.editorialDeliverable = {
  file: 'workshop-pack.md',
  sourceConversationId: '8b10b7b3-3f7c-4ddc-9dff-834e63ac87f7',
  sourceAssistantMessageId: 'stream_a302780b-3b19-45dc-b860-0b516f216494',
  sourceTranscriptPreservedUnchangedInJson: true,
  editorialChanges: ['Make extra lead equipment optional throughout.', 'Reconcile wording with operator-approved final tasks and explicit_user memory, including separate labeled decaf.', 'Remove the unsupported claim that the plan was archived.', 'Label logistics as demo data and quantities as operator-approved planning estimates.'],
};

// Defense in depth after allowlisting. Fail without echoing the offending value.
const forbiddenKeys = new Set(['apikey', 'api_key', 'authorization', 'password', 'frozenSystemPrompts', 'instructionContext', 'personaInstructionContext', 'sdkRequest', 'canonicalMessages', 'genericWire', 'trackingInfo']);
function privacyCheck(value) {
  if (typeof value === 'string') {
    if (/(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Advance this ongoing Persona goal autonomously)/.test(value)) {
      throw new Error('Privacy validation failed; no evidence was written.');
    }
  } else if (Array.isArray(value)) {
    value.forEach(privacyCheck);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key) || forbiddenKeys.has(key.toLowerCase())) throw new Error('Forbidden field in evidence; no evidence was written.');
      privacyCheck(child);
    }
  }
}
privacyCheck(evidence);
const inventory = {
  mode, runtimeVersion: evidence.provenance.runtimePackage.version,
  documentationSourceVersion: evidence.provenance.documentationSource.packageVersion,
  sourceRecordsStableDuringRead: evidence.provenance.sourceRecordsStableDuringRead,
  completion: evidence.completion,
  conversations: evidence.conversations.map(c => ({ conversationId: c.conversationId, journey: c.journey,
    ownerPrompts: c.messages.filter(m => m.role === 'user' && m.content).length,
    omittedRuntimePrompts: c.messages.filter(m => m.contentOmitted).length,
    assistantResults: c.messages.filter(m => m.role === 'assistant').length,
    runs: c.runs.length, modelTurns: c.modelTurns.length, usage: c.usage })),
  activities: evidence.activities.length, workItems: evidence.workItems.length,
  memories: evidence.memories.map(m => ({ id: m.id, status: m.status, trust: m.trust, reviewedAtUtc: m.reviewedAtUtc })),
  actualProviderCostUsd: null, costStatus: 'not_recorded', privacyValidation: 'passed',
};
if (mode === '--snapshot') {
  if (!evidence.provenance.sourceRecordsStableDuringRead || !evidence.completion.rootGoalCompleted || evidence.completion.pendingActivityIds.length || evidence.completion.openRunConversationIds.length || evidence.completion.incompleteChildTaskIds.length) {
    throw new Error('Snapshot deferred: wait for a stable, completed goal with no active run/activity.');
  }
  const destination = resolve(directory, 'journey-runtime-evidence.json');
  writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  inventory.outputFile = destination;
}
process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
