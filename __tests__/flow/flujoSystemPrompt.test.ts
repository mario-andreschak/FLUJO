/**
 * FLUJO's own system sections (issue #1231): each section appears only when
 * the step can use what it describes, every section can be left out on its
 * own, and the text stays short.
 */
import {
  FLUJO_SYSTEM_PROMPT_HEADING,
  FLUJO_SYSTEM_PROMPT_SECTION_IDS,
  buildFlujoSystemPrompt,
  estimateFlujoSystemPromptContext,
  normalizeExcludedSystemPromptSections,
  planFlujoSystemPromptSections,
  type FlujoPromptTool,
  type FlujoSystemPromptContext,
} from '@/shared/utils/flujoSystemPrompt';
import { buildDefaultFlujoAgent } from '@/backend/services/flow/defaultAgent';

jest.mock('@/backend/services/flow/index', () => ({ flowService: {} }));

const served = (originalName: string): FlujoPromptTool => ({
  name: `mcp_${originalName}_x1`,
  originalName,
  server: 'flujo',
});
const own = (name: string): FlujoPromptTool => ({ name });

const NOTHING: FlujoSystemPromptContext = { tools: [], handoffs: [], startedByAgent: false };

/** The built-in "FLUJO" agent: one step with its tools, then Finish. */
const DEFAULT_AGENT: FlujoSystemPromptContext = {
  tools: [
    own('handoff_to_finish'),
    { name: 'mcp_read_file_x1', originalName: 'read_file', server: 'filesystem' },
    ...['list_models', 'list_flows', 'read_flow', 'execute_flow', 'list_conversations',
      'list_mcp_servers', 'list_mcp_server_tools', 'call_mcp_tool', 'discover_capabilities'].map(served),
    own('read_resource'),
    own('list_mcp_resources'),
  ],
  handoffs: [{ name: 'handoff_to_finish', targetType: 'finish' }],
  startedByAgent: false,
};

/** Every capability at once. */
const EVERYTHING: FlujoSystemPromptContext = {
  tools: [
    own('handoff_to_writer'),
    own('handoff_to_review'),
    own('handoff_to_finish'),
    own('call_subflow_research'),
    own('start_subflow_research'),
    own('subflow_task_get'),
    own('subflow_task_cancel'),
    own('subflow_list'),
    own('subflow_send_message'),
    own('subflow_wait'),
    own('question'),
    own('read_resource'),
    ...['discover_capabilities', 'list_mcp_server_tools', 'call_mcp_tool', 'list_conversations',
      'read_conversation', 'kv_get', 'kv_set', 'list_flows', 'execute_flow', 'create_ticket_for_human'].map(served),
  ],
  handoffs: [
    { name: 'handoff_to_writer', targetType: 'process' },
    { name: 'handoff_to_review', targetType: 'human' },
    { name: 'handoff_to_finish', targetType: 'finish' },
  ],
  startedByAgent: true,
};

const SECTION_HEADINGS = {
  workflow: '## Workflow',
  agents: '## Other agents',
  people: '## People',
  flujoTools: '## FLUJO tools',
  storedResults: '## Stored results',
} as const;

const approxTokens = (text: string) => Math.ceil(text.length / 4);

/** Kept word for word from the earlier block: recorded provider runs back them. */
const BASIC_RULES = [
  'You are an AI agent in FLUJO. The flow author\'s instructions take priority over this section.',
  'Answer the current user request, then stop. Do not invent future user messages, observations or review rounds. If processing returns to you in a loop, use the latest actual input and completed-action evidence; do not repeat completed actions.',
  'For a requested identifier, select the exact ID field from its source record. Match the record to the requested entity and preserve the field\'s value and type. Return a full record only when requested.',
];

describe('FLUJO system prompt sections', () => {
  it('gives a step without tools only the basic rules, and no multi-agent claims', () => {
    expect(buildFlujoSystemPrompt(NOTHING)).toBe([
      FLUJO_SYSTEM_PROMPT_HEADING,
      ...BASIC_RULES,
      '',
      '',
    ].join('\n'));
  });

  it('tells the built-in agent about its real tools and never about other agents', () => {
    const text = buildFlujoSystemPrompt(DEFAULT_AGENT);
    expect(text).toBe([
      FLUJO_SYSTEM_PROMPT_HEADING,
      ...BASIC_RULES,
      'You may do multiple tool calls.',
      '',
      '## Workflow',
      '- When a user requests an answer, provide the requested response before handing off to Finish, in the requested format. A Finish handoff alone is not an answer.',
      '',
      '## FLUJO tools',
      '- Missing a tool: `mcp_discover_capabilities_x1` searches all servers and flows, `mcp_list_mcp_server_tools_x1` lists a server\'s tools, `mcp_call_mcp_tool_x1` calls a tool on any server.',
      '- Other conversations (earlier runs, other agents): `mcp_list_conversations_x1` lists them.',
      '- Other agents (flows): `mcp_list_flows_x1` lists them, `mcp_execute_flow_x1` runs one and returns its answer.',
      '',
      '## Stored results',
      '- A long tool result may be replaced by a `flujo://run/…` link. Read it with `read_resource` instead of running the tool again.',
      '',
      '',
    ].join('\n'));
    expect(text).not.toContain('workflow with other agents');
    expect(text).not.toContain(SECTION_HEADINGS.agents);
    expect(text).not.toContain(SECTION_HEADINGS.people);
    expect(text).not.toContain('read_conversation');
    expect(text).not.toContain('kv_');
  });

  it('describes a multi-agent step: other steps, sub-agents, messages and its parent', () => {
    const plan = planFlujoSystemPromptSections(EVERYTHING);
    expect(plan.workflow.join('\n')).toContain('You are one step in a workflow with other agents');
    expect(plan.workflow.join('\n')).toContain('`handoff_to_writer`, `handoff_to_review` or `handoff_to_finish`');
    expect(plan.agents).toEqual([
      '## Other agents',
      '- Run a sub-agent and wait for its result: `call_subflow_research`.',
      '- Start a sub-agent in the background and keep working: `start_subflow_research`.',
      '- Give each sub-agent a complete task. Use sub-agents for separate or parallel work; do small tasks yourself.',
      '- Background work: `subflow_task_get` shows its status and result, `subflow_task_cancel` stops it.',
      '- Talk with your parent and child agents: `subflow_list` lists them, `subflow_send_message` sends one a message, `subflow_wait` waits for a reply or result (instead of polling).',
      '- Another agent started you and receives your final answer. To ask it something or report progress before you finish, use `subflow_send_message` with target "parent".',
    ]);
    expect(plan.people).toEqual([
      '## People',
      '- When you need the user to decide something, ask with `question` and continue with the answer, instead of guessing or ending your turn.',
      '- Hand the work to a person and wait for their answer: `handoff_to_review`.',
      '- Leave a ticket for a person without waiting for an answer: `mcp_create_ticket_for_human_x1`.',
    ]);
    expect(plan.flujoTools.join('\n')).toContain('`mcp_read_conversation_x1` reads one');
    expect(plan.flujoTools.join('\n')).toContain('`mcp_kv_get_x1` reads, `mcp_kv_set_x1` saves');
  });

  it('names the hand-off tools of a step that has more than Finish to go to', () => {
    const workflow = planFlujoSystemPromptSections({
      ...NOTHING,
      tools: [own('handoff_to_done'), own('handoff_to_alert')],
      handoffs: [
        { name: 'handoff_to_done', targetType: 'finish' },
        { name: 'handoff_to_alert', targetType: 'signal' },
      ],
    }).workflow;
    expect(workflow[1]).toBe('- When your part is done, you can hand off with `handoff_to_done` or `handoff_to_alert`.');
    expect(workflow.join('\n')).not.toContain('other agents');
  });

  it('shortens long lists of hand-offs', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'].map((slug) => `handoff_to_${slug}`);
    const workflow = planFlujoSystemPromptSections({
      tools: names.map(own),
      handoffs: names.map((name) => ({ name, targetType: 'process' })),
      startedByAgent: false,
    }).workflow;
    expect(workflow[2]).toBe('- When your part is done, you can hand off with `handoff_to_a`, `handoff_to_b`, `handoff_to_c`, `handoff_to_d` or 2 more.');
  });

  it('reports to a parent even without the message tools', () => {
    expect(planFlujoSystemPromptSections({ ...NOTHING, startedByAgent: true }).agents).toEqual([
      '## Other agents',
      '- Another agent started you and receives your final answer.',
    ]);
  });

  it('never matches a FLUJO tool name served by FLUJO itself to an MCP tool or the other way round', () => {
    const plan = planFlujoSystemPromptSections({
      ...NOTHING,
      tools: [
        { name: 'mcp_question_x1', originalName: 'question', server: 'other' },
        own('read_conversation'),
      ],
    });
    expect(plan.people).toEqual([]);
    expect(plan.flujoTools).toEqual([]);
  });

  it.each(FLUJO_SYSTEM_PROMPT_SECTION_IDS)('leaves out the %s section, and only that one, when it is excluded', (section) => {
    const full = planFlujoSystemPromptSections(EVERYTHING);
    const text = buildFlujoSystemPrompt(EVERYTHING, [section]);
    for (const id of FLUJO_SYSTEM_PROMPT_SECTION_IDS) {
      const body = full[id].join('\n');
      expect(body).not.toBe('');
      if (id === section) expect(text).not.toContain(body);
      else expect(text).toContain(body);
    }
  });

  it('adds nothing when every section is excluded or none applies', () => {
    expect(buildFlujoSystemPrompt(EVERYTHING, FLUJO_SYSTEM_PROMPT_SECTION_IDS)).toBe('');
    expect(buildFlujoSystemPrompt(NOTHING, ['basics'])).toBe('');
  });

  it('keeps the text small', () => {
    // The single block it replaces cost about 270 tokens on every step.
    expect(approxTokens(buildFlujoSystemPrompt(NOTHING))).toBeLessThanOrEqual(150);
    expect(approxTokens(buildFlujoSystemPrompt(DEFAULT_AGENT))).toBeLessThanOrEqual(340);
    expect(approxTokens(buildFlujoSystemPrompt(EVERYTHING))).toBeLessThanOrEqual(720);
  });

  it('keeps only known section ids in their fixed order', () => {
    expect(normalizeExcludedSystemPromptSections(['people', 'nope', 'basics', 'people', 7])).toEqual(['basics', 'people']);
    expect(normalizeExcludedSystemPromptSections('basics')).toEqual([]);
    expect(normalizeExcludedSystemPromptSections(undefined)).toEqual([]);
  });
});

describe('design-time estimate from the flow graph', () => {
  const flow = {
    nodes: [
      { id: 'start', type: 'start', data: { label: 'Start', type: 'start' } },
      {
        id: 'p1',
        type: 'process',
        data: {
          label: 'Planner',
          type: 'process',
          properties: {
            allowQuestion: true,
            mcpNodes: [{ properties: { boundServer: 'flujo', enabledTools: ['read_conversation'] } }],
          },
        },
      },
      { id: 'p2', type: 'process', data: { label: 'Writer', type: 'process' } },
      { id: 's1', type: 'subflow', data: { label: 'Research', type: 'subflow' } },
      { id: 'h1', type: 'human', data: { label: 'Review', type: 'human' } },
      { id: 'f1', type: 'finish', data: { label: 'Finish', type: 'finish' } },
      { id: 'm1', type: 'mcp', data: { label: 'flujo', type: 'mcp' } },
    ],
    edges: [
      { source: 'start', target: 'p1' },
      { source: 'p1', target: 's1' },
      { source: 'p1', target: 'h1' },
      { source: 'p1', target: 'f1' },
      { source: 'p2', target: 'p1', data: { bidirectional: true } },
      { source: 'p1', target: 'm1', data: { edgeType: 'mcp' } },
    ],
  };

  it('finds hand-offs, sub-agents, people and bound FLUJO tools', () => {
    const context = estimateFlujoSystemPromptContext(flow, 'p1');
    expect(context.handoffs).toEqual([
      { name: 'handoff_to_research', targetType: 'subflow' },
      { name: 'handoff_to_review', targetType: 'human' },
      { name: 'handoff_to_finish', targetType: 'finish' },
      { name: 'handoff_to_writer', targetType: 'process' },
    ]);
    const plan = planFlujoSystemPromptSections(context);
    expect(plan.agents.join('\n')).toContain('`call_subflow_research`');
    expect(plan.agents.join('\n')).toContain('`start_subflow_research`');
    expect(plan.people.join('\n')).toContain('`question`');
    expect(plan.people.join('\n')).toContain('`handoff_to_review`');
    expect(plan.flujoTools.join('\n')).toContain('`read_conversation` reads one');
    expect(plan.storedResults).not.toEqual([]);
  });

  it('reads apps wired to the step by edges, as the built-in agent is saved (#1231)', () => {
    const saved = buildDefaultFlujoAgent();
    const step = saved.nodes.find((node) => node.type === 'process')!;
    expect(step.data.properties?.mcpNodes).toBeUndefined();
    const plan = planFlujoSystemPromptSections(estimateFlujoSystemPromptContext(saved, step.id));
    expect(plan.flujoTools.join('\n')).toContain('`discover_capabilities` searches all servers and flows');
    expect(plan.flujoTools.join('\n')).toContain('`execute_flow` runs one and returns its answer');
    expect(plan.storedResults).not.toEqual([]);
    expect(plan.workflow.join('\n')).not.toContain('workflow with other agents');
  });

  it('counts an app listed on the step and wired by an edge once', () => {
    const wired = {
      nodes: [
        { id: 'p', type: 'process', data: { properties: { mcpNodes: [{ id: 'm', properties: { boundServer: 'flujo', enabledTools: ['kv_get'] } }] } } },
        { id: 'm', type: 'mcp', data: { properties: { boundServer: 'flujo', enabledTools: ['kv_get'] } } },
      ],
      edges: [{ source: 'p', target: 'm', data: { edgeType: 'mcp' } }],
    };
    expect(estimateFlujoSystemPromptContext(wired, 'p').tools).toEqual([
      { name: 'read_resource' },
      { name: 'kv_get', originalName: 'kv_get', server: 'flujo' },
    ]);
  });

  it('gives an unknown node only the basic rules', () => {
    expect(planFlujoSystemPromptSections(estimateFlujoSystemPromptContext(flow, 'missing')).workflow).toEqual([]);
    expect(estimateFlujoSystemPromptContext(null, 'p1')).toEqual(NOTHING);
  });
});
