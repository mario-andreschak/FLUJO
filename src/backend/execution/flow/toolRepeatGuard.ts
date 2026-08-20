import type { ToolCallInfo } from './types';
import { createHash } from 'node:crypto';

export const TOOL_REPEAT_TEMPERATURE = 1 as const;

export interface ToolRepeatGuardEntry {
  toolName: string;
  argsFingerprint: string;
  resultFingerprint: string;
  exitCode: 0 | 1;
  count: number;
  temperatureRaised: boolean;
  hintSent: boolean;
}

export interface ToolRepeatGuardState {
  logicalRunId: string;
  entries: ToolRepeatGuardEntry[];
}

export interface ToolRepeatGuardDecision {
  raiseTemperature: boolean;
  hints: string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalToolArguments(args: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(args));
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function classifyToolExitCode(content: string, explicitError = false): 0 | 1 {
  if (explicitError || /^Error:/i.test(content)) return 1;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && (parsed as { isError?: unknown }).isError === true
    ) {
      return 1;
    }
  } catch {
    // Plain-text successful results are common.
  }
  return 0;
}

export function applyToolRepeatGuard(
  state: ToolRepeatGuardState,
  calls: readonly ToolCallInfo[] | undefined,
): ToolRepeatGuardDecision {
  let raiseTemperature = false;
  const hints: string[] = [];
  if (!calls?.length) return { raiseTemperature, hints };

  for (const call of calls) {
    const exitCode = call.exitCode ?? classifyToolExitCode(call.result);
    const canonicalArgs = canonicalToolArguments(call.args);
    const argsFingerprint = fingerprint(canonicalArgs);
    const resultFingerprint = fingerprint(call.result);
    let entry = state.entries.find(candidate =>
      candidate.toolName === call.name
      && candidate.argsFingerprint === argsFingerprint
      && candidate.resultFingerprint === resultFingerprint
      && candidate.exitCode === exitCode,
    );
    if (!entry) {
      entry = {
        toolName: call.name,
        argsFingerprint,
        resultFingerprint,
        exitCode,
        count: 0,
        temperatureRaised: false,
        hintSent: false,
      };
      state.entries.push(entry);
    }

    entry.count += 1;
    const temperatureThreshold = exitCode === 0 ? 3 : 2;
    const hintThreshold = exitCode === 0 ? 5 : 3;
    if (entry.count >= temperatureThreshold && !entry.temperatureRaised) {
      entry.temperatureRaised = true;
      raiseTemperature = true;
    }
    if (entry.count >= hintThreshold && !entry.hintSent) {
      entry.hintSent = true;
      hints.push(
        `System-Hint: You repeated the same tool call ${hintThreshold} times with the same result. Try something else.`,
      );
    }
  }

  return { raiseTemperature, hints };
}
