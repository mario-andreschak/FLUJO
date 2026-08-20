import OpenAI from 'openai';
import { shortHash } from '@/backend/execution/flow/handlers/toolNamespace';
import type { CompletionInput } from './types';

const MAX_TOOL_NAME_LENGTH = 64;

export interface ProviderToolNameTranslation {
  canonicalToProvider: ReadonlyMap<string, string>;
  providerToCanonical: ReadonlyMap<string, string>;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function readableBase(server: string, tool: string): string {
  return `${sanitizeName(server)}_${sanitizeName(tool)}`;
}

function hashedName(base: string, identity: string, attempt: number): string {
  const hash = shortHash(attempt === 0 ? identity : `${identity}\0${attempt}`);
  const room = MAX_TOOL_NAME_LENGTH - hash.length - 1;
  return `${base.slice(0, Math.max(0, room))}_${hash}`;
}

/**
 * Allocate readable provider-facing aliases for FLUJO's canonical MCP names.
 * A hash is used only when the readable server_tool spelling is too long or
 * collides with another advertised function name after sanitization.
 */
export function buildProviderToolNameTranslation(
  tools: OpenAI.ChatCompletionFunctionTool[] | undefined,
  toolNameMap: CompletionInput['toolNameMap'],
): ProviderToolNameTranslation {
  const canonicalToProvider = new Map<string, string>();
  const providerToCanonical = new Map<string, string>();
  if (!tools?.length || !toolNameMap) {
    return { canonicalToProvider, providerToCanonical };
  }

  const mcpTools = tools
    .filter((definition) => !!toolNameMap[definition.function.name])
    .map((definition) => {
      const canonical = definition.function.name;
      const decoded = toolNameMap[canonical]!;
      return {
        canonical,
        base: readableBase(decoded.server, decoded.tool),
        identity: `${decoded.server}\0${decoded.tool}`,
      };
    });
  const reserved = new Set(
    tools
      .map((definition) => definition.function.name)
      .filter((name) => !toolNameMap[name]),
  );
  const baseCounts = new Map<string, number>();
  for (const entry of mcpTools) {
    baseCounts.set(entry.base, (baseCounts.get(entry.base) ?? 0) + 1);
  }

  // Claim every unambiguous readable name first. Sorting makes allocation and
  // collision fallback stable even if an MCP server changes tools/list order.
  const needsHash: typeof mcpTools = [];
  for (const entry of [...mcpTools].sort((a, b) =>
    a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0
  )) {
    const canUseBase = entry.base.length <= MAX_TOOL_NAME_LENGTH
      && baseCounts.get(entry.base) === 1
      && !reserved.has(entry.base)
      && !providerToCanonical.has(entry.base);
    if (!canUseBase) {
      needsHash.push(entry);
      continue;
    }
    canonicalToProvider.set(entry.canonical, entry.base);
    providerToCanonical.set(entry.base, entry.canonical);
  }

  for (const entry of needsHash) {
    let attempt = 0;
    let alias = hashedName(entry.base, entry.identity, attempt);
    while (reserved.has(alias) || providerToCanonical.has(alias)) {
      alias = hashedName(entry.base, entry.identity, ++attempt);
    }
    canonicalToProvider.set(entry.canonical, alias);
    providerToCanonical.set(alias, entry.canonical);
  }

  return { canonicalToProvider, providerToCanonical };
}

export function translateToolsForProvider(
  tools: OpenAI.ChatCompletionFunctionTool[] | undefined,
  translation: ProviderToolNameTranslation,
): OpenAI.ChatCompletionFunctionTool[] | undefined {
  return tools?.map((definition) => {
    const name = translation.canonicalToProvider.get(definition.function.name);
    return name
      ? { ...definition, function: { ...definition.function, name } }
      : definition;
  });
}

export function translateMessagesForProvider(
  messages: OpenAI.ChatCompletionMessageParam[],
  translation: ProviderToolNameTranslation,
): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    const candidate = message as OpenAI.ChatCompletionMessageParam & {
      tool_calls?: OpenAI.ChatCompletionMessageFunctionToolCall[];
      function_call?: { name: string; arguments: string };
      name?: string;
    };
    let translated: typeof candidate | undefined;
    if (candidate.tool_calls?.length) {
      translated = {
        ...candidate,
        tool_calls: candidate.tool_calls.map((call) => ({
          ...call,
          function: {
            ...call.function,
            name: translation.canonicalToProvider.get(call.function.name) ?? call.function.name,
          },
        })),
      };
    }
    if (candidate.function_call) {
      translated = {
        ...(translated ?? candidate),
        function_call: {
          ...candidate.function_call,
          name: translation.canonicalToProvider.get(candidate.function_call.name)
            ?? candidate.function_call.name,
        },
      };
    }
    if (candidate.name && (candidate.role === 'function' || candidate.role === 'tool')) {
      translated = {
        ...(translated ?? candidate),
        name: translation.canonicalToProvider.get(candidate.name) ?? candidate.name,
      };
    }
    return (translated ?? message) as OpenAI.ChatCompletionMessageParam;
  });
}

export function translateCompletionFromProvider(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  translation: ProviderToolNameTranslation,
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    ...completion,
    choices: completion.choices.map((choice) => ({
      ...choice,
      message: {
        ...choice.message,
        ...(choice.message.tool_calls
          ? {
              tool_calls: choice.message.tool_calls.map((call) => call.type === 'function'
                ? {
                    ...call,
                    function: {
                      ...call.function,
                      name: translation.providerToCanonical.get(call.function.name)
                        ?? call.function.name,
                    },
                  }
                : call),
            }
          : {}),
        ...(choice.message.function_call
          ? {
              function_call: {
                ...choice.message.function_call,
                name: translation.providerToCanonical.get(choice.message.function_call.name)
                  ?? choice.message.function_call.name,
              },
            }
          : {}),
      },
    })),
  };
}
