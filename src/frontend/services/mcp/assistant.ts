'use client';

import type {
  McpAssistantInstallInput,
  McpAssistantInstallResult,
  McpAssistantResearchEvent,
  McpAssistantResearchResult,
  McpTroubleshootContext,
  McpTroubleshootResult,
} from '@/shared/types/mcp/assistant';
import { readJsonEventStream } from '@/frontend/utils/jsonEventReader';

async function errorFrom(response: Response, fallback: string): Promise<Error> {
  const data = await response.json().catch(() => null);
  return new Error(data?.error || fallback);
}

export async function researchMcpConnection(
  input: { query: string; modelId: string },
  onEvent: (event: McpAssistantResearchEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<McpAssistantResearchResult> {
  const response = await fetch('/api/mcp/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'research', ...input }),
    signal,
  });
  if (!response.ok) throw await errorFrom(response, 'Could not research MCP servers.');
  let result: McpAssistantResearchResult | null = null;
  let streamError: string | null = null;
  await readJsonEventStream<McpAssistantResearchEvent>(response, async (event) => {
    await onEvent(event);
    if (event.type === 'complete') result = event.result;
    if (event.type === 'error') streamError = event.error;
  });
  if (streamError) throw new Error(streamError);
  if (!result) throw new Error('Research ended without a recommendation.');
  return result;
}

export async function installMcpRecommendation(input: McpAssistantInstallInput): Promise<McpAssistantInstallResult> {
  const response = await fetch('/api/mcp/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'install', install: input }),
  });
  if (!response.ok) throw await errorFrom(response, 'Could not install the MCP server.');
  return response.json();
}

export async function troubleshootMcpConnection(context: McpTroubleshootContext): Promise<McpTroubleshootResult> {
  const response = await fetch('/api/mcp/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'troubleshoot', context }),
  });
  if (!response.ok) throw await errorFrom(response, 'Could not diagnose this MCP setup.');
  return response.json();
}
