# Optional hackathon banking adapter

This adapter is selected by the trusted build setting `FLUJO_EXECUTION_ADAPTER_MODULE`, pointing to this directory's `configuredAdapter.ts`. The default FLUJO build has no adapter. `FLUJO_BANKING_CONFIG` points to the private, absolute policy file; neither configuration belongs in a graphical flow or request metadata.

Authenticated callers use ordinary `POST /v1/chat/completions`. The adapter requires the execution bearer and a fresh frontend assertion, verifies the immutable conversation owner before state reads, admits the turn through the bounded pool, pins the approved graph, and supplies opaque runtime authority to the existing completion path. Its synchronous profile accepts one user message, the approved `flow-<name>` model, optional owned `metadata.conversationId`, and ordinary `flujo`/`appendMessages` flags. Debugging, approvals, detached execution, shared references and arbitrary controls remain unavailable.

The MCP assertion remains the existing single-use `bank-mcp+jwt` profile. It is minted after presets and final business argument validation, carried only in private MCP metadata, and checked again before results and durable commits. Optional `customer_id` is a selector: the Python MCP derives an omitted customer from the verified principal and rejects a conflicting selector. A supplied `conversation_id` must equal the signed conversation.

Approved synthetic operator tests use ordinary FLUJO chat and Slack without this authenticated admission contract. They explicitly select an approved customer in the MCP's operator-test mode and supply conversation correlation, optionally through a nonsecret `@current.conversation.id` preset. Missing authentication never falls back to operator mode.

Normal conversation GET, DELETE, events and cancellation receive authenticated owner checks and sanitized responses, including for previously owned banking transcripts. Execution and conversation controls use the ordinary `/v1/chat` routes. The specialized `/v1/banking/chat` and `/v1/banking/conversations` routes are retired and return 404; `POST /v1/banking/session/revoke` remains available. Existing ownership records and transcript data are preserved.

Native CLI execution remains denied unless an explicitly verified restricted profile is configured and the exact CLI attestation passes.
