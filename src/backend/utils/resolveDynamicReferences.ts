import path from 'path';
import { promises as fs } from 'fs';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import type { ToolReferenceContext } from '@/backend/execution/flow/types';
import { findPromptRefs, parseDynamicReference, type DynamicReference } from '@/utils/shared/promptRefs';
import { resolveGlobalVars, resolveNonSecretGlobalVars } from './resolveGlobalVars';

interface ReferenceEntity {
  id?: unknown;
  name?: unknown;
  created?: unknown;
  updated?: unknown;
}

async function fileEntity(target: string): Promise<ReferenceEntity> {
  let created: number | undefined;
  let updated: number | undefined;
  try {
    const stat = await fs.stat(target);
    created = stat.birthtimeMs;
    updated = stat.mtimeMs;
  } catch {
    // The selected path can legitimately disappear between authoring and run.
  }
  return { id: target, name: path.basename(target) || target, created, updated };
}

async function entityForReference(
  ref: DynamicReference,
  context: ToolReferenceContext,
): Promise<ReferenceEntity> {
  if (ref.kind === 'time') {
    const now = new Date();
    return { id: now.toTimeString().slice(0, 8), name: now.toTimeString().slice(0, 8), created: now.getTime(), updated: now.getTime() };
  }
  if (ref.kind === 'date') {
    const now = new Date();
    const value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return { id: value, name: value, created: now.getTime(), updated: now.getTime() };
  }
  if (ref.kind === 'folder' || ref.kind === 'file') {
    if (ref.target) return fileEntity(ref.target);
    if (ref.kind === 'folder' && context.flowId) {
      const flow = await flowService.getFlow(context.flowId);
      if (flow?.folder) {
        return {
          id: flow.folder,
          name: flow.folder,
          created: flow.createdAt,
          updated: flow.updatedAt,
        };
      }
    }
    return {};
  }
  if (ref.kind === 'conversation') {
    const id = ref.target || context.conversationId;
    if (!id) return {};
    const state = await loadConversationState(id);
    return {
      id,
      name: state?.title,
      created: state?.createdAt,
      updated: state?.updatedAt,
    };
  }
  if (ref.kind === 'flows') {
    const id = ref.target || context.flowId;
    if (!id) return {};
    const flow = await flowService.getFlow(id);
    return { id, name: flow?.name, created: flow?.createdAt, updated: flow?.updatedAt };
  }
  if (ref.kind === 'node') {
    const id = ref.target || context.nodeId;
    if (!id) return {};
    const flow = context.flowId ? await flowService.getFlow(context.flowId) : null;
    const node = flow?.nodes.find((candidate) => candidate.id === id);
    return {
      id,
      name: node?.data?.label || node?.data?.properties?.name,
      created: (node?.data?.properties as Record<string, unknown> | undefined)?.createdAt,
      updated: (node?.data?.properties as Record<string, unknown> | undefined)?.updatedAt,
    };
  }
  if (ref.kind === 'model') {
    const id = ref.target || context.modelId;
    if (!id) return {};
    const model = await modelService.getModel(id);
    const record = model as (typeof model & { createdAt?: number; updatedAt?: number });
    return {
      id,
      name: model?.displayName || model?.name,
      created: record?.createdAt,
      updated: record?.updatedAt,
    };
  }
  const id = ref.target || context.appId;
  if (!id) return {};
  if (ref.target && isUiAppUri(ref.target)) {
    return { id: ref.target, name: readableAppName(ref.target) };
  }
  const configs = await mcpService.loadServerConfigs();
  const config = Array.isArray(configs) ? configs.find((candidate) => candidate.name === id) : undefined;
  const record = config as (typeof config & { createdAt?: number; updatedAt?: number });
  return { id, name: config?.name || id, created: record?.createdAt, updated: record?.updatedAt };
}

function isUiAppUri(value: string): boolean {
  return value.toLocaleLowerCase().startsWith('ui://');
}

function readableAppName(uri: string): string {
  const tail = uri.replace(/^ui:\/\//i, '').split('/').filter(Boolean).at(-1);
  if (!tail) return uri;
  try {
    return decodeURIComponent(tail).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}

async function resolveString(text: string, context: ToolReferenceContext): Promise<unknown> {
  const matches = findPromptRefs(text).filter((match) => match.kind === 'mention');
  if (matches.length === 0) return text;

  const resolved = await Promise.all(matches.map(async (match) => {
    const ref = parseDynamicReference(match.fullMatch);
    if (!ref) return { match, value: match.fullMatch as unknown };
    const entity = await entityForReference(ref, context);
    return { match, value: entity[ref.field] ?? '' };
  }));

  if (resolved.length === 1 && resolved[0].match.index === 0 && resolved[0].match.fullMatch.length === text.length) {
    return resolved[0].value;
  }

  let output = '';
  let cursor = 0;
  for (const item of resolved) {
    output += text.slice(cursor, item.match.index) + String(item.value ?? '');
    cursor = item.match.index + item.match.fullMatch.length;
  }
  return output + text.slice(cursor);
}

async function resolveRecursive(value: unknown, context: ToolReferenceContext): Promise<unknown> {
  if (typeof value === 'string') return resolveString(value, context);
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveRecursive(item, context)));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = await resolveRecursive(item, context);
    return output;
  }
  return value;
}

/** Resolve dynamic @ refs while keeping secret globals out of model-visible prompts. */
export async function resolvePromptDynamicReferences(
  value: unknown,
  context: ToolReferenceContext,
): Promise<unknown> {
  return resolveNonSecretGlobalVars(await resolveRecursive(value, context));
}

/** Resolve fixed tool arguments, including secret globals, immediately before dispatch. */
export async function resolvePresetArguments(
  presetArgs: Record<string, unknown> | undefined,
  context: ToolReferenceContext | undefined,
): Promise<Record<string, unknown>> {
  if (!presetArgs || Object.keys(presetArgs).length === 0) return {};
  const dynamic = await resolveRecursive(presetArgs, context ?? {});
  return await resolveGlobalVars(dynamic) as Record<string, unknown>;
}

/** Presets are authoritative: model-provided values can never override them. */
export async function applyPresetArguments(
  args: Record<string, unknown>,
  presetArgs: Record<string, unknown> | undefined,
  context: ToolReferenceContext | undefined,
): Promise<Record<string, unknown>> {
  return { ...args, ...await resolvePresetArguments(presetArgs, context) };
}
