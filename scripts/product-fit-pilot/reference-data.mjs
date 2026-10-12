import { createHash, randomUUID } from 'node:crypto';

export const REFERENCE_VERSION = '1.0.0';
export const REFERENCE_RECEIPT_URI = 'fixture://product-fit/reference-receipt';
const RECEIPT_LIMIT = 64;
const sha256 = value => createHash('sha256').update(value).digest('hex');
export function referenceJson(value) {
  return JSON.stringify(value, (_key, current) => current !== null && typeof current === 'object' && !Array.isArray(current) ?
    Object.fromEntries(Object.keys(current).sort().map(key => [key, current[key]])) : current);
}
export const referenceJsonSha256 = value => sha256(referenceJson(value));

function freeze(value) {
  Object.values(value).forEach(child => {
    if (child !== null && typeof child === 'object') freeze(child);
  });
  return Object.freeze(value);
}

const annotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false,
};
function tool(name, description, parameter, choices) {
  return {
    name, description, annotations,
    inputSchema: {
      type: 'object', additionalProperties: false, required: [parameter],
      properties: { [parameter]: { type: 'string', enum: choices } },
    },
  };
}

// No supplied paths, URLs, commands or credentials can enter these tools.
export const REFERENCE_TOOLS = freeze([
  tool('product_fit_inbox', 'Read a synthetic inbox for a triage task. No real account is accessed.', 'queue', ['weekly']),
  tool('product_fit_document', 'Read one of two synthetic project documents to compare their declared rules.', 'document', ['overview', 'deployment']),
  tool('product_fit_page', 'Read a captured synthetic catalog or status page. This does not fetch a website.', 'page', ['catalog', 'status']),
]);

const DATA = freeze({
  product_fit_inbox: {
    weekly: {
      items: [
        { id: 'notice-01', priority: 'normal', state: 'open', subject: 'Archive the meeting summary' },
        { id: 'notice-02', priority: 'urgent', state: 'open', subject: 'Review the changed test schedule' },
        { id: 'notice-03', priority: 'urgent', state: 'archived', subject: 'Completed access review' },
        { id: 'notice-04', priority: 'high', state: 'open', subject: 'Update the draft glossary' },
        { id: 'notice-05', priority: 'urgent', state: 'open', subject: 'Confirm the reference checklist' },
        { id: 'notice-06', priority: 'normal', state: 'archived', subject: 'Old synthetic reminder' },
      ],
    },
  },
  product_fit_document: {
    overview: { title: 'Synthetic project overview', minimumNodeMajor: 22, port: 4200, storage: 'local-only' },
    deployment: { title: 'Synthetic deployment note', minimumNodeMajor: 20, port: 4200, storage: 'local-only' },
  },
  product_fit_page: {
    catalog: { title: 'Captured synthetic catalog', items: [
      { id: 'blue-notebook', listed: true }, { id: 'green-kit', listed: true }, { id: 'silver-pen', listed: false },
    ] },
    status: { title: 'Captured synthetic status page', items: [
      { id: 'blue-notebook', available: false }, { id: 'green-kit', available: true }, { id: 'silver-pen', available: true },
    ] },
  },
});

export const REFERENCE_DEFINITION_SHA256 = referenceJsonSha256({
  version: REFERENCE_VERSION, tools: REFERENCE_TOOLS, data: DATA,
});

export function createReferenceState() {
  const runId = randomUUID();
  let toolCalls = 0;
  let acceptedCalls = 0;
  const recentCalls = [];
  const byTool = Object.fromEntries(REFERENCE_TOOLS.map(definition => [definition.name, 0]));

  function call(name, args) {
    const definition = REFERENCE_TOOLS.find(candidate => candidate.name === name);
    const parameter = definition?.inputSchema.required[0];
    const valid = definition && args !== null && typeof args === 'object' && !Array.isArray(args) &&
      Object.keys(args).length === 1 && Object.hasOwn(args, parameter) &&
      definition.inputSchema.properties[parameter].enum.includes(args[parameter]);
    const errorCode = !definition ? 'unknown-tool' : valid ? null : 'invalid-arguments';
    const sequence = ++toolCalls;
    let structuredContent;
    if (valid) {
      acceptedCalls += 1;
      byTool[name] += 1;
      structuredContent = {
        synthetic: true, runId, definitionSha256: REFERENCE_DEFINITION_SHA256,
        tool: name, selection: args[parameter], sequence,
        receiptPhrase: `reference-${randomUUID()}`,
        value: structuredClone(DATA[name][args[parameter]]),
      };
    } else {
      structuredContent = {
        synthetic: true, runId, definitionSha256: REFERENCE_DEFINITION_SHA256, sequence, errorCode,
      };
    }
    recentCalls.push({
      sequence, observedAt: new Date().toISOString(), tool: definition ? name : 'unknown', accepted: Boolean(valid),
      errorCode, argumentsSha256: valid ? referenceJsonSha256(args) : null,
      resultSha256: referenceJsonSha256(structuredContent),
      receiptPhraseSha256: valid ? sha256(structuredContent.receiptPhrase) : null,
    });
    if (recentCalls.length > RECEIPT_LIMIT) recentCalls.shift();
    return {
      ...(valid ? {} : { isError: true }),
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent,
    };
  }

  function receipt() {
    return {
      schemaVersion: 1, synthetic: true, fixtureVersion: REFERENCE_VERSION, runId,
      definitionSha256: REFERENCE_DEFINITION_SHA256, toolCalls, acceptedCalls,
      rejectedCalls: toolCalls - acceptedCalls, byTool: { ...byTool },
      retainedCallLimit: RECEIPT_LIMIT, droppedCalls: toolCalls - recentCalls.length,
      recentCalls: structuredClone(recentCalls),
      claims: { installedFlujo: false, modelReply: false, humanObservation: false, recurringBenefit: false },
    };
  }
  return { call, receipt };
}
