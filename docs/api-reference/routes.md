# HTTP route inventory

Generated from the App Router source by `node scripts/generate-api-inventory.mjs`. Do not edit this table by hand.

This inventory lists explicit handler exports, not a public stability guarantee or complete request schema. Next.js may supply implicit HEAD/OPTIONS behavior. Internal administration routes can execute code or disclose secrets; obey their workspace, unlock, exposure, and worker-auth requirements. See the [integration guide](README.md) and the curated in-app `/docs` reference.

Route files: 197.

| Path | Explicit methods | Handler |
| --- | --- | --- |
| `/api/approvals` | GET | [source](../../src/app/api/approvals/route.ts) |
| `/api/approvals/{id}` | POST | [source](../../src/app/api/approvals/[id]/route.ts) |
| `/api/automation-map` | GET | [source](../../src/app/api/automation-map/route.ts) |
| `/api/backup` | POST | [source](../../src/app/api/backup/route.ts) |
| `/api/browse` | GET | [source](../../src/app/api/browse/route.ts) |
| `/api/bugs/enhance` | POST | [source](../../src/app/api/bugs/enhance/route.ts) |
| `/api/cloud/instance` | GET | [source](../../src/app/api/cloud/instance/route.ts) |
| `/api/cwd` | GET | [source](../../src/app/api/cwd/route.ts) |
| `/api/encryption/secure` | POST | [source](../../src/app/api/encryption/secure/route.ts) |
| `/api/env` | GET, POST | [source](../../src/app/api/env/route.ts) |
| `/api/flow` | GET, POST | [source](../../src/app/api/flow/route.ts) |
| `/api/flow/assist` | POST | [source](../../src/app/api/flow/assist/route.ts) |
| `/api/flow/compile` | POST | [source](../../src/app/api/flow/compile/route.ts) |
| `/api/flow/generate` | POST | [source](../../src/app/api/flow/generate/route.ts) |
| `/api/flow/generate/visual` | POST | [source](../../src/app/api/flow/generate/visual/route.ts) |
| `/api/flow/generator` | POST, PUT | [source](../../src/app/api/flow/generator/route.ts) |
| `/api/flow/improve` | POST | [source](../../src/app/api/flow/improve/route.ts) |
| `/api/flow/model-agent` | POST | [source](../../src/app/api/flow/model-agent/route.ts) |
| `/api/flow/prompt-renderer` | POST | [source](../../src/app/api/flow/prompt-renderer/route.ts) |
| `/api/flow/quick-chat` | POST | [source](../../src/app/api/flow/quick-chat/route.ts) |
| `/api/flow/repair` | POST | [source](../../src/app/api/flow/repair/route.ts) |
| `/api/flow/{id}` | DELETE, GET, PUT | [source](../../src/app/api/flow/[id]/route.ts) |
| `/api/flow/{id}/convert-process-to-subflow` | POST | [source](../../src/app/api/flow/[id]/convert-process-to-subflow/route.ts) |
| `/api/flow/{id}/versions` | GET | [source](../../src/app/api/flow/[id]/versions/route.ts) |
| `/api/flow/{id}/versions/{versionId}` | GET | [source](../../src/app/api/flow/[id]/versions/[versionId]/route.ts) |
| `/api/git` | POST | [source](../../src/app/api/git/route.ts) |
| `/api/init` | GET | [source](../../src/app/api/init/route.ts) |
| `/api/local-models/capability` | GET | [source](../../src/app/api/local-models/capability/route.ts) |
| `/api/local-models/pull` | POST | [source](../../src/app/api/local-models/pull/route.ts) |
| `/api/local-models/suggest` | GET | [source](../../src/app/api/local-models/suggest/route.ts) |
| `/api/mcp-registry` | GET | [source](../../src/app/api/mcp-registry/route.ts) |
| `/api/mcp-registry/spotlight` | GET, POST | [source](../../src/app/api/mcp-registry/spotlight/route.ts) |
| `/api/mcp/app-consent` | DELETE, GET, POST | [source](../../src/app/api/mcp/app-consent/route.ts) |
| `/api/mcp/app-sandbox` | GET | [source](../../src/app/api/mcp/app-sandbox/route.ts) |
| `/api/mcp/assistant` | POST | [source](../../src/app/api/mcp/assistant/route.ts) |
| `/api/mcp/cancel` | POST | [source](../../src/app/api/mcp/cancel/route.ts) |
| `/api/mcp/flujo/authoring` | POST | [source](../../src/app/api/mcp/flujo/authoring/route.ts) |
| `/api/mcp/flujo/automation` | POST | [source](../../src/app/api/mcp/flujo/automation/route.ts) |
| `/api/mcp/flujo/flows` | POST | [source](../../src/app/api/mcp/flujo/flows/route.ts) |
| `/api/mcp/flujo/resources` | GET | [source](../../src/app/api/mcp/flujo/resources/route.ts) |
| `/api/mcp/flujo/resources/read` | POST | [source](../../src/app/api/mcp/flujo/resources/read/route.ts) |
| `/api/mcp/flujo/servers` | POST | [source](../../src/app/api/mcp/flujo/servers/route.ts) |
| `/api/mcp/flujo/skills` | GET, POST | [source](../../src/app/api/mcp/flujo/skills/route.ts) |
| `/api/mcp/flujo/state` | POST | [source](../../src/app/api/mcp/flujo/state/route.ts) |
| `/api/mcp/flujo/tools` | GET | [source](../../src/app/api/mcp/flujo/tools/route.ts) |
| `/api/mcp/oauth-capability` | POST | [source](../../src/app/api/mcp/oauth-capability/route.ts) |
| `/api/mcp/servers` | GET, POST | [source](../../src/app/api/mcp/servers/route.ts) |
| `/api/mcp/servers/{name}` | DELETE, GET, PUT | [source](../../src/app/api/mcp/servers/[name]/route.ts) |
| `/api/mcp/servers/{name}/prompts` | GET | [source](../../src/app/api/mcp/servers/[name]/prompts/route.ts) |
| `/api/mcp/servers/{name}/prompts/get` | POST | [source](../../src/app/api/mcp/servers/[name]/prompts/get/route.ts) |
| `/api/mcp/servers/{name}/resources` | GET | [source](../../src/app/api/mcp/servers/[name]/resources/route.ts) |
| `/api/mcp/servers/{name}/resources/read` | GET | [source](../../src/app/api/mcp/servers/[name]/resources/read/route.ts) |
| `/api/mcp/servers/{name}/skills` | GET | [source](../../src/app/api/mcp/servers/[name]/skills/route.ts) |
| `/api/mcp/servers/{name}/skills/approve` | POST | [source](../../src/app/api/mcp/servers/[name]/skills/approve/route.ts) |
| `/api/mcp/servers/{name}/skills/get` | POST | [source](../../src/app/api/mcp/servers/[name]/skills/get/route.ts) |
| `/api/mcp/servers/{name}/skills/load` | POST | [source](../../src/app/api/mcp/servers/[name]/skills/load/route.ts) |
| `/api/mcp/servers/{name}/status` | GET | [source](../../src/app/api/mcp/servers/[name]/status/route.ts) |
| `/api/mcp/servers/{name}/stdio-oauth/confirm` | POST | [source](../../src/app/api/mcp/servers/[name]/stdio-oauth/confirm/route.ts) |
| `/api/mcp/servers/{name}/stdio-oauth/start` | DELETE, POST | [source](../../src/app/api/mcp/servers/[name]/stdio-oauth/start/route.ts) |
| `/api/mcp/servers/{name}/tools` | GET | [source](../../src/app/api/mcp/servers/[name]/tools/route.ts) |
| `/api/mcp/servers/{name}/tools/{toolName}` | POST | [source](../../src/app/api/mcp/servers/[name]/tools/[toolName]/route.ts) |
| `/api/mcp/test-connection` | POST | [source](../../src/app/api/mcp/test-connection/route.ts) |
| `/api/mcp/test-connection/stream` | POST | [source](../../src/app/api/mcp/test-connection/stream/route.ts) |
| `/api/model` | GET, POST | [source](../../src/app/api/model/route.ts) |
| `/api/model/provider` | POST | [source](../../src/app/api/model/provider/route.ts) |
| `/api/model/test` | POST | [source](../../src/app/api/model/test/route.ts) |
| `/api/model/{id}` | DELETE, GET, PUT | [source](../../src/app/api/model/[id]/route.ts) |
| `/api/network-exposure` | GET | [source](../../src/app/api/network-exposure/route.ts) |
| `/api/oauth/callback` | GET, POST | [source](../../src/app/api/oauth/callback/route.ts) |
| `/api/oauth/initiate` | POST | [source](../../src/app/api/oauth/initiate/route.ts) |
| `/api/oauth/reset` | POST | [source](../../src/app/api/oauth/reset/route.ts) |
| `/api/packages/build` | POST | [source](../../src/app/api/packages/build/route.ts) |
| `/api/packages/derive-secrets` | POST | [source](../../src/app/api/packages/derive-secrets/route.ts) |
| `/api/packages/install` | POST | [source](../../src/app/api/packages/install/route.ts) |
| `/api/packages/install/status` | GET | [source](../../src/app/api/packages/install/status/route.ts) |
| `/api/packages/installed` | GET | [source](../../src/app/api/packages/installed/route.ts) |
| `/api/packages/resolve` | POST | [source](../../src/app/api/packages/resolve/route.ts) |
| `/api/packages/scan-targets` | POST | [source](../../src/app/api/packages/scan-targets/route.ts) |
| `/api/packages/search` | GET | [source](../../src/app/api/packages/search/route.ts) |
| `/api/packages/uninstall` | POST | [source](../../src/app/api/packages/uninstall/route.ts) |
| `/api/planned-executions` | GET, PATCH, POST | [source](../../src/app/api/planned-executions/route.ts) |
| `/api/planned-executions/preview-schedule` | POST | [source](../../src/app/api/planned-executions/preview-schedule/route.ts) |
| `/api/planned-executions/reconcile` | POST | [source](../../src/app/api/planned-executions/reconcile/route.ts) |
| `/api/planned-executions/{id}` | DELETE, GET, PATCH | [source](../../src/app/api/planned-executions/[id]/route.ts) |
| `/api/planned-executions/{id}/run` | POST | [source](../../src/app/api/planned-executions/[id]/run/route.ts) |
| `/api/planned-executions/{id}/runs` | GET | [source](../../src/app/api/planned-executions/[id]/runs/route.ts) |
| `/api/reference-search/files` | GET | [source](../../src/app/api/reference-search/files/route.ts) |
| `/api/registry/auth` | DELETE, GET, POST | [source](../../src/app/api/registry/auth/route.ts) |
| `/api/registry/auth/resend` | POST | [source](../../src/app/api/registry/auth/resend/route.ts) |
| `/api/registry/auth/reset` | POST | [source](../../src/app/api/registry/auth/reset/route.ts) |
| `/api/registry/feedback` | POST | [source](../../src/app/api/registry/feedback/route.ts) |
| `/api/registry/oauth/callback` | GET | [source](../../src/app/api/registry/oauth/callback/route.ts) |
| `/api/registry/oauth/initiate` | POST | [source](../../src/app/api/registry/oauth/initiate/route.ts) |
| `/api/registry/packages` | DELETE | [source](../../src/app/api/registry/packages/route.ts) |
| `/api/registry/publish` | POST | [source](../../src/app/api/registry/publish/route.ts) |
| `/api/registry/settings` | GET, POST | [source](../../src/app/api/registry/settings/route.ts) |
| `/api/restore` | POST | [source](../../src/app/api/restore/route.ts) |
| `/api/runs/active` | GET | [source](../../src/app/api/runs/active/route.ts) |
| `/api/runtime-environment` | GET, PUT | [source](../../src/app/api/runtime-environment/route.ts) |
| `/api/setup/ai-cli` | GET, POST | [source](../../src/app/api/setup/ai-cli/route.ts) |
| `/api/snapshot/abort` | POST | [source](../../src/app/api/snapshot/abort/route.ts) |
| `/api/snapshot/begin` | POST | [source](../../src/app/api/snapshot/begin/route.ts) |
| `/api/snapshot/download` | GET | [source](../../src/app/api/snapshot/download/route.ts) |
| `/api/snapshot/finalize` | POST | [source](../../src/app/api/snapshot/finalize/route.ts) |
| `/api/snapshot/info` | GET | [source](../../src/app/api/snapshot/info/route.ts) |
| `/api/snapshot/status` | GET | [source](../../src/app/api/snapshot/status/route.ts) |
| `/api/snapshots` | GET, PATCH | [source](../../src/app/api/snapshots/route.ts) |
| `/api/snapshots/cleanup` | POST | [source](../../src/app/api/snapshots/cleanup/route.ts) |
| `/api/snapshots/open-folder` | POST | [source](../../src/app/api/snapshots/open-folder/route.ts) |
| `/api/statistics` | GET | [source](../../src/app/api/statistics/route.ts) |
| `/api/storage` | DELETE, GET, POST | [source](../../src/app/api/storage/route.ts) |
| `/api/telemetry/daily-active` | GET, POST | [source](../../src/app/api/telemetry/daily-active/route.ts) |
| `/api/tickets` | DELETE, GET, POST | [source](../../src/app/api/tickets/route.ts) |
| `/api/tickets/{id}` | DELETE, GET, PATCH | [source](../../src/app/api/tickets/[id]/route.ts) |
| `/api/transcription` | POST | [source](../../src/app/api/transcription/route.ts) |
| `/api/update` | GET, POST | [source](../../src/app/api/update/route.ts) |
| `/api/waves` | GET | [source](../../src/app/api/waves/route.ts) |
| `/api/webhooks/{id}` | POST | [source](../../src/app/api/webhooks/[id]/route.ts) |
| `/api/worker/status` | GET | [source](../../src/app/api/worker/status/route.ts) |
| `/api/workspaces` | DELETE, GET, PATCH, POST | [source](../../src/app/api/workspaces/route.ts) |
| `/mcp-flows` | DELETE, GET, POST | [source](../../src/app/mcp-flows/route.ts) |
| `/mcp-proxy/{server}` | DELETE, GET, POST | [source](../../src/app/mcp-proxy/[server]/route.ts) |
| `/v1/chat/completions` | GET, OPTIONS, POST | [source](../../src/app/v1/chat/completions/route.ts) |
| `/v1/chat/conversation-chains` | GET | [source](../../src/app/v1/chat/conversation-chains/route.ts) |
| `/v1/chat/conversations` | DELETE, GET, POST | [source](../../src/app/v1/chat/conversations/route.ts) |
| `/v1/chat/conversations/{conversationId}` | DELETE, GET, PATCH | [source](../../src/app/v1/chat/conversations/[conversationId]/route.ts) |
| `/v1/chat/conversations/{conversationId}/breakpoints` | PUT | [source](../../src/app/v1/chat/conversations/[conversationId]/breakpoints/route.ts) |
| `/v1/chat/conversations/{conversationId}/cancel` | POST | [source](../../src/app/v1/chat/conversations/[conversationId]/cancel/route.ts) |
| `/v1/chat/conversations/{conversationId}/debug/attach` | POST | [source](../../src/app/v1/chat/conversations/[conversationId]/debug/attach/route.ts) |
| `/v1/chat/conversations/{conversationId}/debug/continue` | POST | [source](../../src/app/v1/chat/conversations/[conversationId]/debug/continue/route.ts) |
| `/v1/chat/conversations/{conversationId}/debug/state` | GET | [source](../../src/app/v1/chat/conversations/[conversationId]/debug/state/route.ts) |
| `/v1/chat/conversations/{conversationId}/debug/step` | POST | [source](../../src/app/v1/chat/conversations/[conversationId]/debug/step/route.ts) |
| `/v1/chat/conversations/{conversationId}/edit-state` | PATCH | [source](../../src/app/v1/chat/conversations/[conversationId]/edit-state/route.ts) |
| `/v1/chat/conversations/{conversationId}/events` | GET | [source](../../src/app/v1/chat/conversations/[conversationId]/events/route.ts) |
| `/v1/chat/conversations/{conversationId}/inject` | POST | [source](../../src/app/v1/chat/conversations/[conversationId]/inject/route.ts) |
| `/v1/chat/conversations/{conversationId}/model-turns` | GET | [source](../../src/app/v1/chat/conversations/[conversationId]/model-turns/route.ts) |
| `/v1/chat/conversations/{conversationId}/model-turns/{dispatchId}` | GET | [source](../../src/app/v1/chat/conversations/[conversationId]/model-turns/[dispatchId]/route.ts) |
| `/v1/chat/conversations/{conversationId}/model-turns/{dispatchId}/media/{mediaId}` | GET | [source](../../src/app/v1/chat/conversations/[conversationId]/model-turns/[dispatchId]/media/[mediaId]/route.ts) |
| `/v1/chat/conversations/{conversationId}/recovery` | GET, POST | [source](../../src/app/v1/chat/conversations/[conversationId]/recovery/route.ts) |
| `/v1/chat/conversations/{conversationId}/resources` | GET | [source](../../src/app/v1/chat/conversations/[conversationId]/resources/route.ts) |
| `/v1/chat/conversations/{conversationId}/resources/{resourceId}/content` | GET | [source](../../src/app/v1/chat/conversations/[conversationId]/resources/[resourceId]/content/route.ts) |
| `/v1/chat/conversations/{conversationId}/respond` | POST | [source](../../src/app/v1/chat/conversations/[conversationId]/respond/route.ts) |
| `/v1/chat/conversations/{conversationId}/revert` | GET, POST | [source](../../src/app/v1/chat/conversations/[conversationId]/revert/route.ts) |
| `/v1/chat/conversations/{conversationId}/wire-preview` | POST | [source](../../src/app/v1/chat/conversations/[conversationId]/wire-preview/route.ts) |
| `/v1/chat/events` | GET | [source](../../src/app/v1/chat/events/route.ts) |
| `/v1/flows/{flowRef}/readiness` | GET | [source](../../src/app/v1/flows/[flowRef]/readiness/route.ts) |
| `/v1/meetings` | GET, POST | [source](../../src/app/v1/meetings/route.ts) |
| `/v1/meetings/{meetingId}` | GET | [source](../../src/app/v1/meetings/[meetingId]/route.ts) |
| `/v1/meetings/{meetingId}/cancel` | POST | [source](../../src/app/v1/meetings/[meetingId]/cancel/route.ts) |
| `/v1/meetings/{meetingId}/events` | GET | [source](../../src/app/v1/meetings/[meetingId]/events/route.ts) |
| `/v1/meetings/{meetingId}/interventions` | POST | [source](../../src/app/v1/meetings/[meetingId]/interventions/route.ts) |
| `/v1/meetings/{meetingId}/private-notes` | POST | [source](../../src/app/v1/meetings/[meetingId]/private-notes/route.ts) |
| `/v1/meetings/{meetingId}/resume` | POST | [source](../../src/app/v1/meetings/[meetingId]/resume/route.ts) |
| `/v1/meetings/{meetingId}/start` | POST | [source](../../src/app/v1/meetings/[meetingId]/start/route.ts) |
| `/v1/models` | GET | [source](../../src/app/v1/models/route.ts) |
| `/v1/persona-drafts` | GET, POST | [source](../../src/app/v1/persona-drafts/route.ts) |
| `/v1/persona-drafts/{draftId}` | DELETE, GET, PATCH | [source](../../src/app/v1/persona-drafts/[draftId]/route.ts) |
| `/v1/personas` | GET, POST | [source](../../src/app/v1/personas/route.ts) |
| `/v1/personas/settings-options` | GET | [source](../../src/app/v1/personas/settings-options/route.ts) |
| `/v1/personas/summary` | GET | [source](../../src/app/v1/personas/summary/route.ts) |
| `/v1/personas/{personaId}` | DELETE, GET, PATCH | [source](../../src/app/v1/personas/[personaId]/route.ts) |
| `/v1/personas/{personaId}/app-grants` | GET, POST | [source](../../src/app/v1/personas/[personaId]/app-grants/route.ts) |
| `/v1/personas/{personaId}/app-grants/{grantId}` | DELETE, PATCH | [source](../../src/app/v1/personas/[personaId]/app-grants/[grantId]/route.ts) |
| `/v1/personas/{personaId}/app-grants/{grantId}/launch` | POST | [source](../../src/app/v1/personas/[personaId]/app-grants/[grantId]/launch/route.ts) |
| `/v1/personas/{personaId}/behaviors/{behaviorId}/activate` | POST | [source](../../src/app/v1/personas/[personaId]/behaviors/[behaviorId]/activate/route.ts) |
| `/v1/personas/{personaId}/composition` | GET, PATCH | [source](../../src/app/v1/personas/[personaId]/composition/route.ts) |
| `/v1/personas/{personaId}/composition/copy` | POST | [source](../../src/app/v1/personas/[personaId]/composition/copy/route.ts) |
| `/v1/personas/{personaId}/deletion-preview` | GET | [source](../../src/app/v1/personas/[personaId]/deletion-preview/route.ts) |
| `/v1/personas/{personaId}/execution-preview` | GET | [source](../../src/app/v1/personas/[personaId]/execution-preview/route.ts) |
| `/v1/personas/{personaId}/export` | POST | [source](../../src/app/v1/personas/[personaId]/export/route.ts) |
| `/v1/personas/{personaId}/export-preview` | POST | [source](../../src/app/v1/personas/[personaId]/export-preview/route.ts) |
| `/v1/personas/{personaId}/improvements` | GET | [source](../../src/app/v1/personas/[personaId]/improvements/route.ts) |
| `/v1/personas/{personaId}/improvements/{proposalId}/apply` | POST | [source](../../src/app/v1/personas/[personaId]/improvements/[proposalId]/apply/route.ts) |
| `/v1/personas/{personaId}/improvements/{proposalId}/promote` | POST | [source](../../src/app/v1/personas/[personaId]/improvements/[proposalId]/promote/route.ts) |
| `/v1/personas/{personaId}/improvements/{proposalId}/reject` | POST | [source](../../src/app/v1/personas/[personaId]/improvements/[proposalId]/reject/route.ts) |
| `/v1/personas/{personaId}/improvements/{proposalId}/undo` | POST | [source](../../src/app/v1/personas/[personaId]/improvements/[proposalId]/undo/route.ts) |
| `/v1/personas/{personaId}/memories` | GET, POST | [source](../../src/app/v1/personas/[personaId]/memories/route.ts) |
| `/v1/personas/{personaId}/memories/{memoryId}` | DELETE, GET | [source](../../src/app/v1/personas/[personaId]/memories/[memoryId]/route.ts) |
| `/v1/personas/{personaId}/memories/{memoryId}/activate` | POST | [source](../../src/app/v1/personas/[personaId]/memories/[memoryId]/activate/route.ts) |
| `/v1/personas/{personaId}/memories/{memoryId}/correct` | POST | [source](../../src/app/v1/personas/[personaId]/memories/[memoryId]/correct/route.ts) |
| `/v1/personas/{personaId}/memories/{memoryId}/pin` | DELETE, POST | [source](../../src/app/v1/personas/[personaId]/memories/[memoryId]/pin/route.ts) |
| `/v1/personas/{personaId}/memories/{memoryId}/resolve-conflict` | POST | [source](../../src/app/v1/personas/[personaId]/memories/[memoryId]/resolve-conflict/route.ts) |
| `/v1/personas/{personaId}/runtime-recovery` | POST | [source](../../src/app/v1/personas/[personaId]/runtime-recovery/route.ts) |
| `/v1/personas/{personaId}/storage-stats` | GET | [source](../../src/app/v1/personas/[personaId]/storage-stats/route.ts) |
| `/v1/personas/{personaId}/work-items` | GET, POST | [source](../../src/app/v1/personas/[personaId]/work-items/route.ts) |
| `/v1/personas/{personaId}/work-items/promote-todo` | POST | [source](../../src/app/v1/personas/[personaId]/work-items/promote-todo/route.ts) |
| `/v1/personas/{personaId}/work-items/{workItemId}` | DELETE, GET, PATCH | [source](../../src/app/v1/personas/[personaId]/work-items/[workItemId]/route.ts) |
| `/v1/personas/{personaId}/work-items/{workItemId}/assign` | POST | [source](../../src/app/v1/personas/[personaId]/work-items/[workItemId]/assign/route.ts) |
| `/v1/personas/{personaId}/work-items/{workItemId}/control` | POST | [source](../../src/app/v1/personas/[personaId]/work-items/[workItemId]/control/route.ts) |
| `/v1/roles` | GET, POST | [source](../../src/app/v1/roles/route.ts) |
| `/v1/roles/{roleId}` | DELETE, GET, PATCH, PUT | [source](../../src/app/v1/roles/[roleId]/route.ts) |
| `/v1/roles/{roleId}/duplicate` | POST | [source](../../src/app/v1/roles/[roleId]/duplicate/route.ts) |
| `/v1/roles/{roleId}/impact` | GET | [source](../../src/app/v1/roles/[roleId]/impact/route.ts) |
| `/v1/roles/{roleId}/restore` | POST | [source](../../src/app/v1/roles/[roleId]/restore/route.ts) |
| `/v1/roles/{roleId}/rollback` | POST | [source](../../src/app/v1/roles/[roleId]/rollback/route.ts) |
| `/v1/roles/{roleId}/versions` | GET | [source](../../src/app/v1/roles/[roleId]/versions/route.ts) |
| `/v1/tasks/{taskId}` | DELETE, GET | [source](../../src/app/v1/tasks/[taskId]/route.ts) |
