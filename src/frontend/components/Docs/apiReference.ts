/**
 * Curated reference for FLUJO's HTTP API surface (#5).
 *
 * Hand-maintained (not generated) so each endpoint carries a human summary,
 * its parameters, and its response shape. SECURITY: this content is rendered in
 * the browser — never document request/response fields that would leak secrets
 * (API keys, encryption passwords, OAuth tokens). Endpoints that handle secrets
 * carry an explicit note instead.
 */
import { FLOWSPEC_DOC } from '@/utils/shared/flowSpecDoc';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface ApiParam {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

export interface ApiEndpoint {
  method: HttpMethod;
  /** Additional methods served by the same handler (shown as extra chips). */
  alsoMethods?: HttpMethod[];
  path: string;
  summary: string;
  /** Label for the `params` list, e.g. "Body" or "Query". */
  paramsLabel?: 'Body' | 'Query' | 'Form data';
  params?: ApiParam[];
  /** Short description of the success response shape. */
  response?: string;
  /** Caveats — especially secret-handling notes. */
  notes?: string[];
  /**
   * Long-form reference text (e.g. a request-format specification), rendered as a
   * preformatted monospace block below the endpoint.
   */
  details?: string;
}

export interface ApiGroup {
  id: string;
  name: string;
  description: string;
  endpoints: ApiEndpoint[];
}

export const API_GROUPS: ApiGroup[] = [
  {
    id: 'openai',
    name: 'Chat — OpenAI-compatible',
    description:
      'A drop-in OpenAI-compatible surface. In OpenAI-compatible clients (Roo Code, Cline, Cursor, the OpenAI SDK, …) set the Base URL to this instance + "/v1" (e.g. http://localhost:4200/v1) and the model to a flow id (format flow-<NAME>, as listed by /v1/models).',
    endpoints: [
      {
        method: 'POST',
        alsoMethods: ['GET', 'OPTIONS'],
        path: '/v1/chat/completions',
        summary:
          'OpenAI-compatible chat completion. Runs a FLUJO flow as the model. Supports streaming and non-streaming. CORS-enabled; rate-limited (~6000 req/min).',
        paramsLabel: 'Body',
        params: [
          { name: 'model', type: 'string', required: true, description: 'Flow to run, as flow-<NAME>.' },
          { name: 'messages', type: 'ChatMessage[]', required: true, description: 'Conversation messages (OpenAI shape).' },
          { name: 'stream', type: 'boolean', description: 'Stream the response as SSE chunks.' },
          { name: 'flujo', type: 'boolean', description: 'Enable FLUJO-specific behavior.' },
          { name: 'conversation_id', type: 'string', description: 'Reuse/continue an existing conversation.' },
          { name: 'requireApproval', type: 'boolean', description: 'Pause for manual tool-call approval.' },
          { name: 'flujodebug', type: 'boolean', description: 'Run in the visual debugger (single-step).' },
        ],
        response: 'OpenAI ChatCompletion object, or an SSE stream of chunks when stream=true.',
      },
      {
        method: 'GET',
        path: '/v1/models',
        summary: 'List all flows as OpenAI-style models.',
        response: '{ object: "list", data: [{ id: "flow-<NAME>", object: "model" }, ...] }',
      },
    ],
  },
  {
    id: 'conversations',
    name: 'Conversations & Execution',
    description:
      'Manage conversations and drive flow execution: live event streaming (SSE), tool-call approval, cancellation, and visual-debugger stepping.',
    endpoints: [
      {
        method: 'GET',
        path: '/v1/chat/conversations',
        summary: 'List all conversations (id, title, flowId, createdAt, updatedAt, status), newest first.',
        response: 'Conversation summary array.',
      },
      {
        method: 'POST',
        path: '/v1/chat/conversations',
        summary: 'Create a new conversation and initialize its execution state.',
        paramsLabel: 'Body',
        params: [
          { name: 'id', type: 'string', required: true, description: 'Client-generated conversation id.' },
          { name: 'title', type: 'string', required: true, description: 'Display title.' },
          { name: 'flowId', type: 'string', required: true, description: 'Flow bound to this conversation.' },
          { name: 'createdAt', type: 'number', required: true, description: 'Unix ms timestamp.' },
          { name: 'updatedAt', type: 'number', required: true, description: 'Unix ms timestamp.' },
        ],
      },
      {
        method: 'GET',
        alsoMethods: ['PATCH', 'DELETE'],
        path: '/v1/chat/conversations/{conversationId}',
        summary:
          'GET the displayed conversation (messages + metadata); PATCH updates flowId; DELETE removes the conversation and its event log.',
        paramsLabel: 'Body',
        params: [{ name: 'flowId', type: 'string', description: 'New flow id (PATCH only).' }],
        response:
          'Conversation with messages, plus usage (token totals, per-node breakdown), status, and contextInfo (latest prompt-token count + the bound model\'s context window — what the chat token counter and context meter display).',
        notes: [
          'Messages are a projection of the append-only conversation log when one exists (legacy conversations without a log are served as stored). Node system prompts are never included.',
          'Subflow steps appear inline as depth-tagged, display-only messages (nested in the chat UI); they are never part of the parent\'s model context.',
        ],
      },
      {
        method: 'GET',
        path: '/v1/chat/conversations/{conversationId}/events',
        summary:
          'Server-Sent Events stream of execution events (node:enter/exit, message, usage, run:*). Supports Last-Event-ID reconnect.',
        paramsLabel: 'Query',
        params: [{ name: 'fromSeq', type: 'number', description: 'Replay events from this sequence number.' }],
        response: 'text/event-stream of ExecutionEvent objects with monotonic seq ids.',
      },
      {
        method: 'POST',
        path: '/v1/chat/conversations/{conversationId}/respond',
        summary: 'Approve or reject a pending tool call; resumes execution when all pending calls are handled.',
        paramsLabel: 'Body',
        params: [
          { name: 'action', type: '"approve" | "reject"', required: true, description: 'Decision for the tool call.' },
          { name: 'toolCallId', type: 'string', required: true, description: 'Which pending tool call.' },
        ],
      },
      {
        method: 'POST',
        path: '/v1/chat/conversations/{conversationId}/cancel',
        summary: 'Request cancellation of an in-progress run (sets the isCancelled flag).',
      },
      {
        method: 'PUT',
        path: '/v1/chat/conversations/{conversationId}/breakpoints',
        summary: 'Set the visual-debugger breakpoint node ids.',
        paramsLabel: 'Body',
        params: [{ name: 'breakpoints', type: 'string[]', required: true, description: 'Node ids to break on.' }],
      },
      {
        method: 'POST',
        path: '/v1/chat/conversations/{conversationId}/debug/step',
        summary: 'Execute exactly one productive step (only when status is paused_debug); pauses after advancing.',
      },
      {
        method: 'POST',
        path: '/v1/chat/conversations/{conversationId}/debug/continue',
        summary: 'Resume a debug session — run freely to the next pause, tool approval, or completion.',
      },
      {
        method: 'PATCH',
        path: '/v1/chat/conversations/{conversationId}/edit-state',
        summary: 'Edit paused debug state (a message\'s content, or the next node to run). Only when paused_debug.',
        paramsLabel: 'Body',
        params: [
          { name: 'messageId', type: 'string', description: 'Message to edit.' },
          { name: 'content', type: 'string', description: 'New message content.' },
          { name: 'currentNodeId', type: 'string', description: 'Override the next node.' },
        ],
      },
    ],
  },
  {
    id: 'model',
    name: 'Models',
    description: 'CRUD for model configurations and provider model discovery. API keys are encrypted at rest and never returned to the browser in clear text.',
    endpoints: [
      {
        method: 'GET',
        alsoMethods: ['POST'],
        path: '/api/model',
        summary: 'GET lists all models; POST creates a model (409 on duplicate name, 201 on success).',
        paramsLabel: 'Body',
        params: [{ name: 'model', type: 'Model', required: true, description: 'Model config (POST). Secrets are stored encrypted.' }],
        notes: ['Stored API keys are masked before reaching the frontend — never expect a clear-text key in a response.'],
      },
      {
        method: 'GET',
        alsoMethods: ['PUT', 'DELETE'],
        path: '/api/model/{id}',
        summary: 'GET / PUT / DELETE a single model. The path id is authoritative on PUT. DELETE returns 204.',
      },
      {
        method: 'POST',
        path: '/api/model/provider',
        summary: 'Fetch available models from a provider, using a supplied or stored API key (resolved server-side).',
        paramsLabel: 'Body',
        params: [
          { name: 'baseUrl', type: 'string', required: true, description: 'Provider base URL.' },
          { name: 'modelId', type: 'string', description: 'Existing model whose stored key to reuse.' },
          { name: 'searchTerm', type: 'string', description: 'Filter the returned model list.' },
        ],
        notes: ['Accepts an apiKey only inbound to query the provider; keys are never echoed back to the client.'],
      },
    ],
  },
  {
    id: 'flow',
    name: 'Flows',
    description:
      'CRUD for flow definitions, programmatic flow authoring (FlowSpec), LLM flow generation, and prompt rendering for individual nodes. For creating flows programmatically, prefer POST /api/flow/compile with a FlowSpec — the raw Flow format (ReactFlow JSON) is the internal canvas representation and easy to get subtly wrong.',
    endpoints: [
      {
        method: 'POST',
        path: '/api/flow/compile',
        summary:
          'Compile a FlowSpec (the semantic authoring format — see below) into a complete flow, validate it, and optionally save it. Deterministic, no LLM: layout, ids, handles, and MCP wiring are generated for you. THE recommended way for external apps and agents to create flows. Also exposed as MCP tools (create_flow / validate_flow_spec) on /mcp-flows.',
        paramsLabel: 'Body',
        params: [
          { name: 'spec', type: 'FlowSpec', required: true, description: 'The flow specification (format below).' },
          { name: 'save', type: 'boolean', description: 'Persist the flow — only happens when validation finds ZERO errors.' },
        ],
        response: '{ flow, validation: { issues, errorCount, warningCount, isRunnable }, saved } — 201 when saved, 200 otherwise. Iterate on the issues until clean.',
        details: FLOWSPEC_DOC,
      },
      {
        method: 'POST',
        path: '/api/flow/generate',
        summary:
          'Generate a draft flow from a natural-language description using one of your configured models. The model authors a FlowSpec, FLUJO compiles + validates it and feeds problems back for a bounded number of repair rounds. The generator can always SEARCH the public MCP registry; with allowInstall it can also INSTALL servers it needs. Returns an UNSAVED draft (the UI opens it in the builder for review); persist via the normal save path or /api/flow/compile.',
        paramsLabel: 'Body',
        params: [
          { name: 'description', type: 'string', required: true, description: 'What the flow should do, in plain language.' },
          { name: 'modelId', type: 'string', required: true, description: 'Configured model that does the generating.' },
          { name: 'maxRepairs', type: 'number', description: 'Repair rounds after the first attempt (default 1, max 2).' },
          { name: 'allowInstall', type: 'boolean', description: 'Let the generator install MCP servers from the public registry (downloads + RUNS third-party packages on this machine). Off by default.' },
        ],
        response: '{ flow, validation, attempts, installedServers } — the flow is a draft; nothing flow-related is persisted by this endpoint (installed servers ARE persisted).',
        notes: ['allowInstall executes third-party code with this machine\'s user permissions — opt in deliberately.'],
      },
      {
        method: 'GET',
        alsoMethods: ['POST'],
        path: '/api/flow',
        summary: 'GET lists all flow definitions; POST creates a flow (create-only; 409 if the id exists). POST takes the raw internal Flow format — prefer /api/flow/compile for programmatic creation.',
        paramsLabel: 'Body',
        params: [{ name: 'flow', type: 'Flow', required: true, description: 'Flow object including id (POST).' }],
      },
      {
        method: 'GET',
        alsoMethods: ['PUT', 'DELETE'],
        path: '/api/flow/{id}',
        summary: 'GET / PUT / DELETE a single flow. On PUT the path id wins over the body id (404 if missing).',
      },
      {
        method: 'POST',
        path: '/api/flow/prompt-renderer',
        summary: 'Render the assembled prompt for a node within a flow.',
        paramsLabel: 'Body',
        params: [
          { name: 'flowId', type: 'string', required: true, description: 'Flow containing the node.' },
          { name: 'nodeId', type: 'string', required: true, description: 'Node to render.' },
          { name: 'options', type: 'object', description: 'Render options.' },
        ],
      },
    ],
  },
  {
    id: 'planned-executions',
    name: 'Planned Executions',
    description:
      'Run flows headlessly on triggers: schedules (cron), inbound webhooks, and more. Managed from the Executions page; each run is recorded in a per-execution run history.',
    endpoints: [
      {
        method: 'GET',
        alsoMethods: ['POST', 'PATCH'],
        path: '/api/planned-executions',
        summary:
          'GET lists all planned executions with live trigger status and last run; POST creates one; PATCH toggles the global pause switch ({ paused: boolean }).',
        response: 'GET: { paused, executions: [{ execution, status, lastRun }] }.',
      },
      {
        method: 'GET',
        alsoMethods: ['PATCH', 'DELETE'],
        path: '/api/planned-executions/{id}',
        summary:
          'GET / PATCH / DELETE a single planned execution. PATCH takes a partial config and re-arms the trigger.',
      },
      {
        method: 'POST',
        path: '/api/planned-executions/{id}/run',
        summary: 'Run now: fire the execution immediately (even while disabled or paused) and wait for the run.',
        response: '{ record: RunRecord } with status, output preview, and token usage.',
      },
      {
        method: 'GET',
        path: '/api/planned-executions/{id}/runs',
        summary: 'The execution’s run history (newest 100 runs, oldest first).',
      },
      {
        method: 'POST',
        path: '/api/planned-executions/preview-schedule',
        summary: 'Validate a cron pattern and preview its next fire times (editor helper).',
        paramsLabel: 'Body',
        params: [
          { name: 'cron', type: 'string', required: true, description: 'Cron pattern (5 or 6 fields).' },
          { name: 'timezone', type: 'string', description: 'IANA timezone name.' },
        ],
        response: '{ valid, error?, nextRuns: string[] }.',
      },
      {
        method: 'POST',
        path: '/api/webhooks/{id}',
        summary:
          'Inbound webhook trigger. Fires the planned execution with the request body as trigger context and responds 202 { runId } immediately (the flow runs in the background). For a synchronous answer use /v1/chat/completions instead.',
        paramsLabel: 'Query',
        params: [
          {
            name: 'token',
            type: 'string',
            required: true,
            description: 'Per-execution secret (alternatively send the X-Flujo-Token header).',
          },
        ],
        notes: [
          'Localhost-only by default; external callers must be explicitly allowed per execution.',
          'The webhook body is untrusted input to the flow — prompts should treat it as data.',
        ],
      },
    ],
  },
  {
    id: 'mcp',
    name: 'MCP Servers',
    description: 'Manage MCP server configurations, connection state, tool discovery, and tool invocation.',
    endpoints: [
      {
        method: 'GET',
        alsoMethods: ['POST'],
        path: '/api/mcp/servers',
        summary: 'GET lists all MCP server configs; POST registers a new one (409 on duplicate name).',
        paramsLabel: 'Body',
        params: [{ name: 'config', type: 'MCPServerConfig', required: true, description: 'Server config (POST).' }],
      },
      {
        method: 'GET',
        alsoMethods: ['PUT', 'DELETE'],
        path: '/api/mcp/servers/{name}',
        summary:
          'GET / PUT / DELETE a server config. PUT merges fields; toggling disabled connects/disconnects; a new name triggers a validated rename.',
      },
      {
        method: 'GET',
        path: '/api/mcp/servers/{name}/status',
        summary: 'Live connection status. Always 200, even when the server is down.',
        response: '{ status, ... }',
      },
      {
        method: 'GET',
        path: '/api/mcp/servers/{name}/tools',
        summary: 'List tools exposed by a connected server.',
        response: '{ tools, error? } (empty tools + error when disconnected).',
      },
      {
        method: 'POST',
        path: '/api/mcp/servers/{name}/tools/{toolName}',
        summary: 'Invoke a tool on a server. Status may reflect the tool itself (408 on timeout).',
        paramsLabel: 'Body',
        params: [
          { name: 'args', type: 'Record<string, unknown>', required: true, description: 'Tool arguments.' },
          { name: 'timeout', type: 'number', description: 'Optional timeout (ms).' },
        ],
      },
      {
        method: 'POST',
        path: '/api/mcp/test-connection',
        summary: 'Run a real MCP handshake against an unsaved config (tests custom CAs and headers) without registering it.',
        paramsLabel: 'Body',
        params: [{ name: 'config', type: 'MCPServerConfig', required: true, description: 'Config to test.' }],
      },
      {
        method: 'POST',
        path: '/api/mcp/cancel',
        summary: 'Cancel an in-progress tool execution; force-reconnects if no token is supplied.',
        paramsLabel: 'Body',
        params: [{ name: 'reason', type: 'string', required: true, description: 'Cancellation reason.' }],
      },
    ],
  },
  {
    id: 'mcp-proxy',
    name: 'FLUJO as an MCP server (proxy)',
    description:
      'Re-expose a configured MCP server to EXTERNAL MCP clients (Claude Desktop, Cursor, Cline, mcp-inspector, …) so you configure the server once in FLUJO and reach it everywhere. Enable per server via the "Expose to external apps" toggle on its card. In your MCP client, add a Streamable-HTTP server with the URL below. One downstream server per endpoint, so tool names are unchanged. Localhost-only for now (no auth token in this version — see the security roadmap).',
    endpoints: [
      {
        method: 'POST',
        alsoMethods: ['GET', 'DELETE'],
        path: '/mcp-proxy/{server}',
        summary:
          'A Streamable-HTTP MCP endpoint that forwards tools/list and tools/call to the named downstream MCP server. {server} is the configured server name; it must have "Expose to external apps" enabled (otherwise 404). Rejects non-localhost requests.',
        response: 'MCP JSON-RPC over Streamable HTTP (handled by your MCP client, not called directly).',
      },
    ],
  },
  {
    id: 'mcp-flows',
    name: 'FLUJO as an MCP server (flows + authoring)',
    description:
      'A Streamable-HTTP MCP endpoint that exposes FLUJO itself to external MCP clients. Every saved flow is a callable tool (running it ephemerally and returning its output), and three authoring tools let an external agent CREATE flows by sending a semantic FlowSpec — no raw ReactFlow JSON required. Localhost-only (same posture as the proxy).',
    endpoints: [
      {
        method: 'POST',
        alsoMethods: ['GET', 'DELETE'],
        path: '/mcp-flows',
        summary:
          'MCP server with two tool families. Flow tools: one per saved flow (name = slug of the flow name; input = a single "input" string sent as the user turn; runs are ephemeral and never appear in the chat sidebar). Authoring tools: list_flow_building_blocks (models, MCP servers + tools, and existing flows a spec may reference — call first), validate_flow_spec (compile + validate without saving; iterate on the returned issues), create_flow (compile + validate + save; only saves when validation finds zero errors), plus capability acquisition: search_mcp_marketplace (search the public registry) and install_mcp_server (install + connect a registry server — downloads and RUNS third-party packages on the FLUJO host; required keys can be passed via its env argument). The FlowSpec format is documented on POST /api/flow/compile above and inside the tools\' own descriptions.',
        response: 'MCP JSON-RPC over Streamable HTTP (handled by your MCP client, not called directly).',
      },
    ],
  },
  {
    id: 'oauth',
    name: 'OAuth (for MCP)',
    description: 'OAuth authorization flow for MCP servers that require it. Tokens are stored server-side and never sent to the browser.',
    endpoints: [
      {
        method: 'POST',
        path: '/api/oauth/initiate',
        summary: 'Begin the OAuth flow for a server; dynamically registers a client and returns an authorization URL.',
        paramsLabel: 'Body',
        params: [{ name: 'serverName', type: 'string', required: true, description: 'MCP server to authorize.' }],
      },
      {
        method: 'GET',
        alsoMethods: ['POST'],
        path: '/api/oauth/callback',
        summary: 'OAuth redirect target; exchanges the code for tokens, updates the config, and redirects to /mcp.',
        notes: ['Tokens are persisted server-side only.'],
      },
      {
        method: 'POST',
        path: '/api/oauth/reset',
        summary: 'Clear a server\'s OAuth tokens and force re-authentication on the next connection.',
        paramsLabel: 'Body',
        params: [{ name: 'serverName', type: 'string', required: true, description: 'Server to reset.' }],
      },
    ],
  },
  {
    id: 'env',
    name: 'Environment & Secrets',
    description:
      'Global environment variables and server-side encryption operations. Secret values are encrypted at rest and masked as ******** in responses.',
    endpoints: [
      {
        method: 'GET',
        alsoMethods: ['POST'],
        path: '/api/env',
        summary: 'GET reads env vars (secrets masked); POST sets/deletes vars (secrets encrypted server-side).',
        paramsLabel: 'Body',
        params: [
          { name: 'action', type: '"set" | "setAll" | "delete"', required: true, description: 'Operation.' },
          { name: 'key', type: 'string', description: 'Variable name (set/delete).' },
          { name: 'value', type: 'string', description: 'Value; the placeholder ******** is ignored.' },
          { name: 'metadata', type: '{ isSecret: boolean }', description: 'Marks a value for encryption.' },
        ],
        notes: ['GET masks secret values unless an internal includeSecrets flag is set; the browser never receives clear-text secrets.'],
      },
      {
        method: 'POST',
        path: '/api/encryption/secure',
        summary:
          'Server-side encryption operations: initialize, authenticate, change_password, encrypt, verify_password, check_initialized, and status queries.',
        paramsLabel: 'Body',
        params: [{ name: 'action', type: 'string', required: true, description: 'One of the encryption actions.' }],
        notes: ['Passwords and tokens are handled here and stay server-side — never log or surface them in the UI.'],
      },
    ],
  },
  {
    id: 'storage',
    name: 'Storage & Backup',
    description: 'Generic key-value storage plus zip backup/restore of selected data.',
    endpoints: [
      {
        method: 'GET',
        alsoMethods: ['POST', 'DELETE'],
        path: '/api/storage',
        summary: 'GET loads an item by StorageKey (with optional default); POST saves; DELETE clears.',
        paramsLabel: 'Query',
        params: [
          { name: 'key', type: 'StorageKey', required: true, description: 'Storage key.' },
          { name: 'defaultValue', type: 'JSON', description: 'Returned when the key is missing (GET).' },
        ],
      },
      {
        method: 'POST',
        path: '/api/backup',
        summary: 'Create a zip backup of selected items and download it.',
        paramsLabel: 'Body',
        params: [{ name: 'selections', type: 'string[]', required: true, description: 'e.g. models, mcpServers, flows, chatHistory, settings.' }],
        notes: ['A backup may include the encryption key and secrets — handle the downloaded file carefully.'],
      },
      {
        method: 'POST',
        path: '/api/restore',
        summary: 'Restore data from a backup zip.',
        paramsLabel: 'Form data',
        params: [
          { name: 'file', type: 'File (zip)', required: true, description: 'Backup archive.' },
          { name: 'selections', type: 'JSON string[]', required: true, description: 'Which items to restore.' },
        ],
      },
    ],
  },
  {
    id: 'system',
    name: 'System & Updates',
    description: 'App initialization, working-directory info, repository operations, and self-update.',
    endpoints: [
      { method: 'GET', path: '/api/init', summary: 'Server-side initialization: verify storage and start enabled MCP servers.' },
      { method: 'GET', path: '/api/cwd', summary: 'Return the current working directory and the mcp-servers directory path.' },
      {
        method: 'GET',
        path: '/api/browse',
        summary:
          'List a directory of the machine running FLUJO, for the folder-picker dialogs (file-watch triggers, MCP server paths). Defaults to the home directory; includes available drives on Windows.',
        paramsLabel: 'Query',
        params: [{ name: 'path', type: 'string', description: 'Absolute directory path to list.' }],
        response: '{ path, parent, home, sep, drives, entries: [{ name, path, isDirectory }] }',
        notes: ['Exposes backend filesystem listings — like the rest of the API it assumes a single trusted user.'],
      },
      {
        method: 'POST',
        path: '/api/git',
        summary: 'Repository operations for MCP servers: clone, install, build, run, exists, readFile, listDir, list, checkUpdates, checkUpdatesBatch, pullUpdates.',
        paramsLabel: 'Body',
        params: [{ name: 'action', type: 'string', required: true, description: 'Operation to perform.' }],
      },
      {
        method: 'GET',
        alsoMethods: ['POST'],
        path: '/api/update',
        summary: 'GET checks for a newer version (git fetch + behind count); POST { action: "apply" } pulls, rebuilds, and restarts.',
        response: '{ success, isGitRepo, updateAvailable, behindBy?, branch?, currentVersion }',
      },
    ],
  },
];
