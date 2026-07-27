/**
 * Graceful landing at the agentic-turn cap (issue #253).
 *
 * When a Process node exhausts its per-node turn budget we do NOT abort or
 * silently end the run. Instead we "land the plane": strip all tools and force
 * one final, text-only turn that summarizes what was accomplished and what
 * remains, so downstream nodes / captureVariable / lastOutput chaining receive
 * something useful at the exact moment a status report matters most.
 *
 * The two code sites that need to force this final turn (the request/response
 * loop driven by runFlow, and any self-orchestrating adapter) share the SAME
 * instruction text via the constants below, so the model's landing behaviour is
 * identical regardless of provider.
 */

/**
 * Injected as the forced final user instruction on the summary turn. It must
 * override any earlier instruction to keep working, and explicitly forbid tool
 * calls (belt-and-suspenders — the summary turn is also sent with an empty tool
 * list, which already forces text-only output on every request/response adapter).
 */
export const GRACEFUL_CAP_SUMMARY_INSTRUCTION =
  'SYSTEM NOTICE — TURN BUDGET REACHED. You have used up the maximum number of ' +
  'agentic turns allotted for this task, so no further tool calls are possible. ' +
  'This overrides every previous instruction to keep working or to call a tool. ' +
  'Produce a single, final, text-only message that:\n' +
  '1. Summarizes what was accomplished so far.\n' +
  '2. Lists the tasks that remain unfinished.\n' +
  '3. Recommends concrete next steps for whoever continues this work.\n' +
  'Do NOT attempt to call any tool. Answer with plain text only.';

/**
 * Synthetic result written back for each still-pending tool call on the turn
 * the cap fires, so the transcript stays well-formed (every `tool_calls` entry
 * must be answered before the next user turn or providers 400). The tools are
 * intentionally NOT executed — the budget is spent.
 */
export const GRACEFUL_CAP_TOOL_RESULT =
  'Turn budget reached: this tool was not executed. No further tool calls are ' +
  'possible. Provide a final text-only summary instead.';
