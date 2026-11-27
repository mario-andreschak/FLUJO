import type { ToolDefinition } from '../types';
import { SEARCH_TOOLS_TOOL_NAME } from '../toolLoading/deferredTools';
import type { CodeModeSetting } from '@/shared/types/flow/toolLoading';

/**
 * Code mode (#1448): the model writes a short JavaScript program that calls
 * the step's MCP tools as functions (`await tools.github.create_issue({...})`).
 * The program runs in a QuickJS sandbox (see sandbox.ts); tool results stay
 * inside it, and only what the program returns or logs reaches the model.
 */

export const RUN_TOOL_SCRIPT_TOOL_NAME = 'run_tool_script';

export function isRunToolScriptName(name: string): boolean {
  return name === RUN_TOOL_SCRIPT_TOOL_NAME;
}

export function offersCodeMode(setting: CodeModeSetting, deferring: boolean, mcpToolCount: number): boolean {
  if (mcpToolCount === 0) return false;
  return setting === 'on' || (setting === 'auto' && deferring);
}

/** One step tool as a script function: `tools.<namespace>.<fn>(args)`. */
export interface ScriptBinding {
  namespace: string;
  fn: string;
  /** The model-facing tool name that the call is checked and dispatched as. */
  name: string;
}

export interface ScriptBindingSource {
  name: string;
  server: string;
  tool: string;
}

function identifier(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned || '_';
}

/** Stable, collision-free script names for a step's MCP tools. */
export function buildScriptBindings(sources: readonly ScriptBindingSource[]): ScriptBinding[] {
  const sorted = [...sources].sort((a, b) =>
    a.server === b.server ? (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0) : a.server < b.server ? -1 : 1);
  const taken = new Set<string>();
  return sorted.map((source) => {
    const namespace = identifier(source.server);
    const base = identifier(source.tool);
    let fn = base;
    for (let suffix = 2; taken.has(`${namespace}.${fn}`); suffix++) fn = `${base}_${suffix}`;
    taken.add(`${namespace}.${fn}`);
    return { namespace, fn, name: source.name };
  });
}

export function scriptPathOf(binding: ScriptBinding): string {
  return `tools.${binding.namespace}.${binding.fn}`;
}

const LISTED_FUNCTIONS = 40;

export interface RunToolScriptOptions {
  /** Seconds a program may run, shown to the model. */
  timeoutSeconds: number;
  /** The step defers descriptions, so `search_tools` explains each tool's inputs. */
  deferring: boolean;
}

export function buildRunToolScriptTool(bindings: readonly ScriptBinding[], options: RunToolScriptOptions): ToolDefinition {
  const listed = bindings.slice(0, LISTED_FUNCTIONS).map((binding) => `- ${scriptPathOf(binding)}`);
  const more = bindings.length - listed.length;
  const inputsHint = options.deferring
    ? `Use \`${SEARCH_TOOLS_TOOL_NAME}\` to read a tool's inputs first.`
    : 'Each function takes the same arguments as the tool.';
  return {
    name: RUN_TOOL_SCRIPT_TOOL_NAME,
    description:
      'Run a short JavaScript program that calls this step\'s tools as functions. Use it to chain several tool ' +
      'calls, loop over many items, or filter a large result before you read it. Tool results stay inside the ' +
      'program: only the value you `return` and what you `console.log` come back to you.\n\n' +
      'Call a tool with `await tools.<server>.<tool>(args)` or `await callTool("<tool name>", args)`. A tool ' +
      'returns its structured result, or its text (parsed when the text is JSON). A failed call throws an Error. ' +
      'Every call is checked and approved like a direct call. The program has no network, file or timer access ' +
      `and stops after ${options.timeoutSeconds} seconds. ${inputsHint}\n\n` +
      `Functions:\n${listed.join('\n')}${more > 0 ? `\n- … and ${more} more` : ''}`,
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'The body of an async JavaScript function. Use await, and return a value that can be turned into JSON. ' +
            'Example: const issues = await tools.github.list_issues({ state: "open" }); ' +
            'return issues.filter(i => i.labels.length === 0).map(i => i.number);',
        },
      },
      required: ['code'],
    },
  };
}
